import { ApiError, optionalString, readJson } from "./http";
import { requireActiveSubscription } from "./subscriptions";

/// 通知裝置(purrdr.server#5):同一支裝置在多台主機的配對以 device id 歸成一台裝置。
/// 清單不回傳 device token 與配對密鑰(雜湊也不給)。

const DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MODELS = new Set(["iPhone", "iPad"]);
const MAX_NAME_LENGTH = 64;
/// 舊版 app 註冊的配對沒有 device id,以 device token 的雜湊當識別(不洩漏 token)。
const LEGACY_PREFIX = "legacy-";
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

/// 記下裝置名稱與型號。已有名稱就保留(使用者改過的名稱不被預設名稱蓋掉)。
export function saveDeviceStatement(env: Env, memberId: string, device: DeviceIdentity): D1PreparedStatement | null {
  if (device.deviceId === null) {
    return null;
  }
  return env.DB.prepare(
    `INSERT INTO push_devices (member_id, device_id, name, model) VALUES (?, ?, ?, ?)
     ON CONFLICT (member_id, device_id) DO UPDATE SET
       name = COALESCE(push_devices.name, excluded.name), model = COALESCE(excluded.model, push_devices.model)`,
  ).bind(memberId, device.deviceId, device.name, device.model);
}

async function legacyDeviceId(deviceToken: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(deviceToken));
  return LEGACY_PREFIX + [...new Uint8Array(digest).slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

type PairingRow = { key_hash: string; device_id: string | null; device_token: string; updated_at: number };
/// 一組配對與它歸屬的裝置 id(舊版 app 的配對以 device token 推出)。
type DevicePairing = { keyHash: string; deviceId: string; updatedAt: number };

export type PushDeviceView = {
  deviceId: string;
  name: string | null;
  model: string | null;
  hostCount: number;
  lastRegisteredAt: number;
  current: boolean;
};

/// 會員的所有配對與各自的裝置 id。在這裡歸類：舊版 app 的裝置改名後記下 id 的配對，與之後新增、還沒有 id 的配對仍是同一台。
async function pairingsOfMember(env: Env, memberId: string): Promise<DevicePairing[]> {
  const { results } = await env.DB.prepare("SELECT key_hash, device_id, device_token, updated_at FROM push_pairings WHERE member_id = ?")
    .bind(memberId)
    .all<PairingRow>();
  return Promise.all(
    results.map(async (row) => ({
      keyHash: row.key_hash,
      deviceId: row.device_id ?? (await legacyDeviceId(row.device_token)),
      updatedAt: row.updated_at,
    })),
  );
}

/// GET /v1/members/me/push-devices:會收到通知的裝置(至少一組配對)。`currentDeviceId` 標出呼叫者自己。
/// 不需要訂閱：到期後仍要能看到並關閉遺失的裝置。
export async function listDevices(env: Env, memberId: string, currentDeviceId: string | null): Promise<PushDeviceView[]> {
  const pairings = await pairingsOfMember(env, memberId);
  const { results: savedDevices } = await env.DB.prepare("SELECT device_id, name, model FROM push_devices WHERE member_id = ?")
    .bind(memberId)
    .all<{ device_id: string; name: string | null; model: string | null }>();
  const savedById = new Map(savedDevices.map((device) => [device.device_id, device]));
  const normalizedCurrentDeviceId = currentDeviceId?.toLowerCase() ?? null;
  const devicesById = new Map<string, PushDeviceView>();
  for (const pairing of pairings) {
    const existing = devicesById.get(pairing.deviceId);
    if (existing) {
      existing.hostCount += 1;
      existing.lastRegisteredAt = Math.max(existing.lastRegisteredAt, pairing.updatedAt);
      continue;
    }
    const saved = savedById.get(pairing.deviceId);
    devicesById.set(pairing.deviceId, {
      deviceId: pairing.deviceId,
      name: saved?.name ?? null,
      model: saved?.model ?? null,
      hostCount: 1,
      lastRegisteredAt: pairing.updatedAt,
      current: pairing.deviceId === normalizedCurrentDeviceId,
    });
  }
  return [...devicesById.values()].sort((first, second) => second.lastRegisteredAt - first.lastRegisteredAt);
}

/// 這支裝置的所有配對(只找自己的)。
async function pairingsOfDevice(env: Env, memberId: string, normalizedDeviceId: string): Promise<string[]> {
  return (await pairingsOfMember(env, memberId))
    .filter((pairing) => pairing.deviceId === normalizedDeviceId)
    .map((pairing) => pairing.keyHash);
}

async function requirePairingsOfDevice(env: Env, memberId: string, normalizedDeviceId: string): Promise<string[]> {
  const keyHashes = await pairingsOfDevice(env, memberId, normalizedDeviceId);
  if (keyHashes.length === 0) {
    throw new ApiError(404, "device_not_found", "This device doesn't receive notifications.");
  }
  return keyHashes;
}

/// DELETE /v1/members/me/push-devices/{deviceId}:撤銷這支裝置在所有主機的配對，主機外掛之後送推播會收到 410。
export async function revokeDevice(env: Env, memberId: string, deviceId: string): Promise<void> {
  const keyHashes = await requirePairingsOfDevice(env, memberId, deviceId.toLowerCase());
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM revoked_push_pairings WHERE revoked_at < ?").bind(now - REVOKED_PAIRING_RETENTION_MS),
    ...keyHashes.flatMap((keyHash) => [
      env.DB.prepare("INSERT OR REPLACE INTO revoked_push_pairings (key_hash, member_id, revoked_at) VALUES (?, ?, ?)").bind(keyHash, memberId, now),
      env.DB.prepare("DELETE FROM push_pairings WHERE key_hash = ? AND member_id = ?").bind(keyHash, memberId),
    ]),
  ]);
}

/// PATCH /v1/members/me/push-devices/{deviceId}:改名(body `{ name }`)。舊版 app 的裝置改名後以清單上的 id 記下。
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
  const keyHashes = await requirePairingsOfDevice(env, memberId, normalizedDeviceId);
  await env.DB.batch([
    ...keyHashes.map((keyHash) =>
      env.DB.prepare("UPDATE push_pairings SET device_id = ? WHERE key_hash = ? AND member_id = ?").bind(normalizedDeviceId, keyHash, memberId),
    ),
    env.DB.prepare(
      `INSERT INTO push_devices (member_id, device_id, name) VALUES (?, ?, ?)
       ON CONFLICT (member_id, device_id) DO UPDATE SET name = excluded.name`,
    ).bind(memberId, normalizedDeviceId, name),
  ]);
  return (await listDevices(env, memberId, currentDeviceId)).find((device) => device.deviceId === normalizedDeviceId)!;
}
