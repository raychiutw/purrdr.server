import { ApiError, optionalString, readJson } from "./http";
import { requireActiveSubscription } from "./subscriptions";

/// 通知裝置(purrdr.server#5):同一支裝置在多台主機的配對以 device id 歸成一台裝置。
/// 清單不回傳 device token 與配對密鑰(雜湊也不給)。

const DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MODELS = new Set(["iPhone", "iPad"]);
const MAX_NAME_LENGTH = 64;
/// 舊版 app 註冊的配對沒有 device id,以 device token 的雜湊當識別(不洩漏 token)。
const LEGACY_PREFIX = "legacy-";

export type DeviceIdentity = { deviceId: string | null; name: string | null; model: string | null };

function invalid(message: string): ApiError {
  return new ApiError(400, "invalid_request", message);
}

function parseDeviceId(value: string): string {
  const deviceId = value.toLowerCase();
  if (!DEVICE_ID.test(deviceId)) throw invalid("deviceId must be a UUID.");
  return deviceId;
}

export function parseDeviceName(value: string | undefined): string | null {
  if (value === undefined) return null;
  const name = value.trim();
  if (name.length === 0 || [...name].length > MAX_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(name)) {
    throw invalid(`deviceName must be 1 to ${MAX_NAME_LENGTH} characters.`);
  }
  return name;
}

/// 註冊配對 body 裡的裝置欄位(都可省略：舊版 app 不帶)。
export function readDeviceIdentity(body: Record<string, unknown>): DeviceIdentity {
  const deviceId = optionalString(body, "deviceId");
  const model = optionalString(body, "model");
  if (model !== undefined && !MODELS.has(model)) throw invalid("model must be iPhone or iPad.");
  return {
    deviceId: deviceId === undefined ? null : parseDeviceId(deviceId),
    name: parseDeviceName(optionalString(body, "deviceName")),
    model: model ?? null,
  };
}

/// 記下裝置名稱與型號。已有名稱就保留(使用者改過的名稱不被預設名稱蓋掉)。
export function saveDeviceStatement(env: Env, memberId: string, device: DeviceIdentity): D1PreparedStatement | null {
  if (device.deviceId === null) return null;
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

type DeviceRow = { device_id: string | null; device_token: string; host_count: number; last_registered_at: number; name: string | null; model: string | null };

export type PushDeviceView = {
  deviceId: string;
  name: string | null;
  model: string | null;
  hostCount: number;
  lastRegisteredAt: number;
  current: boolean;
};

/// GET /v1/members/me/push-devices:會收到通知的裝置(至少一組配對)。`currentDeviceId` 標出呼叫者自己。
export async function listDevices(env: Env, memberId: string, currentDeviceId: string | null): Promise<PushDeviceView[]> {
  await requireActiveSubscription(env, memberId);
  return devicesOf(env, memberId, currentDeviceId);
}

async function devicesOf(env: Env, memberId: string, currentDeviceId: string | null): Promise<PushDeviceView[]> {
  const { results } = await env.DB.prepare(
    `SELECT p.device_id, MIN(p.device_token) AS device_token, COUNT(*) AS host_count, MAX(p.updated_at) AS last_registered_at,
            d.name, d.model
     FROM push_pairings p
     LEFT JOIN push_devices d ON d.member_id = p.member_id AND d.device_id = p.device_id
     WHERE p.member_id = ?
     GROUP BY COALESCE(p.device_id, 'token:' || p.device_token)
     ORDER BY last_registered_at DESC`,
  )
    .bind(memberId)
    .all<DeviceRow>();
  const current = currentDeviceId?.toLowerCase() ?? null;
  return Promise.all(
    results.map(async (row) => {
      const deviceId = row.device_id ?? (await legacyDeviceId(row.device_token));
      return {
        deviceId,
        name: row.name,
        model: row.model,
        hostCount: row.host_count,
        lastRegisteredAt: row.last_registered_at,
        current: deviceId === current,
      };
    }),
  );
}

/// 這支裝置的所有配對(只找自己的)。舊版 app 的裝置以 device token 的雜湊比對。
async function pairingsOfDevice(env: Env, memberId: string, deviceId: string): Promise<string[]> {
  const id = deviceId.toLowerCase();
  if (!id.startsWith(LEGACY_PREFIX)) {
    const { results } = await env.DB.prepare("SELECT key_hash FROM push_pairings WHERE member_id = ? AND device_id = ?")
      .bind(memberId, id)
      .all<{ key_hash: string }>();
    return results.map((row) => row.key_hash);
  }
  const { results } = await env.DB.prepare("SELECT key_hash, device_token FROM push_pairings WHERE member_id = ? AND device_id IS NULL")
    .bind(memberId)
    .all<{ key_hash: string; device_token: string }>();
  const matches = await Promise.all(results.map(async (row) => ((await legacyDeviceId(row.device_token)) === id ? row.key_hash : null)));
  return matches.filter((keyHash): keyHash is string => keyHash !== null);
}

async function requirePairingsOfDevice(env: Env, memberId: string, deviceId: string): Promise<string[]> {
  const keyHashes = await pairingsOfDevice(env, memberId, deviceId);
  if (keyHashes.length === 0) throw new ApiError(404, "device_not_found", "This device doesn't receive notifications.");
  return keyHashes;
}

/// DELETE /v1/members/me/push-devices/{deviceId}:撤銷這支裝置在所有主機的配對，主機外掛之後送推播會收到 410。
export async function revokeDevice(env: Env, memberId: string, deviceId: string): Promise<void> {
  const keyHashes = await requirePairingsOfDevice(env, memberId, deviceId);
  const now = Date.now();
  await env.DB.batch(
    keyHashes.flatMap((keyHash) => [
      env.DB.prepare("INSERT OR REPLACE INTO revoked_push_pairings (key_hash, member_id, revoked_at) VALUES (?, ?, ?)").bind(keyHash, memberId, now),
      env.DB.prepare("DELETE FROM push_pairings WHERE key_hash = ? AND member_id = ?").bind(keyHash, memberId),
    ]),
  );
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
  const id = deviceId.toLowerCase();
  const keyHashes = await requirePairingsOfDevice(env, memberId, id);
  await env.DB.batch([
    ...keyHashes.map((keyHash) => env.DB.prepare("UPDATE push_pairings SET device_id = ? WHERE key_hash = ? AND member_id = ?").bind(id, keyHash, memberId)),
    env.DB.prepare(
      `INSERT INTO push_devices (member_id, device_id, name) VALUES (?, ?, ?)
       ON CONFLICT (member_id, device_id) DO UPDATE SET name = excluded.name`,
    ).bind(memberId, id, name),
  ]);
  return (await devicesOf(env, memberId, currentDeviceId)).find((device) => device.deviceId === id)!;
}
