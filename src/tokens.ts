import { errors, jwtVerify, SignJWT } from "jose";
import { ApiError } from "./http";
import { sha256Hex } from "./identity";

/// 後台自己簽發的權杖。
/// - 存取權杖：HS256 JWT,15 分鐘，`sub` 是會員 ID。每次使用都會再確認會員還在(刪除後立即失效)。
/// - 更新權杖：32 bytes 隨機值，資料庫(sessions)只存雜湊;90 天、每次使用就輪替(舊的有 60 秒寬限,見 rotateRefreshToken)。
export const ACCESS_TOKEN_LIFETIME_SECONDS = 15 * 60;
export const REFRESH_TOKEN_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
/// 輪替寬限:舊更新權杖在輪替後 60 秒內重送,回傳同一組新權杖。
export const ROTATION_GRACE_MS = 60 * 1000;
const ISSUER = "purrdr-backend";
const AUDIENCE = "purrdr-app";

export type Tokens = { accessToken: string; accessTokenExpiresAt: string; refreshToken: string };

function secretKey(env: Env): Uint8Array {
  return new TextEncoder().encode(env.ACCESS_TOKEN_SECRET);
}

export async function signAccessToken(
  env: Env,
  memberId: string,
  sessionId: string,
): Promise<{ accessToken: string; accessTokenExpiresAt: string }> {
  const expiresAt = Math.floor(Date.now() / 1000) + ACCESS_TOKEN_LIFETIME_SECONDS;
  // `sid` 是工作階段 ID:列出工作階段時標出「目前這個」,也讓撤銷後的存取權杖在這些 API 立即失效。
  const accessToken = await new SignJWT({ sid: sessionId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(memberId)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(secretKey(env));
  return { accessToken, accessTokenExpiresAt: new Date(expiresAt * 1000).toISOString() };
}

/// deviceId(app Keychain 的 UUID)的格式:1~64 字元的英數與 `.` `_` `:` `-`(涵蓋 UUID)。
/// 0009 遷移出來的 `token:<device token>` 超過 64 字元,不在這個範圍,也不是 app 會送的 id。
const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

/// 讀登入 body 選填的 `deviceId`;沒帶回 undefined(舊 app),格式不對 400。
/// 一律轉小寫(iOS 的 `UUID().uuidString` 是大寫),與推播配對(push-devices.ts)存的 devices.id 一致。
export function parseDeviceId(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || !DEVICE_ID_PATTERN.test(value)) {
    throw new ApiError(400, "invalid_request", "Field deviceId must be 1-64 characters of letters, digits, '.', '_', ':' or '-'.");
  }
  return value.toLowerCase();
}

export type DevicePlatform = "ios" | "android";

/// 讀登入 body 選填的 `platform`(ios|android),沒帶是 ios,不合法 400。
export function parsePlatform(value: unknown): DevicePlatform {
  if (value === undefined || value === null) {
    return "ios";
  }
  if (value !== "ios" && value !== "android") {
    throw new ApiError(400, "invalid_request", "Field platform must be ios or android.");
  }
  return value;
}

/// 簽發一組新的權杖給會員:新建一個工作階段(sessions)。
///
/// - 有 `deviceId`:以該 id upsert 裝置(devices),並撤銷這支裝置舊的未撤銷工作階段(每裝置一個);裝置換會員登入時
///   舊會員在這支裝置的工作階段也一併撤銷、裝置改歸新會員。
/// - 別的會員在這支裝置上還有未撤銷的工作階段時(deviceId 不是秘密、不證明持有)不動那列,這次登入另建一列裝置。
///   原會員已登出才換會員登入時沿用裝置列,並撤銷原會員在這支裝置的推播配對。
/// - 沒有 `deviceId`(舊 app):每次登入建一個只屬於這個工作階段的裝置列;它不是推播裝置,不會出現在通知裝置清單,
///   工作階段撤銷後(沒有推播權杖與配對)就刪除。
/// 撤銷舊的、upsert 裝置、新增工作階段在同一個 batch(D1 的 batch 是一筆交易)。
export async function issueTokens(env: Env, memberId: string, deviceId?: string, platform: DevicePlatform = "ios"): Promise<Tokens> {
  const now = Date.now();
  const refreshToken = randomToken();
  const sessionId = crypto.randomUUID();
  let device = deviceId ?? placeholderDeviceId();
  if (deviceId !== undefined && (await heldByAnotherMember(env, deviceId, memberId, now))) {
    // deviceId 不是秘密、也不證明持有:別的會員正在用這個 id 時不動它,這次登入另建一列裝置。
    device = placeholderDeviceId();
  }
  await env.DB.batch([
    // 裝置改歸新會員時,原會員在這支裝置的推播配對一併撤銷(否則新會員會收到原會員主機的通知)。
    env.DB.prepare(
      `INSERT OR REPLACE INTO revoked_push_pairings (key_hash, member_id, revoked_at)
       SELECT key_hash, member_id, ?1 FROM push_pairings WHERE device_id = ?2 AND member_id != ?3`,
    ).bind(now, device, memberId),
    env.DB.prepare("DELETE FROM push_pairings WHERE device_id = ? AND member_id != ?").bind(device, memberId),
    env.DB.prepare(
      `INSERT INTO devices (id, member_id, platform, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET member_id = excluded.member_id, last_seen_at = excluded.last_seen_at, revoked_at = NULL`,
    ).bind(device, memberId, platform, now, now),
    env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL").bind(now, device),
    env.DB.prepare(
      `INSERT INTO sessions (id, member_id, device_id, refresh_token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(sessionId, memberId, device, await sha256Hex(refreshToken), now + REFRESH_TOKEN_LIFETIME_MS, now),
  ]);
  return { ...(await signAccessToken(env, memberId, sessionId)), refreshToken };
}

/// 沒有可用 deviceId 時的佔位裝置 id:`anon:` 加隨機 UUID。前綴讓清理(`deleteIdleDevices`)只動佔位列,
/// 不碰 app 的 Keychain 裝置(那些的撤銷紀錄與工作階段要留著)。不合 UUID 格式,不會與推播裝置 id 衝突。
const PLACEHOLDER_PREFIX = "anon:";

function placeholderDeviceId(): string {
  return PLACEHOLDER_PREFIX + crypto.randomUUID();
}

/// 這個裝置列屬於別的會員、而且那個會員在這支裝置上還有未撤銷的工作階段。
/// 沒有這列、`member_id` 是 NULL、屬於同一會員、或原會員已登出(工作階段都撤銷了)都不算。
async function heldByAnotherMember(env: Env, deviceId: string, memberId: string, now: number): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 FROM devices d WHERE d.id = ?1 AND d.member_id IS NOT NULL AND d.member_id != ?2
       AND EXISTS (SELECT 1 FROM sessions s WHERE s.device_id = d.id AND s.revoked_at IS NULL AND s.expires_at > ?3)`,
  )
    .bind(deviceId, memberId, now)
    .first();
  return row !== null;
}

/// 工作階段撤銷後,清掉不再有用的佔位裝置列(`anon:` 開頭,沒帶 deviceId 登入或 deviceId 被別人佔用時建的):
/// 沒有推播權杖、沒有推播配對、也沒有未撤銷工作階段。會一併連鎖刪掉它的(已撤銷)工作階段列。
async function deleteIdleDevices(env: Env, deviceIds: string[]): Promise<void> {
  if (deviceIds.length === 0) {
    return;
  }
  const now = Date.now();
  await env.DB.batch(
    deviceIds.map((id) =>
      env.DB.prepare(
        `DELETE FROM devices WHERE id = ?1 AND id LIKE 'anon:%' AND push_token IS NULL
           AND NOT EXISTS (SELECT 1 FROM push_pairings WHERE device_id = ?1)
           AND NOT EXISTS (SELECT 1 FROM sessions WHERE device_id = ?1 AND revoked_at IS NULL AND expires_at > ?2)`,
      ).bind(id, now),
    ),
  );
}

/// 輪替時的新更新權杖:由「舊權杖的雜湊」與伺服器 secret 以 HMAC-SHA256 導出,不是隨機值。
///
/// 寬限內舊權杖重送要回傳**同一組**新權杖,但資料庫只存雜湊、不能存明文。確定性導出讓後台不必存任何可還原權杖的東西:
/// 重送時用同一個舊雜湊再導一次即得相同結果。只拿到資料庫(雜湊)或只拿到舊權杖都導不出來,要有 secret 才行。
/// 以 `ACCESS_TOKEN_SECRET` 加上獨立的標籤做網域分離,不新增 secret。
async function deriveRotatedToken(env: Env, previousHash: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", secretKey(env), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`purrdr-refresh-rotation-v1:${previousHash}`)));
  return base64Url(mac);
}

/// 用更新權杖換一組新的權杖。
///
/// - 正常輪替:單一 UPDATE 同時換上新雜湊、把舊雜湊記到 `previous_refresh_token_hash`、設 `grace_until`(60 秒);
///   發新與作廢是同一筆原子寫入。
/// - 寬限內重送舊權杖(換權杖的回應遺失):回傳同一組新權杖(見 `deriveRotatedToken`)。
/// - 寬限外重送舊權杖:視為外洩,撤銷整個工作階段(新權杖也失效),回 401。
export async function rotateRefreshToken(env: Env, refreshToken: string): Promise<{ memberId: string; tokens: Tokens }> {
  const now = Date.now();
  const presentedHash = await sha256Hex(refreshToken);
  const newRefreshToken = await deriveRotatedToken(env, presentedHash);
  const row = await env.DB.prepare(
    `UPDATE sessions SET previous_refresh_token_hash = refresh_token_hash, refresh_token_hash = ?, rotated_at = ?, grace_until = ?, expires_at = ?
     WHERE refresh_token_hash = ? AND revoked_at IS NULL AND expires_at > ?
     RETURNING id, member_id`,
  )
    .bind(await sha256Hex(newRefreshToken), now, now + ROTATION_GRACE_MS, now + REFRESH_TOKEN_LIFETIME_MS, presentedHash, now)
    .first<{ id: string; member_id: string }>();
  if (row) {
    return { memberId: row.member_id, tokens: { ...(await signAccessToken(env, row.member_id, row.id)), refreshToken: newRefreshToken } };
  }

  const reused = await env.DB.prepare(
    `SELECT id, member_id, refresh_token_hash, grace_until FROM sessions
     WHERE previous_refresh_token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
  )
    .bind(presentedHash, now)
    .first<{ id: string; member_id: string; refresh_token_hash: string; grace_until: number | null }>();
  if (reused) {
    if ((reused.grace_until ?? 0) >= now && (await sha256Hex(newRefreshToken)) === reused.refresh_token_hash) {
      return { memberId: reused.member_id, tokens: { ...(await signAccessToken(env, reused.member_id, reused.id)), refreshToken: newRefreshToken } };
    }
    const revoked = await env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL RETURNING device_id")
      .bind(now, reused.id)
      .all<{ device_id: string }>();
    await deleteIdleDevices(env, revoked.results.map((row) => row.device_id));
  }
  throw new ApiError(401, "invalid_refresh_token", "Please sign in again.");
}

/// 登出:撤銷這個更新權杖所屬的工作階段。不存在也算成功。
/// 寬限內的舊權杖也算(登出時回應遺失的情況)。
export async function revokeRefreshToken(env: Env, refreshToken: string): Promise<void> {
  const hash = await sha256Hex(refreshToken);
  const revoked = await env.DB.prepare(
    "UPDATE sessions SET revoked_at = ? WHERE (refresh_token_hash = ? OR previous_refresh_token_hash = ?) AND revoked_at IS NULL RETURNING device_id",
  )
    .bind(Date.now(), hash, hash)
    .all<{ device_id: string }>();
  await deleteIdleDevices(env, revoked.results.map((row) => row.device_id));
}

async function verifyAccessToken(env: Env, request: Request): Promise<{ memberId: string; sessionId: string | undefined }> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  if (!match?.[1]) {
    throw new ApiError(401, "invalid_access_token", "Sign in required.");
  }
  let memberId: string | undefined;
  let sessionId: string | undefined;
  try {
    const { payload } = await jwtVerify(match[1], secretKey(env), { issuer: ISSUER, audience: AUDIENCE, algorithms: ["HS256"] });
    memberId = payload.sub;
    sessionId = typeof payload.sid === "string" ? payload.sid : undefined;
  } catch (error) {
    if (!(error instanceof errors.JOSEError)) {
      throw error;
    }
  }
  if (!memberId) {
    throw new ApiError(401, "invalid_access_token", "Sign in required.");
  }
  const exists = await env.DB.prepare("SELECT 1 FROM members WHERE id = ?").bind(memberId).first();
  if (!exists) {
    throw new ApiError(401, "invalid_access_token", "Sign in required.");
  }
  return { memberId, sessionId };
}

/// 從 `Authorization: Bearer` 取出會員 ID,並確認會員仍存在。
export async function authenticate(env: Env, request: Request): Promise<string> {
  return (await verifyAccessToken(env, request)).memberId;
}

/// 同上,另外要求存取權杖帶工作階段 ID、而且那個工作階段未撤銷(工作階段 API 用:被撤銷的裝置立即失去管理權)。
export async function authenticateSession(env: Env, request: Request): Promise<{ memberId: string; sessionId: string }> {
  const { memberId, sessionId } = await verifyAccessToken(env, request);
  const live = sessionId
    ? await env.DB.prepare("SELECT 1 FROM sessions WHERE id = ? AND member_id = ? AND revoked_at IS NULL").bind(sessionId, memberId).first()
    : null;
  if (!sessionId || !live) {
    throw new ApiError(401, "invalid_access_token", "Sign in required.");
  }
  return { memberId, sessionId };
}

export type SessionView = {
  id: string;
  deviceId: string;
  deviceName: string | null;
  deviceModel: string | null;
  createdAt: string;
  lastActiveAt: string;
  expiresAt: string;
  current: boolean;
};

/// 列出會員未撤銷、未過期的工作階段(含裝置名稱與型號)。
export async function listSessions(env: Env, memberId: string, currentSessionId: string): Promise<SessionView[]> {
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.device_id, d.name, d.model, s.created_at, COALESCE(s.rotated_at, s.created_at) AS last_active_at, s.expires_at
     FROM sessions s JOIN devices d ON d.id = s.device_id
     WHERE s.member_id = ? AND s.revoked_at IS NULL AND s.expires_at > ?
     ORDER BY s.created_at DESC, s.id`,
  )
    .bind(memberId, Date.now())
    .all<{ id: string; device_id: string; name: string | null; model: string | null; created_at: number; last_active_at: number; expires_at: number }>();
  return results.map((row) => ({
    id: row.id,
    deviceId: row.device_id,
    deviceName: row.name,
    deviceModel: row.model,
    createdAt: new Date(row.created_at).toISOString(),
    lastActiveAt: new Date(row.last_active_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    current: row.id === currentSessionId,
  }));
}

/// 撤銷會員自己的另一個工作階段。別人的或不存在 → 404;目前這個 → 409(登出請用 /v1/sessions/revoke);已撤銷 → 成功(冪等)。
export async function revokeOtherSession(env: Env, memberId: string, currentSessionId: string, sessionId: string): Promise<void> {
  const target = await env.DB.prepare("SELECT 1 FROM sessions WHERE id = ? AND member_id = ?").bind(sessionId, memberId).first();
  if (!target) {
    throw new ApiError(404, "session_not_found", "Session not found.");
  }
  if (sessionId === currentSessionId) {
    throw new ApiError(409, "cannot_revoke_current_session", "Use sign out to end the current session.");
  }
  const revoked = await env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND member_id = ? AND revoked_at IS NULL RETURNING device_id")
    .bind(Date.now(), sessionId, memberId)
    .all<{ device_id: string }>();
  await deleteIdleDevices(env, revoked.results.map((row) => row.device_id));
}

function randomToken(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
