import { ApiError, optionalString, readJson } from "./http";
import { requireActiveSubscription } from "./subscriptions";

/// 通知裝置(purrdr.server#5):同一支裝置在多台主機的配對以 device id 歸成一台裝置。
/// 清單不回傳 device token 與配對密鑰(雜湊也不給)。

const DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MODELS = new Set(["iPhone", "iPad"]);
const MAX_NAME_LENGTH = 64;
/// 舊版 app 註冊的配對沒有 device id,以 device token 的雜湊當識別(不洩漏 token)。
const LEGACY_PREFIX = "legacy-";
/// 0009 遷移時,舊配對沒有 device id 的以 `token:<device token>` 當 devices.id(SQLite 算不了 SHA-256);
/// 對外一律換成 `legacy-<雜湊>`,device token 不出後台。
const MIGRATED_PREFIX = "token:";
/// 遠端關閉紀錄保留 90 天;外掛多半在下一次推播就收到 410 並清掉本機配對。
const REVOKED_PAIRING_RETENTION_MS = 90 * 24 * 60 * 60_000;

export type DeviceIdentity = { deviceId: string | null; name: string | null; model: string | null };

function invalid(message: string): ApiError {
  return new ApiError(400, "invalid_request", message);
}

function parseDeviceId(value: string): string {
  const deviceId = value.toLowerCase();
  if (!DEVICE_ID.test(deviceId)) {
    throw invalid("deviceId must be a UUID.");
  }
  return deviceId;
}

export function parseDeviceName(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const name = value.trim();
  if (name.length === 0 || [...name].length > MAX_NAME_LENGTH || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name)) {
    throw invalid(`deviceName must be 1 to ${MAX_NAME_LENGTH} characters.`);
  }
  return name;
}

/// 註冊配對 body 裡的裝置欄位(都可省略：舊版 app 不帶)。
export function readDeviceIdentity(body: Record<string, unknown>): DeviceIdentity {
  const deviceId = optionalString(body, "deviceId");
  const model = optionalString(body, "model");
  if (model !== undefined && !MODELS.has(model)) {
    throw invalid("model must be iPhone or iPad.");
  }
  return {
    deviceId: deviceId === undefined ? null : parseDeviceId(deviceId),
    name: parseDeviceName(optionalString(body, "deviceName")),
    model: model ?? null,
  };
}

export async function legacyDeviceId(deviceToken: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(deviceToken));
  return LEGACY_PREFIX + [...new Uint8Array(digest).slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

type PairingRow = {
  key_hash: string;
  updated_at: number;
  device_id: string;
  push_token: string | null;
  name: string | null;
  model: string | null;
};
/// 一組配對與它歸屬的裝置:`deviceId` 是對外的 id,`storedDeviceId` 是 devices.id(兩者只有遷移來的舊裝置不同)。
type DevicePairing = {
  keyHash: string;
  deviceId: string;
  storedDeviceId: string;
  updatedAt: number;
  name: string | null;
  model: string | null;
};

export type PushDeviceView = {
  deviceId: string;
  name: string | null;
  model: string | null;
  hostCount: number;
  lastRegisteredAt: number;
  current: boolean;
};

/// 會員的所有配對與各自的裝置。裝置名稱與型號存在 devices,與配對一起查。
async function pairingsOfMember(env: Env, memberId: string): Promise<DevicePairing[]> {
  const { results } = await env.DB.prepare(
    `SELECT p.key_hash, p.updated_at, p.device_id, d.push_token, d.name, d.model
     FROM push_pairings p JOIN devices d ON d.id = p.device_id WHERE p.member_id = ?`,
  )
    .bind(memberId)
    .all<PairingRow>();
  return Promise.all(
    results.map(async (row) => ({
      keyHash: row.key_hash,
      deviceId:
        row.device_id.startsWith(MIGRATED_PREFIX) && row.push_token !== null ? await legacyDeviceId(row.push_token) : row.device_id,
      storedDeviceId: row.device_id,
      updatedAt: row.updated_at,
      name: row.name,
      model: row.model,
    })),
  );
}

/// GET /v1/members/me/push-devices:會收到通知的裝置(至少一組配對)。`currentDeviceId` 標出呼叫者自己。
/// 不需要訂閱：到期後仍要能看到並關閉遺失的裝置。
export async function listDevices(env: Env, memberId: string, currentDeviceId: string | null): Promise<PushDeviceView[]> {
  const pairings = await pairingsOfMember(env, memberId);
  const normalizedCurrentDeviceId = currentDeviceId?.toLowerCase() ?? null;
  const devicesById = new Map<string, PushDeviceView>();
  for (const pairing of pairings) {
    const existing = devicesById.get(pairing.deviceId);
    if (existing) {
      existing.hostCount += 1;
      existing.lastRegisteredAt = Math.max(existing.lastRegisteredAt, pairing.updatedAt);
      continue;
    }
    devicesById.set(pairing.deviceId, {
      deviceId: pairing.deviceId,
      name: pairing.name,
      model: pairing.model,
      hostCount: 1,
      lastRegisteredAt: pairing.updatedAt,
      current: pairing.deviceId === normalizedCurrentDeviceId,
    });
  }
  return [...devicesById.values()].sort((first, second) => second.lastRegisteredAt - first.lastRegisteredAt);
}

/// 這支裝置的所有配對(只找自己的),對外 id 找不到(不是自己的或沒有配對)回 404。
async function requirePairingsOfDevice(env: Env, memberId: string, normalizedDeviceId: string): Promise<DevicePairing[]> {
  const pairings = (await pairingsOfMember(env, memberId)).filter((pairing) => pairing.deviceId === normalizedDeviceId);
  if (pairings.length === 0) {
    throw new ApiError(404, "device_not_found", "This device doesn't receive notifications.");
  }
  return pairings;
}

/// DELETE /v1/members/me/push-devices/{deviceId}:撤銷這支裝置在所有主機的配對，主機外掛之後送推播會收到 410。
export async function revokeDevice(env: Env, memberId: string, deviceId: string): Promise<void> {
  const keyHashes = (await requirePairingsOfDevice(env, memberId, deviceId.toLowerCase())).map((pairing) => pairing.keyHash);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM revoked_push_pairings WHERE revoked_at < ?").bind(now - REVOKED_PAIRING_RETENTION_MS),
    ...keyHashes.flatMap((keyHash) => [
      env.DB.prepare("INSERT OR REPLACE INTO revoked_push_pairings (key_hash, member_id, revoked_at) VALUES (?, ?, ?)").bind(keyHash, memberId, now),
      env.DB.prepare("DELETE FROM push_pairings WHERE key_hash = ? AND member_id = ?").bind(keyHash, memberId),
    ]),
  ]);
}

/// PATCH /v1/members/me/push-devices/{deviceId}:改名(body `{ name }`)。
export async function renameDevice(
  env: Env,
  memberId: string,
  deviceId: string,
  request: Request,
  currentDeviceId: string | null,
): Promise<PushDeviceView> {
  const name = parseDeviceName(optionalString(await readJson(request), "name") ?? "");
  await requireActiveSubscription(env, memberId);
  const normalizedDeviceId = deviceId.toLowerCase();
  const [first] = await requirePairingsOfDevice(env, memberId, normalizedDeviceId);
  await env.DB.prepare("UPDATE devices SET name = ? WHERE id = ?").bind(name, first!.storedDeviceId).run();
  return (await listDevices(env, memberId, currentDeviceId)).find((device) => device.deviceId === normalizedDeviceId)!;
}
