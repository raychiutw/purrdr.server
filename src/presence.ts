import { ApiError, readJson, requireString } from "./http";
import {
  acceptsKind,
  apnsReason,
  dailyLimit,
  DEAD_TOKEN_REASONS,
  deliverToApns,
  findPairing,
  pairingKeyHash,
  releaseDailyPush,
  requirePairing,
  reserveDailyPush,
  subtitleOf,
  utcDay,
  type Pairing,
} from "./push";

/// 主機在線狀態(purrdr.server#43、ADR-0017)。
///
/// - 主機服務每 5 分鐘 `POST /v1/heartbeat`(只帶配對密鑰與 `online`／`sleeping`);後台只存每組配對「最後一次心跳時間」與「目前狀態」,
///   沒有歷史,不記 IP。這台主機沒有任何配對開著 `host_offline`／`host_recovered` 時回 `needed: false`、不寫入任何資料。
/// - 後台沒有獨立的「主機」識別,以配對密鑰(雜湊)為單位:`needed` 只看收到心跳的那一組配對。
/// - 排程(Cron Trigger,每 5 分鐘):最後心跳超過 15 分鐘且是 `online` 的判為離線、送 `host_offline`;`sleeping` 不判離線。
///   之後收到 `online` 心跳送 `host_recovered`;睡眠醒來(sleeping 到 online)不送。每次轉換只送一次。
/// - 推播沿用每日上限的預留與還回:算進每日則數,達上限時略過、不補送(這次轉換已消耗)。

const HEX_64 = /^[0-9a-f]{64}$/;
const HEARTBEAT_FIELDS = new Set(["key", "state"]);
const STATES = new Set(["online", "sleeping"]);
const MAX_HEARTBEAT_BODY_BYTES = 256;
/// 最後心跳超過這麼久(毫秒)判離線:主機每 5 分鐘一次,連續 3 次沒收到。
export const OFFLINE_AFTER_MS = 15 * 60_000;

type PresenceKind = "host_offline" | "host_recovered";

const PRESENCE_ALERTS: Record<PresenceKind, { titleLocKey: string; locKey: string }> = {
  host_offline: { titleLocKey: "Host offline", locKey: "Your computer appears to be offline." },
  host_recovered: { titleLocKey: "Host back online", locKey: "Your computer is back online." },
};

function invalid(message: string): ApiError {
  return new ApiError(400, "invalid_request", message);
}

/// POST /v1/heartbeat:回傳 `needed`(這組配對有沒有開著離線或恢復通知)。
export async function receiveHeartbeat(env: Env, request: Request): Promise<{ needed: boolean }> {
  const text = await request.clone().text();
  if (new TextEncoder().encode(text).length > MAX_HEARTBEAT_BODY_BYTES) {
    throw new ApiError(413, "invalid_request", "Request body is too large.");
  }
  const fields = await readJson(request);
  for (const field of Object.keys(fields)) {
    if (!HEARTBEAT_FIELDS.has(field)) {
      throw invalid(`Unknown field: ${field}.`);
    }
  }
  const key = requireString(fields, "key");
  const state = requireString(fields, "state");
  if (!HEX_64.test(key)) {
    throw invalid("key must be 64 lowercase hex characters.");
  }
  if (!STATES.has(state)) {
    throw invalid("state must be online or sleeping.");
  }

  const keyHash = await pairingKeyHash(key);
  const pairing = await requirePairing(env, keyHash);
  const wantsOffline = await acceptsKind(env, pairing, "host_offline");
  const wantsRecovered = await acceptsKind(env, pairing, "host_recovered");
  if (!wantsOffline && !wantsRecovered) {
    await env.DB.prepare("DELETE FROM host_presence WHERE key_hash = ?").bind(keyHash).run();
    return { needed: false };
  }

  const now = Date.now();
  if (state === "online") {
    // 離線後第一個 online 心跳:一個 UPDATE 完成,同時到的重複心跳只有一個拿得到,所以恢復通知只送一次。
    const recovered = await env.DB.prepare("UPDATE host_presence SET state = 'online', last_seen_at = ? WHERE key_hash = ? AND state = 'offline' RETURNING key_hash")
      .bind(now, keyHash)
      .first();
    if (recovered !== null) {
      if (wantsRecovered) {
        await sendPresencePush(env, keyHash, pairing, "host_recovered");
      }
      return { needed: true };
    }
  }
  await env.DB.prepare(
    `INSERT INTO host_presence (key_hash, member_id, state, last_seen_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (key_hash) DO UPDATE SET state = excluded.state, last_seen_at = excluded.last_seen_at`,
  )
    .bind(keyHash, pairing.member_id, state, now)
    .run();
  return { needed: true };
}

/// 排程(每 5 分鐘):把超過 15 分鐘沒心跳的 online 主機判為離線並送 host_offline。
export async function detectOfflineHosts(env: Env): Promise<void> {
  const now = Date.now();
  // 已經沒有配對開著這兩種通知的,資料不留(主機服務得到 needed:false 就不會再送,不會有人來清)。
  await env.DB.prepare(
    `DELETE FROM host_presence WHERE key_hash IN (
       SELECT p.key_hash FROM push_pairings p WHERE NOT EXISTS (
         SELECT 1 FROM json_each(CASE WHEN json_valid(p.kinds) THEN p.kinds ELSE '[]' END) WHERE value IN ('host_offline', 'host_recovered')
       )
     )`,
  ).run();
  // 每一組一個 UPDATE ... RETURNING 認領,只有一個排程執行拿得到,每次轉換只送一次。
  const { results } = await env.DB.prepare("UPDATE host_presence SET state = 'offline' WHERE state = 'online' AND last_seen_at < ? RETURNING key_hash")
    .bind(now - OFFLINE_AFTER_MS)
    .all<{ key_hash: string }>();
  for (const { key_hash: keyHash } of results) {
    const pairing = await findPairing(env, keyHash);
    if (pairing !== null && (await acceptsKind(env, pairing, "host_offline"))) {
      await sendPresencePush(env, keyHash, pairing, "host_offline");
    }
  }
}

/// 送一則離線或恢復通知:先預留每日則數(達上限就略過,不重送),沒送到 APNs 還回去;失敗不拋錯,排程不因單一配對中斷。
async function sendPresencePush(env: Env, keyHash: string, pairing: Pairing, kind: PresenceKind): Promise<void> {
  const day = utcDay(Date.now());
  if ((await reserveDailyPush(env, pairing.member_id, day, await dailyLimit(env, pairing.member_id))) === null) {
    return;
  }
  try {
    const response = await deliverToApns(env, pairing, presencePayload(kind, keyHash, pairing.host_name));
    if (response.ok) {
      return;
    }
    await releaseDailyPush(env, pairing.member_id, day);
    const reason = await apnsReason(response);
    if (response.status === 410 || DEAD_TOKEN_REASONS.has(reason)) {
      await env.DB.prepare("DELETE FROM push_pairings WHERE key_hash = ?").bind(keyHash).run();
    }
  } catch {
    await releaseDailyPush(env, pairing.member_id, day);
  }
}

/// 文字由 app 的字串表以 `loc-key` 翻譯;active、不帶 category(點擊只開 app 到那台主機)。
function presencePayload(kind: PresenceKind, keyHash: string, hostName: string | null): Record<string, unknown> {
  const alert = PRESENCE_ALERTS[kind];
  return {
    aps: {
      alert: { "title-loc-key": alert.titleLocKey, "loc-key": alert.locKey, ...subtitleOf(hostName) },
      sound: "default",
      "interruption-level": "active",
      "mutable-content": 1,
    },
    pairing: keyHash,
    event: kind,
  };
}
