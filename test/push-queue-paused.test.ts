import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { api, identityProviders } from "./fakes";
import { member, pairingKey, push, register } from "./push-kinds-support";

/// 「佇列暫停」推播(purrdr.server#41、purrdr.ios#704):主機端偵測到 Agent 佇列暫停時送 `status: "queue_paused"`。

const paused = (key: string, extra: Record<string, unknown> = {}) => ({ key, workspace: "weather-app", status: "queue_paused", pane: "w2:p1", tab: "Claude", ...extra });

async function pairedWith(kinds: string[]) {
  const me = await member();
  const key = pairingKey();
  await register(me.accessToken, key, { kinds });
  return { me, key };
}

async function sentToday(accessToken: string): Promise<number> {
  const response = await api("GET", "/v1/members/me", { accessToken });
  return response.body.member.pushUsage.sent;
}

describe("queue_paused 種類", () => {
  it("在種類清單裡:預設開、只有 https、需主機服務 0.16.0", async () => {
    const me = await member();
    const response = await api("GET", "/v1/push-kinds", { accessToken: me.accessToken });
    const kind = response.body.kinds.find((item: { code: string }) => item.code === "queue_paused");
    expect(kind).toMatchObject({ defaultOn: true, transports: ["https"], minServiceVersion: "0.16.0", minPluginVersion: null });
  });
});

describe("POST /v1/push status queue_paused", () => {
  it("開著這個種類:送出,標題 workspace、loc-args 帶 Tab 名稱、根層帶 pane 與 status", async () => {
    const { key } = await pairedWith(["queue_paused"]);

    const sent = await push(paused(key));

    expect(sent.status).toBe(200);
    expect(sent.body).toEqual({ delivered: true });
    const payload = identityProviders.apnsCalls[0]!.payload;
    expect(payload.aps.alert).toEqual({ title: "weather-app", "loc-key": "Queue paused in %@.", "loc-args": ["Claude"] });
    expect(payload.pane).toBe("w2:p1");
    expect(payload.status).toBe("queue_paused");
  });

  it("沒帶 tab:用不含參數的後備 loc-key", async () => {
    const { key } = await pairedWith(["queue_paused"]);

    await push({ key, workspace: "weather-app", status: "queue_paused", pane: "w2:p1" });

    expect(identityProviders.apnsCalls[0]!.payload.aps.alert).toEqual({ title: "weather-app", "loc-key": "Queue paused." });
  });

  it("沒開這個種類:不送,回 delivered false", async () => {
    const { key } = await pairedWith(["blocked"]);

    const sent = await push(paused(key));

    expect(sent.body).toEqual({ delivered: false });
    expect(identityProviders.apnsCalls).toHaveLength(0);
  });

  it("沒帶 pane:400(去重與點擊開聊天都靠 pane)", async () => {
    const { key } = await pairedWith(["queue_paused"]);

    const sent = await push({ key, workspace: "weather-app", status: "queue_paused" });

    expect(sent.status).toBe(400);
  });

  it("同一個 pane 的同一次暫停只送一次;不同 pane 各自送", async () => {
    const { key } = await pairedWith(["queue_paused"]);

    const first = await push(paused(key));
    const again = await push(paused(key));
    const other = await push(paused(key, { pane: "w2:p2" }));

    expect([first.body, again.body, other.body]).toEqual([{ delivered: true }, { delivered: false }, { delivered: true }]);
    expect(identityProviders.apnsCalls).toHaveLength(2);
  });

  it("去重窗口過了(恢復後再暫停)會再送", async () => {
    const { key } = await pairedWith(["queue_paused"]);
    await push(paused(key));
    await env.DB.prepare("UPDATE queue_paused_events SET sent_at = sent_at - 6 * 60 * 1000").run();

    const again = await push(paused(key));

    expect(again.body).toEqual({ delivered: true });
  });

  it("被去重擋下的不計入每日上限", async () => {
    const { me, key } = await pairedWith(["queue_paused"]);
    await push(paused(key));
    await push(paused(key));

    expect(await sentToday(me.accessToken)).toBe(1);
  });

  it("APNs 沒收下:去重登記與每日預留都還回去,重送可以再試", async () => {
    const { me, key } = await pairedWith(["queue_paused"]);
    identityProviders.apnsReplies.push({ status: 500, reason: "InternalServerError" });

    const failed = await push(paused(key));
    const retried = await push(paused(key));

    expect(failed.status).toBe(502);
    expect(retried.body).toEqual({ delivered: true });
    expect(await sentToday(me.accessToken)).toBe(1);
  });
});
