import { errors, jwtVerify, SignJWT } from "jose";
import { ApiError } from "./http";
import { sha256Hex } from "./identity";

/// 後台自己簽發的權杖。
/// - 存取權杖：HS256 JWT,15 分鐘，`sub` 是會員 ID。每次使用都會再確認會員還在(刪除後立即失效)。
/// - 更新權杖：32 bytes 隨機值，資料庫(sessions)只存雜湊;90 天、每次使用就輪替(舊的立即失效)。
export const ACCESS_TOKEN_LIFETIME_SECONDS = 15 * 60;
export const REFRESH_TOKEN_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
const ISSUER = "purrdr-backend";
const AUDIENCE = "purrdr-app";

export type Tokens = { accessToken: string; accessTokenExpiresAt: string; refreshToken: string };

function secretKey(env: Env): Uint8Array {
  return new TextEncoder().encode(env.ACCESS_TOKEN_SECRET);
}

async function signAccessToken(env: Env, memberId: string): Promise<{ accessToken: string; accessTokenExpiresAt: string }> {
  const expiresAt = Math.floor(Date.now() / 1000) + ACCESS_TOKEN_LIFETIME_SECONDS;
  const accessToken = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(memberId)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(secretKey(env));
  return { accessToken, accessTokenExpiresAt: new Date(expiresAt * 1000).toISOString() };
}

/// 簽發一組新的權杖給會員:新建一個工作階段(sessions)。
///
/// 目前登入 API 還不知道是哪支裝置(裝置 ID 由 purrdr.server#23 帶進來),所以每次登入先建一個只屬於這個工作階段的
/// 裝置列(devices);它不是推播裝置(沒有推播權杖與配對),不會出現在通知裝置清單。
export async function issueTokens(env: Env, memberId: string): Promise<Tokens> {
  const now = Date.now();
  const refreshToken = randomToken();
  const deviceId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO devices (id, member_id, platform, created_at, last_seen_at) VALUES (?, ?, 'ios', ?, ?)").bind(deviceId, memberId, now, now),
    env.DB.prepare(
      `INSERT INTO sessions (id, member_id, device_id, refresh_token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), memberId, deviceId, await sha256Hex(refreshToken), now + REFRESH_TOKEN_LIFETIME_MS, now),
  ]);
  return { ...(await signAccessToken(env, memberId)), refreshToken };
}

/// 用更新權杖換一組新的權杖;舊的更新權杖同時作廢(同一個 UPDATE,新舊雜湊在同一筆交易內換掉)。
/// 輪替寬限與外洩偵測由 purrdr.server#23 加上(previous_refresh_token_hash 先記著)。
export async function rotateRefreshToken(env: Env, refreshToken: string): Promise<{ memberId: string; tokens: Tokens }> {
  const now = Date.now();
  const newRefreshToken = randomToken();
  const row = await env.DB.prepare(
    `UPDATE sessions SET previous_refresh_token_hash = refresh_token_hash, refresh_token_hash = ?, rotated_at = ?, expires_at = ?
     WHERE refresh_token_hash = ? AND revoked_at IS NULL AND expires_at > ?
     RETURNING member_id`,
  )
    .bind(await sha256Hex(newRefreshToken), now, now + REFRESH_TOKEN_LIFETIME_MS, await sha256Hex(refreshToken), now)
    .first<{ member_id: string }>();
  if (!row) {
    throw new ApiError(401, "invalid_refresh_token", "Please sign in again.");
  }
  return { memberId: row.member_id, tokens: { ...(await signAccessToken(env, row.member_id)), refreshToken: newRefreshToken } };
}

/// 登出:撤銷這個更新權杖所屬的工作階段。不存在也算成功。
export async function revokeRefreshToken(env: Env, refreshToken: string): Promise<void> {
  await env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE refresh_token_hash = ? AND revoked_at IS NULL")
    .bind(Date.now(), await sha256Hex(refreshToken))
    .run();
}

/// 從 `Authorization: Bearer` 取出會員 ID,並確認會員仍存在。
export async function authenticate(env: Env, request: Request): Promise<string> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  if (!match?.[1]) {
    throw new ApiError(401, "invalid_access_token", "Sign in required.");
  }
  let memberId: string | undefined;
  try {
    const { payload } = await jwtVerify(match[1], secretKey(env), { issuer: ISSUER, audience: AUDIENCE, algorithms: ["HS256"] });
    memberId = payload.sub;
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
  return memberId;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
