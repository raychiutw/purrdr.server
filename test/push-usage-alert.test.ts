import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, identityProviders } from "./fakes";
import { hashOf, member, pairingKey, push, register } from "./push-kinds-support";

/// 方案用量通知(purrdr.server#42、purrdr.ios#704):主機端偵測到 Claude／Codex 方案用量跨過門檻時送 `status: "usage"`。
/// 去重鍵 (會員, agent, resetsAt, threshold),每個週期每個門檻只送一次。全部從 HTTP 入口驗證。

afterEach(() => {
  vi.restoreAllMocks();
});

const RESETS_AT = 1_900_000_000;
const usage = (key: string, extra: Record<string, unknown> = {}) => ({ key, status: "usage", agent: "claude", threshold: 80, resetsAt: RESETS_AT, ...extra });

async function registerWithUsage(accessToken: string, key: string, kinds: string[] = ["usage_alert"]) {
  const response = await register(accessToken, key, { kinds });
  expect(response.status).toBe(201);
}

describe("方案用量通知", () => {
  it("清單有 usage_alert:預設開、外掛 0.3.0／主機服務 0.16.0", async () => {
    const me = await member();
    const response = await api("GET", "/v1/push-kinds", { accessToken: me.accessToken });
    const kind = response.body.kinds.find((item: { code: string }) => item.code === "usage_alert");

    expect(kind.defaultOn).toBe(true);
    expect(kind.transports).toEqual(["https", "ssh"]);
    expect(kind.minPluginVersion).toBe("0.3.0");
    expect(kind.minServiceVersion).toBe("0.16.0");
    expect(kind.description.en).toContain("Codex");
  });

  it("送出一則,payload 帶門檻、agent 顯示名與 agent,不帶 workspace／pane", async () => {
    const me = await member();
    const key = pairingKey();
    await registerWithUsage(me.accessToken, key);

    const sent = await push(usage(key, { threshold: 95, agent: "codex" }));

    expect(sent.status).toBe(200);
    expect(sent.body.delivered).toBe(true);
    const payload = identityProviders.apnsCalls[0]!.payload;
    expect(payload.event).toBe("usage_alert");
    expect(payload.pairing).toBe(await hashOf(key));
    expect(payload.agent).toBe("codex");
    expect(payload.threshold).toBe(95);
    expect(payload.pane).toBeUndefined();
    expect(payload.aps.alert["loc-key"]).toBe("Your %@ plan usage reached %@%%.");
    expect(payload.aps.alert["loc-args"]).toEqual(["Codex", "95"]);
    expect(payload.aps["interruption-level"]).toBe("active");
  });
});

describe("去重", () => {
  it("同一會員同一 agent、週期、門檻只送一次,被擋下的回 delivered: false 且不計入每日則數", async () => {
    const me = await member();
    const key = pairingKey();
    await registerWithUsage(me.accessToken, key);

    const first = await push(usage(key));
    const second = await push(usage(key));
    const third = await push(usage(key));

    expect(first.body.delivered).toBe(true);
    expect(second.status).toBe(200);
    expect(second.body.delivered).toBe(false);
    expect(third.body.delivered).toBe(false);
    expect(identityProviders.apnsCalls).toHaveLength(1);
    const snapshot = await api("GET", "/v1/members/me", { accessToken: me.accessToken });
    expect(snapshot.body.member.pushUsage.sent).toBe(1);
  });

  it("同時越過 80 與 95 各送一則;不同 agent 或新的週期(resetsAt)重新送", async () => {
    const me = await member();
    const key = pairingKey();
    await registerWithUsage(me.accessToken, key);

    const results = [
      await push(usage(key, { threshold: 80 })),
      await push(usage(key, { threshold: 95 })),
      await push(usage(key, { agent: "codex" })),
      await push(usage(key, { resetsAt: RESETS_AT + 604_800 })),
    ];

    expect(results.map((result) => result.body.delivered)).toEqual([true, true, true, true]);
    expect(identityProviders.apnsCalls).toHaveLength(4);
  });

  it("同一會員多組配對只送一次(以會員為去重鍵)", async () => {
    const me = await member();
    const keyA = pairingKey();
    const keyB = pairingKey();
    await registerWithUsage(me.accessToken, keyA);
    await registerWithUsage(me.accessToken, keyB);

    expect((await push(usage(keyA))).body.delivered).toBe(true);
    expect((await push(usage(keyB))).body.delivered).toBe(false);
    expect(identityProviders.apnsCalls).toHaveLength(1);
  });

  it("關著 usage_alert 的配對不送也不登記,另一組開著的之後仍收得到", async () => {
    const me = await member();
    const off = pairingKey();
    const on = pairingKey();
    await registerWithUsage(me.accessToken, off, ["blocked"]);
    await registerWithUsage(me.accessToken, on);

    expect((await push(usage(off))).body.delivered).toBe(false);
    expect((await push(usage(on))).body.delivered).toBe(true);
    expect(identityProviders.apnsCalls).toHaveLength(1);
  });

  it("APNs 失敗釋放登記,重送可以再試", async () => {
    const me = await member();
    const key = pairingKey();
    await registerWithUsage(me.accessToken, key);
    identityProviders.apnsReplies.push({ status: 500, reason: "InternalServerError" });

    const failed = await push(usage(key));
    const retried = await push(usage(key));

    expect(failed.status).toBe(502);
    expect(retried.body.delivered).toBe(true);
  });

  it("每日上限擋下時釋放登記", async () => {
    const me = await member();
    const key = pairingKey();
    await registerWithUsage(me.accessToken, key);
    await env.DB.prepare("UPDATE members SET daily_push_limit = 0 WHERE id = ?").bind(me.id).run();

    const limited = await push(usage(key));

    expect(limited.status).toBe(429);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM usage_alert_events").first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });
});

describe("驗證", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["agent 不認得", { agent: "gemini" }],
    ["agent 不是字串", { agent: 1 }],
    ["threshold 不是 80／95", { threshold: 90 }],
    ["threshold 是字串", { threshold: "80" }],
    ["resetsAt 是字串", { resetsAt: "1900000000" }],
    ["resetsAt 是小數", { resetsAt: 1_900_000_000.5 }],
    ["resetsAt 是 0", { resetsAt: 0 }],
    ["resetsAt 是毫秒", { resetsAt: 1_900_000_000_000 }],
    ["多帶 workspace", { workspace: "weather-app" }],
    ["多帶 pane", { pane: "w2:p1" }],
    ["多帶 tab", { tab: "x" }],
  ];
  for (const [name, extra] of cases) {
    it(`${name} → 400`, async () => {
      const me = await member();
      const key = pairingKey();
      await registerWithUsage(me.accessToken, key);

      const response = await push(usage(key, extra));

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("invalid_request");
      expect(identityProviders.apnsCalls).toHaveLength(0);
    });
  }

  it("缺 agent、threshold 或 resetsAt → 400", async () => {
    const me = await member();
    const key = pairingKey();
    await registerWithUsage(me.accessToken, key);
    for (const field of ["agent", "threshold", "resetsAt"]) {
      const body: Record<string, unknown> = usage(key);
      delete body[field];
      expect((await push(body)).status).toBe(400);
    }
  });
});
