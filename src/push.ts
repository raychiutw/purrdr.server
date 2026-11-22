import { importPKCS8, SignJWT } from "jose";
import { ApiError, readJson, requireString } from "./http";
import { legacyDeviceId, readDeviceIdentity } from "./push-devices";
import { hasActiveSubscription, requireActiveSubscription } from "./subscriptions";

/// 推播(#29、ADR-0004、ADR-0007)。
///
/// - app(會員)註冊推播配對：送配對密鑰的雜湊、APNs device token、環境與要收的種類;需要有效訂閱。
/// - 主機外掛在 Agent「需要你」或「完成」、主機服務在 Agent「可能卡住」或「仍在等你」時帶密鑰呼叫 `POST /v1/push`:後台算雜湊找到配對、每組密鑰限速、
///   確認會員仍有有效訂閱與種類偏好，再自己組 APNs payload 轉送。外掛只能送 workspace 名稱、狀態與 pane id,
///   多帶任何欄位(例如對話內容)一律拒絕，所以對話內容不會經過後台或 APNs。
/// - 主機服務以同一組密鑰送事件(有新版、已更新、已退回),只能帶事件與版本;同一事件 24 小時只送一次。

const HEX_64 = /^[0-9a-f]{64}$/;
const DEVICE_TOKEN = /^[0-9a-f]{64,200}$/;
const PANE_ID = /^[A-Za-z0-9:_.-]{1,64}$/;
const ENVIRONMENTS = new Set(["production", "sandbox"]);
/// 外掛可以送的欄位;其他一律拒絕。
const PUSH_FIELDS = new Set(["key", "workspace", "status", "pane"]);
/// 主機服務事件可以送的欄位;與上面的狀態形狀互斥。
const HOST_SERVICE_PUSH_FIELDS = new Set(["key", "event", "version"]);
/// 測試通知(#19):配對密鑰、事件名與選填的主機名稱，不收 version、pane 等任何其他欄位。
const TEST_PUSH_FIELDS = new Set(["key", "event", "host_name"]);
const MAX_HOST_NAME_LENGTH = 64;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const MAX_VERSION_LENGTH = 64;
/// 配對可以選擇要收的推播種類(`host_service` = 主機服務事件;`stuck`、`reminder` 見 purrdr.server#15)。
const PAIRING_KINDS = ["blocked", "done", "stuck", "reminder", "host_service"] as const;
type PairingKind = (typeof PAIRING_KINDS)[number];
/// 沒帶 `kinds` 的新配對只收「需要你」,舊版 app 行為不變。
const DEFAULT_PAIRING_KINDS: readonly PairingKind[] = ["blocked"];
const MAX_WORKSPACE_LENGTH = 100;
const MAX_PUSH_BODY_BYTES = 2048;

/// 每組密鑰每分鐘最多幾則(行為規格 §9.5 的中繼是每 token 每分鐘 20 則;「需要你」不需要那麼多)。
export const PUSH_RATE_LIMIT = 10;
const PUSH_RATE_WINDOW_MS = 60_000;
/// 主機服務事件同一組密鑰＋event＋version 多久內只送一次。
const HOST_SERVICE_DEDUP_MS = 24 * 60 * 60_000;

const APNS_ORIGINS = { production: "https://api.push.apple.com", sandbox: "https://api.sandbox.push.apple.com" } as const;
/// APNs 表示「這個 token 不能再用」的回應：刪掉配對，讓外掛與 app 知道要重新配對。
const DEAD_TOKEN_REASONS = new Set(["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"]);

type Pairing = { member_id: string; device_token: string; environment: keyof typeof APNS_ORIGINS; kinds: string };

function invalid(message: string): ApiError {
  return new ApiError(400, "invalid_request", message);
}

/// 配對密鑰(64 位小寫 hex = 32 bytes)的雜湊：那 32 bytes 的 SHA-256,小寫 hex。
export async function pairingKeyHash(key: string): Promise<string> {
  const bytes = new Uint8Array(key.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = parseInt(key.slice(index * 2, index * 2 + 2), 16);
  }
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// MARK: - 推播配對(app)

/// POST /v1/members/me/push-pairings:註冊或更新(APNs token 輪替)一組推播配對。
export async function registerPairing(env: Env, memberId: string, request: Request): Promise<void> {
  const body = await readJson(request);
  const keyHash = requireString(body, "keyHash");
  const platform = requireString(body, "platform");
  const deviceToken = requireString(body, "deviceToken").toLowerCase();
  const environment = requireString(body, "environment");
  if (!HEX_64.test(keyHash)) {
    throw invalid("keyHash must be 64 lowercase hex characters.");
  }
  if (platform !== "apns") {
    throw invalid("Unsupported platform.");
  }
  if (!DEVICE_TOKEN.test(deviceToken)) {
    throw invalid("deviceToken must be hex.");
  }
  if (!ENVIRONMENTS.has(environment)) {
    throw invalid("environment must be production or sandbox.");
  }
  const device = readDeviceIdentity(body);
  const kinds = readKinds(body);
  await requireActiveSubscription(env, memberId);

  const existing = await env.DB.prepare("SELECT member_id, device_id FROM push_pairings WHERE key_hash = ?")
    .bind(keyHash)
    .first<{ member_id: string; device_id: string }>();
  if (existing !== null && existing.member_id !== memberId) {
    throw new ApiError(409, "pairing_in_use", "This pairing key belongs to another member.");
  }
  // 舊版 app 不帶 deviceId:沿用這組配對原本的裝置;新配對以 device token 的雜湊當裝置 id。
  const deviceId = device.deviceId ?? existing?.device_id ?? (await legacyDeviceId(deviceToken));

  const now = Date.now();
  const [, saved] = await env.DB.batch([
    // 同一支裝置的所有配對共用一組推播權杖,放在 devices。已有名稱就保留(使用者改過的名稱不被預設名稱蓋掉)。
    env.DB.prepare(
      `INSERT INTO devices (id, member_id, platform, name, model, push_token, push_environment, created_at, last_seen_at)
       VALUES (?1, ?2, 'ios', ?3, ?4, ?5, ?6, ?7, ?7)
       ON CONFLICT (id) DO UPDATE SET
         member_id = excluded.member_id, push_token = excluded.push_token, push_environment = excluded.push_environment,
         name = COALESCE(devices.name, excluded.name), model = COALESCE(excluded.model, devices.model), last_seen_at = excluded.last_seen_at,
         revoked_at = NULL`,
    ).bind(deviceId, memberId, device.name, device.model, deviceToken, environment, now),
    env.DB.prepare(
      `INSERT INTO push_pairings (id, member_id, device_id, key_hash, kinds, created_at, updated_at)
       VALUES (?, ?, ?, ?, COALESCE(?, ?), ?, ?)
       ON CONFLICT (key_hash) DO UPDATE SET
         device_id = excluded.device_id, kinds = COALESCE(?, push_pairings.kinds), updated_at = excluded.updated_at
       WHERE push_pairings.member_id = excluded.member_id`,
    ).bind(crypto.randomUUID(), memberId, deviceId, keyHash, kinds, JSON.stringify(DEFAULT_PAIRING_KINDS), now, now, kinds),
    env.DB.prepare("DELETE FROM revoked_push_pairings WHERE key_hash = ?").bind(keyHash),
  ]);
  if (saved?.meta.changes === 0) {
    throw new ApiError(409, "pairing_in_use", "This pairing key belongs to another member.");
  }
}

/// 選用的 `kinds`:要收的推播種類，存成 JSON 字串;沒帶回 null(新配對預設只收 blocked,既有配對保留原偏好)。
function readKinds(body: Record<string, unknown>): string | null {
  const kinds = body.kinds;
  if (kinds === undefined) {
    return null;
  }
  if (!Array.isArray(kinds) || !kinds.every(isPairingKind)) {
    throw invalid("kinds must be an array of blocked, done, stuck, reminder or host_service.");
  }
  return JSON.stringify([...new Set(kinds)]);
}

/// DELETE /v1/members/me/push-pairings/{keyHash}:撤銷(只刪自己的;不存在也算成功)。不需要有效訂閱。
export async function revokePairing(env: Env, memberId: string, keyHash: string): Promise<void> {
  await env.DB.prepare("DELETE FROM push_pairings WHERE key_hash = ? AND member_id = ?").bind(keyHash, memberId).run();
}

// MARK: - 送推播(主機外掛)

type PushStatus = "blocked" | "done" | "stuck" | "reminder";
type HostServiceEvent = "host_service_update_available" | "host_service_updated" | "host_service_update_rolled_back";
type StatusPush = { kind: "status"; key: string; workspace: string; status: PushStatus; pane: string | null };
type HostServicePush = { kind: "host_service"; key: string; event: HostServiceEvent; version: string | null };
/// 使用者在 app 帳號頁按「傳送測試通知」:不是配對的推播種類，不受偏好、去重影響。
type TestPush = { kind: "test"; key: string; hostName: string | null };
type PushRequest = StatusPush | HostServicePush | TestPush;

async function readPushRequest(request: Request): Promise<PushRequest> {
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_PUSH_BODY_BYTES) {
    throw new ApiError(413, "invalid_request", "Request body is too large.");
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw invalid("Request body must be JSON.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw invalid("Request body must be a JSON object.");
  }
  const fields = body as Record<string, unknown>;
  if (fields.event === undefined) {
    return readStatusPush(fields);
  }
  return fields.event === "test" ? readTestPush(fields) : readHostServicePush(fields);
}

/// 兩種推播共用：只接受白名單欄位，並驗證配對密鑰。
function readPushKey(fields: Record<string, unknown>, allowedFields: Set<string>): string {
  for (const field of Object.keys(fields)) {
    if (!allowedFields.has(field)) {
      throw invalid(`Unknown field: ${field}.`);
    }
  }
  const key = requireString(fields, "key");
  if (!HEX_64.test(key)) {
    throw invalid("key must be 64 lowercase hex characters.");
  }
  return key;
}

function readStatusPush(fields: Record<string, unknown>): StatusPush {
  const key = readPushKey(fields, PUSH_FIELDS);
  const workspace = requireString(fields, "workspace");
  const status = requireString(fields, "status");
  const pane = fields.pane === undefined ? null : fields.pane;
  if ([...workspace].length > MAX_WORKSPACE_LENGTH) {
    throw invalid("workspace is too long.");
  }
  if (!isPushStatus(status)) {
    throw invalid("Unsupported status.");
  }
  if (pane !== null && (typeof pane !== "string" || !PANE_ID.test(pane))) {
    throw invalid("pane must be a herdr pane id.");
  }
  return { kind: "status", key, workspace, status, pane };
}

function readTestPush(fields: Record<string, unknown>): TestPush {
  const key = readPushKey(fields, TEST_PUSH_FIELDS);
  return { kind: "test", key, hostName: readHostName(fields.host_name) };
}

/// 選填的主機名稱，只用在測試通知的標題:控制字元(含換行、跳格、Unicode 行／段分隔符)換成空白後修掉頭尾，
/// 剩下空的當成沒帶;最長 64 個字元(以 code point 計)。不是字串或太長回 400。
function readHostName(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw invalid("host_name must be a string.");
  }
  const cleaned = value.replace(/[\p{Cc}\u2028\u2029]+/gu, " ").trim();
  if ([...cleaned].length > MAX_HOST_NAME_LENGTH) {
    throw invalid("host_name is too long.");
  }
  return cleaned === "" ? null : cleaned;
}

function readHostServicePush(fields: Record<string, unknown>): HostServicePush {
  const key = readPushKey(fields, HOST_SERVICE_PUSH_FIELDS);
  const event = requireString(fields, "event");
  const version = fields.version === undefined ? null : fields.version;
  if (!isHostServiceEvent(event)) {
    throw invalid("Unsupported event.");
  }
  if (version !== null && (typeof version !== "string" || version.length > MAX_VERSION_LENGTH || !SEMVER.test(version))) {
    throw invalid("version must be a semantic version.");
  }
  if (HOST_SERVICE_ALERTS[event].withVersion && version === null) {
    throw invalid("version is required for this event.");
  }
  return { kind: "host_service", key, event, version };
}

function isPairingKind(value: unknown): value is PairingKind {
  return typeof value === "string" && (PAIRING_KINDS as readonly string[]).includes(value);
}

/// D1 存的是 JSON 字串;只留認得的種類，舊資料或手改的值不會讓推播出錯。
function acceptedKinds(pairing: Pairing): PairingKind[] {
  const stored: unknown = JSON.parse(pairing.kinds);
  return Array.isArray(stored) ? stored.filter(isPairingKind) : [...DEFAULT_PAIRING_KINDS];
}

function isPushStatus(value: string): value is PushStatus {
  return Object.hasOwn(STATUS_ALERTS, value);
}

function isHostServiceEvent(value: string): value is HostServiceEvent {
  return Object.hasOwn(HOST_SERVICE_ALERTS, value);
}

async function findPairing(env: Env, keyHash: string): Promise<Pairing | null> {
  return env.DB.prepare(
    `SELECT p.member_id, d.push_token AS device_token, d.push_environment AS environment, p.kinds
     FROM push_pairings p JOIN devices d ON d.id = p.device_id WHERE p.key_hash = ?`,
  )
    .bind(keyHash)
    .first<Pairing>();
}

/// 計入速率限制，回傳是否超過(固定一分鐘的視窗，一個 UPDATE 完成，避免同時的請求互相蓋掉計數)。
async function exceedsRateLimit(env: Env, keyHash: string, now: number): Promise<boolean> {
  const counted = await env.DB.prepare(
    `UPDATE push_pairings SET
       rate_count = CASE WHEN ? - rate_window_started_at >= ? THEN 1 ELSE rate_count + 1 END,
       rate_window_started_at = CASE WHEN ? - rate_window_started_at >= ? THEN ? ELSE rate_window_started_at END
     WHERE key_hash = ?
     RETURNING rate_count`,
  )
    .bind(now, PUSH_RATE_WINDOW_MS, now, PUSH_RATE_WINDOW_MS, now, keyHash)
    .first<{ rate_count: number }>();
  return (counted?.rate_count ?? 0) > PUSH_RATE_LIMIT;
}

/// POST /v1/push:Agent 狀態(需要你、完成、可能卡住、仍在等你)、主機服務事件或測試通知(#19)。
/// 回傳是否真的轉給 APNs(種類不在配對偏好內、或事件 24 小時內送過時不轉)。
export async function sendPush(env: Env, request: Request): Promise<boolean> {
  const push = await readPushRequest(request);
  const keyHash = await pairingKeyHash(push.key);
  const now = Date.now();
  const pairing = await findPairing(env, keyHash);
  if (pairing === null) {
    // 只回一次 410:外掛收到後會清掉本機配對，之後同一組密鑰當成不認得。
    const revoked = await env.DB.prepare("DELETE FROM revoked_push_pairings WHERE key_hash = ? RETURNING key_hash").bind(keyHash).first();
    if (revoked !== null) {
      throw pairingRevoked();
    }
    throw new ApiError(404, "pairing_not_found", "This pairing isn't registered. Turn notifications on again in Purrdr.");
  }
  if (!(await hasActiveSubscription(env, pairing.member_id))) {
    throw new ApiError(403, "subscription_required", "This needs an active Purrdr Plus subscription.");
  }
  // 不是錯誤：主機端不需要知道使用者的偏好。
  // 測試通知是使用者剛按下去的，不看種類偏好。
  if (push.kind !== "test") {
    const kind: PairingKind = push.kind === "host_service" ? "host_service" : push.status;
    if (!acceptedKinds(pairing).includes(kind)) {
      return false;
    }
  }
  const hostEvent = push.kind === "host_service" ? push : null;
  if (hostEvent !== null && !(await claimHostServiceEvent(env, keyHash, pairing.member_id, hostEvent, now))) {
    return false;
  }
  // 只有真的要送 APNs 的才計入，偏好或去重擋下的不會擠掉「需要你」。
  if (await exceedsRateLimit(env, keyHash, now)) {
    if (hostEvent !== null) {
      await releaseHostServiceEvent(env, keyHash, hostEvent);
    }
    throw new ApiError(429, "rate_limited", "Too many notifications. Try again in a minute.");
  }

  const response = await deliverToApns(env, pairing, apnsPayload(push, keyHash));
  if (response.ok) {
    return true;
  }
  // 沒送到就不算送過，主機服務重送時可以再試。
  if (hostEvent !== null) {
    await releaseHostServiceEvent(env, keyHash, hostEvent);
  }
  const reason = await apnsReason(response);
  if (response.status === 410 || DEAD_TOKEN_REASONS.has(reason)) {
    await env.DB.prepare("DELETE FROM push_pairings WHERE key_hash = ?").bind(keyHash).run();
    throw pairingRevoked();
  }
  throw new ApiError(502, "apns_failed", `Apple Push Notification service refused the notification (${reason || response.status}).`);
}

/// 登記這次的主機服務事件;24 小時內送過同一組 event＋version 時回 false。
/// 一個 UPSERT 完成，同時到的重複請求只有一個拿得到。
async function claimHostServiceEvent(env: Env, keyHash: string, memberId: string, push: HostServicePush, now: number): Promise<boolean> {
  const claimed = await env.DB.prepare(
    `INSERT INTO host_service_push_events (key_hash, member_id, event, version, sent_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (key_hash, event, version) DO UPDATE SET sent_at = excluded.sent_at
     WHERE host_service_push_events.sent_at <= ?
     RETURNING key_hash`,
  )
    .bind(keyHash, memberId, push.event, dedupVersion(push), now, now - HOST_SERVICE_DEDUP_MS)
    .first();
  return claimed !== null;
}

async function releaseHostServiceEvent(env: Env, keyHash: string, push: HostServicePush): Promise<void> {
  await env.DB.prepare("DELETE FROM host_service_push_events WHERE key_hash = ? AND event = ? AND version = ?")
    .bind(keyHash, push.event, dedupVersion(push))
    .run();
}

/// 去重主鍵的 version:欄位 NOT NULL,沒帶版本存空字串。
function dedupVersion(push: HostServicePush): string {
  return push.version ?? "";
}

function pairingRevoked(): ApiError {
  return new ApiError(410, "pairing_revoked", "This device no longer accepts notifications. Turn notifications on again in Purrdr.");
}

/// 各狀態的固定內文(app 的字串表以 `loc-key` 翻譯)、通知類別與中斷等級。
/// 「需要你」「仍在等你」用 Time Sensitive;「完成」「可能卡住」用 active,專注模式下不打斷。
const STATUS_ALERTS: Record<PushStatus, { locKey: string; category: string; interruptionLevel: string }> = {
  blocked: { locKey: "An agent needs you.", category: "AGENT_BLOCKED", interruptionLevel: "time-sensitive" },
  done: { locKey: "An agent finished.", category: "AGENT_DONE", interruptionLevel: "active" },
  stuck: { locKey: "An agent may be stuck.", category: "AGENT_STUCK", interruptionLevel: "active" },
  reminder: { locKey: "An agent is still waiting for you.", category: "AGENT_REMINDER", interruptionLevel: "time-sensitive" },
};

/// APNs payload 由後台組：標題是 workspace 名稱，內文依狀態固定。
/// 根層的 `pairing`(配對密鑰雜湊)與 `pane` 給 app 點通知時找主機與 Agent。
export function apnsPayload(push: PushRequest, keyHash: string): Record<string, unknown> {
  if (push.kind === "host_service") {
    return hostServicePayload(push, keyHash);
  }
  if (push.kind === "test") {
    return testPayload(push, keyHash);
  }
  const alert = STATUS_ALERTS[push.status];
  return {
    aps: {
      alert: { title: push.workspace, "loc-key": alert.locKey },
      sound: "default",
      "interruption-level": alert.interruptionLevel,
      // app 為各類別設了隱藏預覽時的通用文字(HIG:hiddenPreviewsBodyPlaceholder)。
      category: alert.category,
    },
    pairing: keyHash,
    ...(push.pane === null ? {} : { pane: push.pane }),
    status: push.status,
  };
}

/// 測試通知:像真正的「需要你」(同樣 active、出聲),但標題與內文都說明是測試;文字由 app 的字串表以 `loc-key` 翻譯。
/// 有主機名稱時標題帶入(`title-loc-args`),沒有就用「Purrdr」。不帶 category、pane、version;點擊只開 app。
function testPayload(push: TestPush, keyHash: string): Record<string, unknown> {
  const title =
    push.hostName === null
      ? { "title-loc-key": "Test: Purrdr needs you" }
      : { "title-loc-key": "Test: %@ needs you", "title-loc-args": [push.hostName] };
  return {
    aps: {
      alert: { ...title, "loc-key": "This is a test. When an agent needs your reply or finishes, you'll get a notice like this." },
      sound: "default",
      "interruption-level": "active",
    },
    pairing: keyHash,
    event: "test",
  };
}

/// 各主機服務事件的內文(app 的字串表以 `loc-key` 翻譯);「已更新」以 `loc-args` 帶入版本。
const HOST_SERVICE_ALERTS: Record<HostServiceEvent, { locKey: string; withVersion: boolean }> = {
  host_service_update_available: { locKey: "A host service update is available.", withVersion: false },
  host_service_updated: { locKey: "Host service updated to %@.", withVersion: true },
  host_service_update_rolled_back: { locKey: "Host service update failed and was rolled back.", withVersion: false },
};

/// 主機服務事件：標題固定「Host service」(不帶主機名稱或對話),passive 不出聲打斷。
function hostServicePayload(push: HostServicePush, keyHash: string): Record<string, unknown> {
  const alert = HOST_SERVICE_ALERTS[push.event];
  return {
    aps: {
      alert: { "title-loc-key": "Host service", "loc-key": alert.locKey, ...(alert.withVersion ? { "loc-args": [push.version] } : {}) },
      "interruption-level": "passive",
      category: "HOST_SERVICE_EVENT",
    },
    pairing: keyHash,
    event: push.event,
    ...(push.version === null ? {} : { version: push.version }),
  };
}

async function apnsReason(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { reason?: unknown };
    return typeof body.reason === "string" ? body.reason : "";
  } catch {
    return "";
  }
}

async function deliverToApns(env: Env, pairing: Pairing, payload: Record<string, unknown>): Promise<Response> {
  try {
    return await fetch(`${APNS_ORIGINS[pairing.environment]}/3/device/${pairing.device_token}`, {
      method: "POST",
      headers: {
        authorization: `bearer ${await providerToken(env)}`,
        "apns-topic": env.APPLE_CLIENT_ID,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-expiration": String(Math.floor(Date.now() / 1000) + 3600),
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new ApiError(502, "apns_failed", "Couldn't reach Apple Push Notification service.");
  }
}

/// APNs provider token(ES256 JWT):Apple 要求 20～60 分鐘內重用同一個，太常換會被拒(TooManyProviderTokenUpdates)。
let cachedProviderToken: { keyId: string; token: string; issuedAt: number } | undefined;
const PROVIDER_TOKEN_LIFETIME_MS = 50 * 60_000;

async function providerToken(env: Env): Promise<string> {
  const now = Date.now();
  if (cachedProviderToken && cachedProviderToken.keyId === env.APNS_KEY_ID && now - cachedProviderToken.issuedAt < PROVIDER_TOKEN_LIFETIME_MS) {
    return cachedProviderToken.token;
  }
  const key = await importPKCS8(env.APNS_PRIVATE_KEY, "ES256");
  const token = await new SignJWT({}).setProtectedHeader({ alg: "ES256", kid: env.APNS_KEY_ID }).setIssuer(env.APPLE_TEAM_ID).setIssuedAt().sign(key);
  cachedProviderToken = { keyId: env.APNS_KEY_ID, token, issuedAt: now };
  return token;
}
