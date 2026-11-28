import { ApiError, optionalString, readJson } from "./http";
import { iconView, MAX_HOST_NAME_LENGTH, readIcon, readLabel, type HostIcon } from "./host-label";
import { activeKindCodes, readKinds, storedKinds } from "./push-kinds";
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
  kinds: string;
  host_name: string | null;
  host_icon: string | null;
  host_icon_color: string | null;
};
/// 一組配對與它歸屬的裝置:`deviceId` 是對外的 id,`storedDeviceId` 是 devices.id(兩者只有遷移來的舊裝置不同)。
type DevicePairing = {
  keyHash: string;
  deviceId: string;
  storedDeviceId: string;
  updatedAt: number;
  name: string | null;
  model: string | null;
  kinds: string;
  hostName: string | null;
  icon: HostIcon | null;
};

export type PushHostView = { keyHash: string; name: string | null; icon: HostIcon | null };

export type PushDeviceView = {
  deviceId: string;
  name: string | null;
  model: string | null;
  hostCount: number;
  /// 這支裝置開著通知的主機(每組配對一台):名稱與圖示。
  hosts: PushHostView[];
  lastRegisteredAt: number;
  current: boolean;
};

/// 會員的所有配對與各自的裝置。裝置名稱與型號存在 devices,與配對一起查。
async function pairingsOfMember(env: Env, memberId: string): Promise<DevicePairing[]> {
  const { results } = await env.DB.prepare(
    `SELECT p.key_hash, p.updated_at, p.device_id, d.push_token, d.name, d.model, p.kinds, p.host_name, p.host_icon, p.host_icon_color
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
      kinds: row.kinds,
      hostName: row.host_name,
      icon: iconView(row.host_icon, row.host_icon_color),
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
      existing.hosts.push(hostOf(pairing));
      existing.lastRegisteredAt = Math.max(existing.lastRegisteredAt, pairing.updatedAt);
      continue;
    }
    devicesById.set(pairing.deviceId, {
      deviceId: pairing.deviceId,
      name: pairing.name,
      model: pairing.model,
      hostCount: 1,
      hosts: [hostOf(pairing)],
      lastRegisteredAt: pairing.updatedAt,
      current: pairing.deviceId === normalizedCurrentDeviceId,
    });
  }
  return [...devicesById.values()].sort((first, second) => second.lastRegisteredAt - first.lastRegisteredAt);
}

function hostOf(pairing: DevicePairing): PushHostView {
  return { keyHash: pairing.keyHash, name: pairing.hostName, icon: pairing.icon };
}

export type PushPairingView = { keyHash: string; name: string | null; icon: HostIcon | null; kinds: string[] };

function pairingView(pairing: DevicePairing, active: Set<string>): PushPairingView {
  return { keyHash: pairing.keyHash, name: pairing.hostName, icon: pairing.icon, kinds: storedKinds(pairing.kinds, active) };
}

/// GET /v1/members/me/push-pairings:會員的配對,每組帶名稱、圖示與目前開著的種類;`deviceId` 只回那支裝置的。
export async function listPairings(env: Env, memberId: string, deviceId: string | null): Promise<PushPairingView[]> {
  const normalizedDeviceId = deviceId === null ? null : parseDeviceId(deviceId);
  const [pairings, active] = await Promise.all([pairingsOfMember(env, memberId), activeKindCodes(env)]);
  return pairings
    .filter((pairing) => normalizedDeviceId === null || pairing.deviceId === normalizedDeviceId)
    .sort((first, second) => first.updatedAt - second.updatedAt || first.keyHash.localeCompare(second.keyHash))
    .map((pairing) => pairingView(pairing, active));
}

/// PATCH /v1/members/me/push-pairings/{keyHash}:改種類、名稱、圖示(沒帶的欄位不動,`name`／`icon` 帶 null 清掉);只改自己的。
export async function updatePairing(env: Env, memberId: string, keyHash: string, request: Request): Promise<PushPairingView> {
  const body = await readJson(request);
  const kinds = body.kinds === undefined ? undefined : await readKinds(env, body.kinds);
  const name = readLabel(body.name, "name", MAX_HOST_NAME_LENGTH);
  const icon = readIcon(body.icon);
  const sets: string[] = [];
  const values: unknown[] = [];
  if (kinds !== undefined) {
    sets.push("kinds = ?");
    values.push(kinds);
  }
  if (name !== undefined) {
    sets.push("host_name = ?");
    values.push(name);
  }
  if (icon !== undefined) {
    sets.push("host_icon = ?", "host_icon_color = ?");
    values.push(icon?.symbol ?? null, icon?.color ?? null);
  }
  if (sets.length > 0) {
    sets.push("updated_at = ?");
    values.push(Date.now());
    await env.DB.prepare(`UPDATE push_pairings SET ${sets.join(", ")} WHERE key_hash = ? AND member_id = ?`)
      .bind(...values, keyHash, memberId)
      .run();
  }
  const pairing = (await pairingsOfMember(env, memberId)).find((candidate) => candidate.keyHash === keyHash);
  if (pairing === undefined) {
    throw new ApiError(404, "pairing_not_found", "This pairing isn't registered.");
  }
  return pairingView(pairing, await activeKindCodes(env));
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
