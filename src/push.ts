import { importPKCS8, SignJWT } from "jose";
import { ApiError, readJson, requireString } from "./http";
import { hasActiveSubscription, requireActiveSubscription } from "./subscriptions";

/// 推播(#29、ADR-0004、ADR-0007)。
///
/// - app(會員)註冊推播配對：送配對密鑰的雜湊、APNs device token 與環境;需要有效訂閱。
/// - 主機外掛在 Agent「需要你」時帶密鑰呼叫 `POST /v1/push`:後台算雜湊找到配對、每組密鑰限速、
///   確認會員仍有有效訂閱，再自己組 APNs payload 轉送。外掛只能送 workspace 名稱、狀態與 pane id,
///   多帶任何欄位(例如對話內容)一律拒絕，所以對話內容不會經過後台或 APNs。

const HEX_64 = /^[0-9a-f]{64}$/;
const DEVICE_TOKEN = /^[0-9a-f]{64,200}$/;
const PANE_ID = /^[A-Za-z0-9:_.-]{1,64}$/;
const ENVIRONMENTS = new Set(["production", "sandbox"]);
/// 外掛可以送的欄位;其他一律拒絕。
const PUSH_FIELDS = new Set(["key", "workspace", "status", "pane"]);
const PUSH_STATUSES = new Set(["blocked"]);
const MAX_WORKSPACE_LENGTH = 100;
const MAX_PUSH_BODY_BYTES = 2048;

/// 每組密鑰每分鐘最多幾則(行為規格 §9.5 的中繼是每 token 每分鐘 20 則;「需要你」不需要那麼多)。
export const PUSH_RATE_LIMIT = 10;
const PUSH_RATE_WINDOW_MS = 60_000;

const APNS_ORIGINS = { production: "https://api.push.apple.com", sandbox: "https://api.sandbox.push.apple.com" } as const;
/// APNs 表示「這個 token 不能再用」的回應：刪掉配對，讓外掛與 app 知道要重新配對。
const DEAD_TOKEN_REASONS = new Set(["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"]);

type Pairing = { member_id: string; device_token: string; environment: keyof typeof APNS_ORIGINS; rate_count: number };

function invalid(message: string): ApiError {
  return new ApiError(400, "invalid_request", message);
}

/// 配對密鑰(64 位小寫 hex = 32 bytes)的雜湊：那 32 bytes 的 SHA-256,小寫 hex。
export async function pairingKeyHash(key: string): Promise<string> {
  const bytes = new Uint8Array(key.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = parseInt(key.slice(index * 2, index * 2 + 2), 16);
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
  if (!HEX_64.test(keyHash)) throw invalid("keyHash must be 64 lowercase hex characters.");
  if (platform !== "apns") throw invalid("Unsupported platform.");
  if (!DEVICE_TOKEN.test(deviceToken)) throw invalid("deviceToken must be hex.");
  if (!ENVIRONMENTS.has(environment)) throw invalid("environment must be production or sandbox.");
  await requireActiveSubscription(env, memberId);

  const now = Date.now();
  const saved = await env.DB.prepare(
    `INSERT INTO push_pairings (key_hash, member_id, platform, device_token, environment, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (key_hash) DO UPDATE SET
       platform = excluded.platform, device_token = excluded.device_token, environment = excluded.environment,
       updated_at = excluded.updated_at
     WHERE push_pairings.member_id = excluded.member_id
     RETURNING key_hash`,
  )
    .bind(keyHash, memberId, platform, deviceToken, environment, now, now)
    .first();
  if (saved === null) throw new ApiError(409, "pairing_in_use", "This pairing key belongs to another member.");
}

/// DELETE /v1/members/me/push-pairings/{keyHash}:撤銷(只刪自己的;不存在也算成功)。不需要有效訂閱。
export async function revokePairing(env: Env, memberId: string, keyHash: string): Promise<void> {
  await env.DB.prepare("DELETE FROM push_pairings WHERE key_hash = ? AND member_id = ?").bind(keyHash, memberId).run();
}

// MARK: - 送推播(主機外掛)

type PushRequest = { key: string; workspace: string; status: string; pane: string | null };

async function readPushRequest(request: Request): Promise<PushRequest> {
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_PUSH_BODY_BYTES) throw new ApiError(413, "invalid_request", "Request body is too large.");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw invalid("Request body must be JSON.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalid("Request body must be a JSON object.");
  const fields = body as Record<string, unknown>;
  for (const field of Object.keys(fields)) {
    if (!PUSH_FIELDS.has(field)) throw invalid(`Unknown field: ${field}.`);
  }
  const key = requireString(fields, "key");
  const workspace = requireString(fields, "workspace");
  const status = requireString(fields, "status");
  const pane = fields.pane === undefined ? null : fields.pane;
  if (!HEX_64.test(key)) throw invalid("key must be 64 lowercase hex characters.");
  if ([...workspace].length > MAX_WORKSPACE_LENGTH) throw invalid("workspace is too long.");
  if (!PUSH_STATUSES.has(status)) throw invalid("Unsupported status.");
  if (pane !== null && (typeof pane !== "string" || !PANE_ID.test(pane))) throw invalid("pane must be a herdr pane id.");
  return { key, workspace, status, pane };
}

/// 找到配對並計入速率限制(固定一分鐘的視窗，一個 UPDATE 完成，避免同時的請求互相蓋掉計數)。
async function takePairing(env: Env, keyHash: string, now: number): Promise<Pairing | null> {
  return env.DB.prepare(
    `UPDATE push_pairings SET
       rate_count = CASE WHEN ? - rate_window_started_at >= ? THEN 1 ELSE rate_count + 1 END,
       rate_window_started_at = CASE WHEN ? - rate_window_started_at >= ? THEN ? ELSE rate_window_started_at END
     WHERE key_hash = ?
     RETURNING member_id, device_token, environment, rate_count`,
  )
    .bind(now, PUSH_RATE_WINDOW_MS, now, PUSH_RATE_WINDOW_MS, now, keyHash)
    .first<Pairing>();
}

/// POST /v1/push:主機外掛送「需要你」。
export async function sendPush(env: Env, request: Request): Promise<void> {
  const push = await readPushRequest(request);
  const keyHash = await pairingKeyHash(push.key);
  const pairing = await takePairing(env, keyHash, Date.now());
  if (pairing === null) throw new ApiError(404, "pairing_not_found", "This pairing isn't registered. Turn notifications on again in Purrdr.");
  if (pairing.rate_count > PUSH_RATE_LIMIT) throw new ApiError(429, "rate_limited", "Too many notifications. Try again in a minute.");
  if (!(await hasActiveSubscription(env, pairing.member_id))) {
    throw new ApiError(403, "subscription_required", "This needs an active Purrdr Plus subscription.");
  }

  const response = await deliverToApns(env, pairing, apnsPayload(push, keyHash));
  if (response.ok) return;
  const reason = await apnsReason(response);
  if (response.status === 410 || DEAD_TOKEN_REASONS.has(reason)) {
    await env.DB.prepare("DELETE FROM push_pairings WHERE key_hash = ?").bind(keyHash).run();
    throw new ApiError(410, "pairing_revoked", "This device no longer accepts notifications. Turn notifications on again in Purrdr.");
  }
  throw new ApiError(502, "apns_failed", `Apple Push Notification service refused the notification (${reason || response.status}).`);
}

/// APNs payload 由後台組：標題是 workspace 名稱，內文是固定句子(app 的字串表以 `loc-key` 翻譯),
/// 「需要你」用 Time Sensitive。根層的 `pairing`(配對密鑰雜湊)與 `pane` 給 app 點通知時找主機與 Agent。
export function apnsPayload(push: PushRequest, keyHash: string): Record<string, unknown> {
  return {
    aps: {
      alert: { title: push.workspace, "loc-key": "An agent needs you." },
      sound: "default",
      "interruption-level": "time-sensitive",
    },
    pairing: keyHash,
    ...(push.pane === null ? {} : { pane: push.pane }),
    status: push.status,
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
