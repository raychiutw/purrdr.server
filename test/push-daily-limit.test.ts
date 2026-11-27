import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, identityProviders, insertPairing, signInWithApple, type ApnsReply } from "./fakes";

/// 推播改每個會員每日上限(purrdr.server#36):不再需要 Purrdr Plus,預設每個 UTC 日 100 則,
/// 會員欄位 `daily_push_limit` 可調。全部從 HTTP 入口驗證，APNs 是 test/fakes.ts 的假端點。

const DEVICE_TOKEN = "a1".repeat(32);

/// 沒有任何訂閱的會員:上架版 app 不賣 Plus。
async function member(subject = "apple-user-1") {
  const signIn = await signInWithApple(subject);
  return { accessToken: signIn.body.accessToken as string, id: signIn.body.member.id as string };
}

function pairingKey(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/// 雜湊 = 密鑰 32 bytes 的 SHA-256(小寫 hex)。用 WebCrypto 另外算，不經後台程式。
async function hashOf(key: string): Promise<string> {
  const bytes = new Uint8Array(key.match(/../g)!.map((pair) => parseInt(pair, 16)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function register(accessToken: string, key: string, extra: Record<string, unknown> = {}) {
  return api("POST", "/v1/members/me/push-pairings", {
    accessToken,
    body: { keyHash: await hashOf(key), platform: "apns", deviceToken: DEVICE_TOKEN, environment: "production", ...extra },
  });
}

function push(body: Record<string, unknown>) {
  return api("POST", "/v1/push", { body });
}

const testEvent = (key: string) => ({ key, event: "test" });
const hostEvent = (key: string) => ({ key, event: "host_service_update_available" });

afterEach(() => {
  vi.restoreAllMocks();
});

/// 會員快照裡的今日用量(GET /v1/members/me)。
async function usageOf(accessToken: string) {
  const response = await api("GET", "/v1/members/me", { accessToken });
  expect(response.status).toBe(200);
  return response.body.member.pushUsage as { limit: number; sent: number; resetsAt: string };
}

const blocked = (key: string) => ({ key, workspace: "weather-app", status: "blocked", pane: "w2:p1" });

describe("不需要 Purrdr Plus", () => {
  it("沒有訂閱的會員也能註冊推播配對並送出推播", async () => {
    const me = await member();
    const key = pairingKey();

    const registered = await register(me.accessToken, key);
    const sent = await push(blocked(key));

    expect(registered.status).toBe(201);
    expect(sent.status).toBe(200);
    expect(sent.body.delivered).toBe(true);
    expect(identityProviders.apnsCalls).toHaveLength(1);
  });
});

/// 營運者直接改會員欄位調整上限(NULL = 預設 100)。
async function setLimit(memberId: string, limit: number | null) {
  await env.DB.prepare("UPDATE members SET daily_push_limit = ? WHERE id = ?").bind(limit, memberId).run();
}

const LIMIT_NOTICE_EVENT = "daily_limit_reached";

describe("每日上限", () => {
  it("第 N 則送出後接著送一則「今日已達上限」通知,之後回 429 daily_limit_reached", async () => {
    const me = await member();
    await setLimit(me.id, 2);
    const key = pairingKey();
    await register(me.accessToken, key);

    expect((await push(blocked(key))).status).toBe(200);
    expect((await push(blocked(key))).status).toBe(200);
    const limited = await push(blocked(key));

    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("daily_limit_reached");
    // 2 則推播 + 1 則上限通知;被擋下的第 3 則不呼叫 APNs。
    expect(identityProviders.apnsCalls).toHaveLength(3);
    const notice = identityProviders.apnsCalls[2]!.payload;
    expect(notice.event).toBe(LIMIT_NOTICE_EVENT);
    expect(notice.pairing).toBe(await hashOf(key));
    expect(notice.aps.alert["title-loc-key"]).toBe("Daily notification limit reached");
    expect(notice.aps.alert["loc-key"]).toBe("You've reached today's limit of %@ notifications. They'll resume at 00:00 UTC.");
    expect(notice.aps.alert["loc-args"]).toEqual(["2"]);
  });

  it("上限通知同一天只送一次,也不計數", async () => {
    const me = await member();
    await setLimit(me.id, 1);
    const key = pairingKey();
    await register(me.accessToken, key);

    await push(blocked(key));
    for (let index = 0; index < 3; index += 1) {
      expect((await push(blocked(key))).status).toBe(429);
    }

    const notices = identityProviders.apnsCalls.filter((call) => call.payload.event === LIMIT_NOTICE_EVENT);
    expect(notices).toHaveLength(1);
    expect(identityProviders.apnsCalls).toHaveLength(2);
  });

  it("上限通知送到觸發的那支裝置", async () => {
    const me = await member();
    await setLimit(me.id, 2);
    const keyA = pairingKey();
    const keyB = pairingKey();
    const deviceB = "b2".repeat(32);
    await insertPairing({ keyHash: await hashOf(keyA), memberId: me.id, deviceToken: DEVICE_TOKEN });
    await insertPairing({ keyHash: await hashOf(keyB), memberId: me.id, deviceToken: deviceB, deviceId: "device-b" });

    await push(blocked(keyA));
    await push(blocked(keyB));

    const notice = identityProviders.apnsCalls.find((call) => call.payload.event === LIMIT_NOTICE_EVENT);
    expect(notice?.deviceToken).toBe(deviceB);
  });

  it("沒設會員欄位時預設上限是 100", async () => {
    const me = await member();
    // 每組配對每分鐘 10 則,所以用 11 組配對送滿 100 則。
    const keys: string[] = [];
    for (let index = 0; index < 11; index += 1) {
      const key = pairingKey();
      keys.push(key);
      await insertPairing({ keyHash: await hashOf(key), memberId: me.id, deviceToken: DEVICE_TOKEN });
    }

    for (let index = 0; index < 100; index += 1) {
      expect((await push(blocked(keys[Math.floor(index / 10)]!))).status).toBe(200);
    }
    const limited = await push(blocked(keys[10]!));

    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("daily_limit_reached");
  });
});

describe("計數規則", () => {
  it("測試通知要算", async () => {
    const me = await member();
    const key = pairingKey();
    await register(me.accessToken, key);

    expect((await push(testEvent(key))).status).toBe(200);

    expect((await usageOf(me.accessToken)).sent).toBe(1);
  });

  it("種類偏好擋下的不算", async () => {
    const me = await member();
    const key = pairingKey();
    await register(me.accessToken, key); // 預設只收 blocked

    const sent = await push({ key, workspace: "weather-app", status: "done" });

    expect(sent.body.delivered).toBe(false);
    expect((await usageOf(me.accessToken)).sent).toBe(0);
  });

  it("主機服務事件 24 小時去重擋下的不算", async () => {
    const me = await member();
    const key = pairingKey();
    await register(me.accessToken, key, { kinds: ["host_service"] });

    expect((await push(hostEvent(key))).body.delivered).toBe(true);
    expect((await push(hostEvent(key))).body.delivered).toBe(false);

    expect((await usageOf(me.accessToken)).sent).toBe(1);
  });

  it("APNs 失敗的不算,之後仍可送滿上限", async () => {
    const me = await member();
    await setLimit(me.id, 1);
    const key = pairingKey();
    await register(me.accessToken, key);
    identityProviders.apnsReplies = [{ status: 500, reason: "InternalServerError" }];

    expect((await push(blocked(key))).status).toBe(502);
    expect((await usageOf(me.accessToken)).sent).toBe(0);
    expect((await push(blocked(key))).status).toBe(200);
  });

  it("被每分鐘限速擋下的不算", async () => {
    const me = await member();
    const key = pairingKey();
    await register(me.accessToken, key);

    for (let index = 0; index < 11; index += 1) {
      await push(blocked(key));
    }

    expect((await usageOf(me.accessToken)).sent).toBe(10);
  });
});

describe("UTC 換日與同時請求", () => {
  it("UTC 0:00 之後恢復,上限通知隔天可以再送一次", async () => {
    const me = await member();
    await setLimit(me.id, 1);
    const key = pairingKey();
    await register(me.accessToken, key);
    const base = Date.UTC(2026, 10, 28, 23, 59, 0);
    const clock = vi.spyOn(Date, "now").mockReturnValue(base);

    expect((await push(blocked(key))).status).toBe(200);
    expect((await push(blocked(key))).status).toBe(429);

    clock.mockReturnValue(base + 2 * 60_000);
    expect((await push(blocked(key))).status).toBe(200);
    expect((await push(blocked(key))).status).toBe(429);

    const notices = identityProviders.apnsCalls.filter((call) => call.payload.event === LIMIT_NOTICE_EVENT);
    expect(notices).toHaveLength(2);
  });

  it("同時到的請求不會超過上限,計數也不會被蓋掉", async () => {
    const me = await member();
    await setLimit(me.id, 3);
    const key = pairingKey();
    await register(me.accessToken, key);

    const results = await Promise.all(Array.from({ length: 6 }, () => push(blocked(key))));

    expect(results.filter((result) => result.status === 200)).toHaveLength(3);
    expect(results.filter((result) => result.status === 429)).toHaveLength(3);
    // 3 則推播 + 1 則上限通知(只有一個請求搶得到)。
    expect(identityProviders.apnsCalls).toHaveLength(4);
    expect((await usageOf(me.accessToken)).sent).toBe(3);
  });
});

describe("上限通知只送一次(競態)", () => {
  it("先預留的請求卡在 APNs、後面的請求搶到上限通知,之後它失敗還回預留、再湊滿上限也不會送第二次", async () => {
    const me = await member();
    await setLimit(me.id, 2);
    const key = pairingKey();
    await register(me.accessToken, key);
    // workspace 叫 slow 的請求在 APNs 多停 400 毫秒再失敗(計時器要建在請求自己的 context,Workers 不允許跨請求 resolve)。
    identityProviders.apnsHold = (call) =>
      call.payload.aps.alert.title === "slow"
        ? new Promise<ApnsReply>((resolve) => setTimeout(() => resolve({ status: 500, reason: "InternalServerError" }), 400))
        : Promise.resolve(undefined);

    const slow = push({ ...blocked(key), workspace: "slow" });
    await vi.waitFor(() => expect(identityProviders.apnsCalls).toHaveLength(1));
    // 第 2 則在這段時間內完整跑完:預留到上限、送出、搶到上限通知。
    expect((await push(blocked(key))).status).toBe(200);
    expect((await slow).status).toBe(502);
    expect((await usageOf(me.accessToken)).sent).toBe(1);
    // 再送一則又湊滿上限:今天已經通知過,不能再送。
    expect((await push(blocked(key))).status).toBe(200);

    const notices = identityProviders.apnsCalls.filter((call) => call.payload.event === LIMIT_NOTICE_EVENT);
    expect(notices).toHaveLength(1);
  });
});

describe("主機服務事件的去重登記", () => {
  it("連不上 APNs 時還回去重登記,重送仍能送出、且不重複計數", async () => {
    const me = await member();
    const key = pairingKey();
    await register(me.accessToken, key, { kinds: ["host_service"] });
    identityProviders.apnsHold = () => Promise.reject(new Error("network down"));

    expect((await push(hostEvent(key))).status).toBe(502);
    expect((await usageOf(me.accessToken)).sent).toBe(0);
    identityProviders.apnsHold = null;

    expect((await push(hostEvent(key))).body.delivered).toBe(true);
    expect((await usageOf(me.accessToken)).sent).toBe(1);
  });

  it("被每日上限擋下時還回去重登記,隔天重送仍能送出", async () => {
    const me = await member();
    await setLimit(me.id, 1);
    const key = pairingKey();
    await register(me.accessToken, key, { kinds: ["blocked", "host_service"] });
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 10, 28, 23, 59, 0));
    await push(blocked(key));

    expect((await push(hostEvent(key))).status).toBe(429);
    clock.mockReturnValue(Date.UTC(2026, 10, 29, 0, 1, 0));

    expect((await push(hostEvent(key))).body.delivered).toBe(true);
  });
});

describe("用量(會員快照的 pushUsage)", () => {
  it("回今日上限、已送則數、下次歸零時間(UTC)", async () => {
    const me = await member();
    await setLimit(me.id, 1000);
    const key = pairingKey();
    await register(me.accessToken, key);
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 10, 28, 15, 30, 0));

    await push(blocked(key));
    await push(testEvent(key));

    expect(await usageOf(me.accessToken)).toEqual({ limit: 1000, sent: 2, resetsAt: "2026-11-29T00:00:00.000Z" });
  });

  it("還沒送過、沒設欄位時是預設 100 與 0 則", async () => {
    const me = await member();

    expect(await usageOf(me.accessToken)).toMatchObject({ limit: 100, sent: 0 });
  });

  it("隔天重新從 0 開始算", async () => {
    const me = await member();
    const key = pairingKey();
    await register(me.accessToken, key);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 10, 28, 23, 59, 0));
    await push(blocked(key));
    expect((await usageOf(me.accessToken)).sent).toBe(1);

    clock.mockReturnValue(Date.UTC(2026, 10, 29, 0, 1, 0));

    expect(await usageOf(me.accessToken)).toMatchObject({ sent: 0, resetsAt: "2026-11-30T00:00:00.000Z" });
  });
});
