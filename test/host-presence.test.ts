import { env } from "cloudflare:workers";
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { api, identityProviders } from "./fakes";
import { DEVICE_TOKEN, hashOf, member, pairingKey, push, register } from "./push-kinds-support";

/// 主機在線狀態(purrdr.server#43、ADR-0017):主機服務送心跳,後台只存最後一次心跳時間與目前狀態;
/// 5 分鐘一次的排程把超過 15 分鐘沒心跳(且不是睡眠中)的判為離線並送 host_offline,之後收到 online 心跳送 host_recovered。
/// 全部從 HTTP 入口與 scheduled 入口驗證,APNs 是 test/fakes.ts 的假端點。

const MINUTE = 60_000;
const T0 = 1_800_000_000_000;

afterEach(() => {
  vi.restoreAllMocks();
});

function setNow(offsetMinutes: number) {
  vi.spyOn(Date, "now").mockReturnValue(T0 + offsetMinutes * MINUTE);
}

function heartbeat(key: string, state: unknown) {
  return api("POST", "/v1/heartbeat", { body: { key, state } });
}

/// 跑一次排程(Cron Trigger)。
async function runScheduled() {
  const ctx = createExecutionContext();
  await worker.scheduled!(createScheduledController({ cron: "*/5 * * * *" }), env, ctx);
  await waitOnExecutionContext(ctx);
}

async function paired(kinds: string[], subject = "apple-user-1", extra: Record<string, unknown> = {}) {
  const me = await member(subject);
  const key = pairingKey();
  expect((await register(me.accessToken, key, { kinds, ...extra })).status).toBe(201);
  return { me, key };
}

const presenceEvents = () => identityProviders.apnsCalls.map((call) => call.payload.event);
const presenceRows = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM host_presence").first<{ n: number }>())?.n;

describe("POST /v1/heartbeat", () => {
  it("配對開著主機離線或已恢復時回 needed: true,兩種都沒開回 false", async () => {
    const offline = await paired(["host_offline"], "u1");
    const recovered = await paired(["host_recovered"], "u2");
    const neither = await paired(["blocked"], "u3");

    expect((await heartbeat(offline.key, "online")).body).toEqual({ needed: true });
    expect((await heartbeat(recovered.key, "online")).body).toEqual({ needed: true });
    const none = await heartbeat(neither.key, "online");
    expect(none.status).toBe(200);
    expect(none.body).toEqual({ needed: false });
  });

  it("不需要時不存任何資料", async () => {
    const { key } = await paired(["blocked"]);

    await heartbeat(key, "online");

    expect(await presenceRows()).toBe(0);
  });

  it("只存最後一次心跳時間與目前狀態,同一組配對只有一列", async () => {
    const { key } = await paired(["host_offline"]);
    setNow(0);
    await heartbeat(key, "online");
    setNow(5);
    await heartbeat(key, "sleeping");

    const { results } = await env.DB.prepare("SELECT key_hash, state, last_seen_at FROM host_presence").all();
    expect(results).toEqual([{ key_hash: await hashOf(key), state: "sleeping", last_seen_at: T0 + 5 * MINUTE }]);
  });

  it("欄位嚴格:多帶欄位、state 不合法、key 格式錯都回 400", async () => {
    const { key } = await paired(["host_offline"]);

    expect((await api("POST", "/v1/heartbeat", { body: { key, state: "online", ip: "1.2.3.4" } })).status).toBe(400);
    expect((await heartbeat(key, "offline")).status).toBe(400);
    expect((await heartbeat(key, undefined)).status).toBe(400);
    expect((await heartbeat("zz", "online")).status).toBe(400);
  });

  it("配對不存在回 404,撤銷過的回一次 410", async () => {
    const me = await member();
    const unknown = pairingKey();
    expect((await heartbeat(unknown, "online")).status).toBe(404);

    const revoked = pairingKey();
    await env.DB.prepare("INSERT INTO revoked_push_pairings (key_hash, member_id, revoked_at) VALUES (?, ?, ?)").bind(await hashOf(revoked), me.id, Date.now()).run();
    expect((await heartbeat(revoked, "online")).status).toBe(410);
    expect((await heartbeat(revoked, "online")).status).toBe(404);
  });

  it("配對被刪除時一併清掉心跳資料", async () => {
    const { me, key } = await paired(["host_offline"]);
    await heartbeat(key, "online");

    await api("DELETE", `/v1/members/me/push-pairings/${await hashOf(key)}`, { accessToken: me.accessToken });

    expect(await presenceRows()).toBe(0);
  });
});

describe("排程判定離線", () => {
  it("超過 15 分鐘沒心跳送 host_offline,只送一次", async () => {
    const { key } = await paired(["host_offline"]);
    setNow(0);
    await heartbeat(key, "online");

    setNow(14);
    await runScheduled();
    expect(identityProviders.apnsCalls).toHaveLength(0);

    setNow(16);
    await runScheduled();
    setNow(21);
    await runScheduled();

    expect(identityProviders.apnsCalls).toHaveLength(1);
    const payload = identityProviders.apnsCalls[0]!.payload;
    expect(payload.event).toBe("host_offline");
    expect(payload.pairing).toBe(await hashOf(key));
    expect(payload.aps.alert["loc-key"]).toBe("Your computer appears to be offline.");
    expect(payload.aps.alert["title-loc-key"]).toBe("Host offline");
    expect(identityProviders.apnsCalls[0]!.deviceToken).toBe(DEVICE_TOKEN);
  });

  it("電腦名稱放在副標題", async () => {
    const { key } = await paired(["host_offline"], "apple-user-1", { name: "Studio Mac" });
    setNow(0);
    await heartbeat(key, "online");
    setNow(20);
    await runScheduled();

    expect(identityProviders.apnsCalls[0]!.payload.aps.alert.subtitle).toBe("Studio Mac");
  });

  it("睡眠中不判離線,即使很久沒心跳", async () => {
    const { key } = await paired(["host_offline"]);
    setNow(0);
    await heartbeat(key, "sleeping");

    setNow(600);
    await runScheduled();

    expect(identityProviders.apnsCalls).toHaveLength(0);
  });

  it("沒有配對開著這兩種時不送(也清掉資料)", async () => {
    const { me, key } = await paired(["host_offline"]);
    setNow(0);
    await heartbeat(key, "online");
    await api("PATCH", `/v1/members/me/push-pairings/${await hashOf(key)}`, { accessToken: me.accessToken, body: { kinds: ["blocked"] } });

    setNow(30);
    await runScheduled();

    expect(identityProviders.apnsCalls).toHaveLength(0);
    expect(await presenceRows()).toBe(0);
  });

  it("只開已恢復時,離線不送、恢復才送", async () => {
    const { key } = await paired(["host_recovered"]);
    setNow(0);
    await heartbeat(key, "online");
    setNow(20);
    await runScheduled();
    expect(identityProviders.apnsCalls).toHaveLength(0);

    setNow(25);
    await heartbeat(key, "online");
    expect(presenceEvents()).toEqual(["host_recovered"]);
  });
});

describe("恢復", () => {
  it("離線後收到 online 心跳送 host_recovered,只送一次", async () => {
    const { key } = await paired(["host_offline", "host_recovered"]);
    setNow(0);
    await heartbeat(key, "online");
    setNow(20);
    await runScheduled();

    setNow(25);
    expect((await heartbeat(key, "online")).body).toEqual({ needed: true });
    setNow(30);
    await heartbeat(key, "online");

    expect(presenceEvents()).toEqual(["host_offline", "host_recovered"]);
    const recovered = identityProviders.apnsCalls[1]!.payload;
    expect(recovered.aps.alert["loc-key"]).toBe("Your computer is back online.");
    expect(recovered.pairing).toBe(await hashOf(key));
  });

  it("睡眠中醒來(sleeping 到 online)不送恢復", async () => {
    const { key } = await paired(["host_offline", "host_recovered"]);
    setNow(0);
    await heartbeat(key, "sleeping");
    setNow(60);
    await heartbeat(key, "online");

    expect(identityProviders.apnsCalls).toHaveLength(0);
  });

  it("再度離線會再送一次 host_offline", async () => {
    const { key } = await paired(["host_offline", "host_recovered"]);
    setNow(0);
    await heartbeat(key, "online");
    setNow(20);
    await runScheduled();
    setNow(25);
    await heartbeat(key, "online");
    setNow(45);
    await runScheduled();

    expect(presenceEvents()).toEqual(["host_offline", "host_recovered", "host_offline"]);
  });
});

describe("每日上限", () => {
  it("達上限時略過、不重送(這次轉換已消耗)", async () => {
    const { me, key } = await paired(["host_offline", "host_recovered"]);
    await env.DB.prepare("UPDATE members SET daily_push_limit = 1 WHERE id = ?").bind(me.id).run();
    setNow(0);
    expect((await push({ key, event: "test" })).status).toBe(200);
    identityProviders.apnsCalls.length = 0;
    await heartbeat(key, "online");

    setNow(20);
    await runScheduled();
    setNow(25);
    await runScheduled();
    expect(identityProviders.apnsCalls).toHaveLength(0);

    await env.DB.prepare("UPDATE members SET daily_push_limit = 100 WHERE id = ?").bind(me.id).run();
    setNow(30);
    await runScheduled();
    expect(identityProviders.apnsCalls).toHaveLength(0);
  });

  it("送出的通知計入當日用量", async () => {
    const { me, key } = await paired(["host_offline"]);
    setNow(0);
    await heartbeat(key, "online");
    setNow(20);
    await runScheduled();

    const usage = await api("GET", "/v1/members/me", { accessToken: me.accessToken });
    expect(usage.body.member.pushUsage.sent).toBe(1);
  });
});

describe("種類清單", () => {
  it("host_offline 與 host_recovered 預設關、只有 https、需主機服務 0.16.0", async () => {
    const me = await member();
    const kinds = (await api("GET", "/v1/push-kinds", { accessToken: me.accessToken })).body.kinds as any[];

    for (const code of ["host_offline", "host_recovered"]) {
      const kind = kinds.find((item) => item.code === code);
      expect(kind).toMatchObject({ defaultOn: false, transports: ["https"], minServiceVersion: "0.16.0", minPluginVersion: null });
    }
  });
});
