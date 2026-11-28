import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { api, identityProviders } from "./fakes";
import { blocked, DEVICE_ID, hashOf, member, OTHER_DEVICE_ID, pairingKey, patchPairing, push, register } from "./push-kinds-support";

/// 推播副標題、通知裝置的主機清單、「今日已達上限」的種類開關與每組配對登記(purrdr.server#39、ADR-0016)。

const LIMIT_NOTICE_EVENT = "daily_limit_reached";

async function setLimit(memberId: string, limit: number) {
  await env.DB.prepare("UPDATE members SET daily_push_limit = ? WHERE id = ?").bind(limit, memberId).run();
}

const noticesSent = () => identityProviders.apnsCalls.filter((call) => call.payload.event === LIMIT_NOTICE_EVENT);

describe("推播副標題", () => {
  it("帶這組配對的電腦名稱;沒有名稱的舊配對不帶", async () => {
    const me = await member();
    const named = pairingKey();
    const legacy = pairingKey();
    await register(me.accessToken, named, { name: "Mac mini", kinds: ["blocked", "host_service"] });
    await register(me.accessToken, legacy);

    await push(blocked(named));
    await push(blocked(legacy));
    await push({ key: named, event: "host_service_update_available" });

    const [status, old, hostService] = identityProviders.apnsCalls.map((call) => call.payload.aps.alert);
    expect(status.subtitle).toBe("Mac mini");
    expect(status.title).toBe("weather-app");
    expect(old).not.toHaveProperty("subtitle");
    expect(hostService.subtitle).toBe("Mac mini");
  });

  it("改名後下一則推播就用新名稱", async () => {
    const me = await member();
    const key = pairingKey();
    await register(me.accessToken, key, { name: "Old" });
    await patchPairing(me.accessToken, await hashOf(key), { name: "New" });

    await push(blocked(key));

    expect(identityProviders.apnsCalls[0]!.payload.aps.alert.subtitle).toBe("New");
  });
});

describe("GET /v1/members/me/push-devices 的 hosts", () => {
  it("每支裝置帶開著的主機(keyHash、名稱、圖示),沒有名稱或圖示的是 null", async () => {
    const me = await member();
    const keyA = pairingKey();
    const keyB = pairingKey();
    const keyC = pairingKey();
    await register(me.accessToken, keyA, { deviceId: DEVICE_ID, deviceName: "iPhone", name: "Mac mini", icon: { symbol: "macmini.fill", color: "blue" } });
    await register(me.accessToken, keyB, { deviceId: DEVICE_ID });
    await register(me.accessToken, keyC, { deviceId: OTHER_DEVICE_ID, name: "VPS" });

    const response = await api("GET", `/v1/members/me/push-devices?currentDeviceId=${DEVICE_ID}`, { accessToken: me.accessToken });

    const byId = Object.fromEntries(response.body.devices.map((device: { deviceId: string }) => [device.deviceId, device]));
    const hostsOfPhone = byId[DEVICE_ID].hosts;
    expect(byId[DEVICE_ID].hostCount).toBe(2);
    expect(hostsOfPhone).toHaveLength(2);
    expect(hostsOfPhone).toContainEqual({ keyHash: await hashOf(keyA), name: "Mac mini", icon: { symbol: "macmini.fill", color: "blue" } });
    expect(hostsOfPhone).toContainEqual({ keyHash: await hashOf(keyB), name: null, icon: null });
    expect(byId[OTHER_DEVICE_ID].hosts).toEqual([{ keyHash: await hashOf(keyC), name: "VPS", icon: null }]);
  });
});

describe("每日上限已達:種類開關", () => {
  it("開著(預設)就送;關掉就不送、也不登記,之後再開下一次被擋時補收", async () => {
    const me = await member();
    await setLimit(me.id, 1);
    const key = pairingKey();
    const keyHash = await hashOf(key);
    await register(me.accessToken, key, { kinds: ["blocked"] });

    await push(blocked(key));
    expect((await push(blocked(key))).status).toBe(429);
    expect(noticesSent()).toHaveLength(0);

    await patchPairing(me.accessToken, keyHash, { kinds: ["blocked", "daily_limit_reached"] });
    expect((await push(blocked(key))).status).toBe(429);
    expect(noticesSent()).toHaveLength(1);
  });

  it("訊息仍然不計入每日則數", async () => {
    const me = await member();
    await setLimit(me.id, 2);
    const key = pairingKey();
    await register(me.accessToken, key, { kinds: ["blocked", "daily_limit_reached"] });

    await push(blocked(key));
    await push(blocked(key));

    expect(noticesSent()).toHaveLength(1);
    const usage = await api("GET", "/v1/members/me", { accessToken: me.accessToken });
    expect(usage.body.member.pushUsage.sent).toBe(2);
  });
});

describe("每日上限已達:每組配對各自登記", () => {
  it("A 配對收過今天的通知,B 配對被擋下時仍會收到自己的一則;各自一天只一次", async () => {
    const me = await member();
    await setLimit(me.id, 1);
    const keyA = pairingKey();
    const keyB = pairingKey();
    await register(me.accessToken, keyA, { name: "A" });
    await register(me.accessToken, keyB, { name: "B" });

    await push(blocked(keyA));
    for (let index = 0; index < 3; index += 1) {
      expect((await push(blocked(keyA))).status).toBe(429);
      expect((await push(blocked(keyB))).status).toBe(429);
    }

    const notices = noticesSent();
    const hashB = await hashOf(keyB);
    expect(notices.map((call) => call.payload.pairing).sort()).toEqual([await hashOf(keyA), hashB].sort());
    expect(notices.find((call) => call.payload.pairing === hashB)!.payload.aps.alert.subtitle).toBe("B");
  });

  it("隔天(換 UTC 日)每組配對可以再收一次", async () => {
    const me = await member();
    await setLimit(me.id, 1);
    const key = pairingKey();
    await register(me.accessToken, key);
    await push(blocked(key));
    expect(noticesSent()).toHaveLength(1);

    // 模擬「昨天已通知過」。
    await env.DB.prepare("UPDATE push_pairings SET limit_notified_day = '2000-01-01'").run();
    await env.DB.prepare("DELETE FROM push_daily_usage").run();
    await push(blocked(key));
    await push(blocked(key));

    expect(noticesSent()).toHaveLength(2);
  });
});
