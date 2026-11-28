import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { api } from "./fakes";
import { blocked, DEVICE_ID, hashOf, member, OTHER_DEVICE_ID, pairingKey, pairingsOf, patchPairing, push, register } from "./push-kinds-support";

/// 配對的種類、名稱、圖示(purrdr.server#39、ADR-0016):註冊驗證以種類清單為準,讀與改配對的 API。

describe("註冊配對:種類以清單為準", () => {
  it("帶清單裡的種類(含新的 daily_limit_reached)可以註冊,GET 讀得到", async () => {
    const me = await member();
    const key = pairingKey();

    const registered = await register(me.accessToken, key, { deviceId: DEVICE_ID, kinds: ["done", "daily_limit_reached"] });

    expect(registered.status).toBe(201);
    const read = await pairingsOf(me.accessToken);
    expect(read.body.pairings).toEqual([{ keyHash: await hashOf(key), name: null, icon: null, kinds: ["done", "daily_limit_reached"] }]);
  });

  it("未知的種類、不是陣列都回 400,什麼都不存", async () => {
    const me = await member();
    await env.DB.prepare("UPDATE push_kinds SET disabled = 1 WHERE code = 'reminder'").run();

    for (const kinds of [["nope"], ["blocked", "nope"], "blocked", [1]]) {
      const response = await register(me.accessToken, pairingKey(), { kinds });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("invalid_request");
    }
    expect((await pairingsOf(me.accessToken)).body.pairings).toEqual([]);
  });

  it("帶到已停用的種類:略過該代號,其餘照存,仍回 201", async () => {
    const me = await member();
    const key = pairingKey();
    await env.DB.prepare("UPDATE push_kinds SET disabled = 1 WHERE code = 'reminder'").run();

    const response = await register(me.accessToken, key, { deviceId: DEVICE_ID, kinds: ["blocked", "reminder"] });

    expect(response.status).toBe(201);
    expect((await pairingsOf(me.accessToken)).body.pairings[0].kinds).toEqual(["blocked"]);
  });

  it("清單新增的種類不必改程式就能註冊", async () => {
    const me = await member();
    await env.DB.prepare(
      "INSERT INTO push_kinds (code, name_en, name_zh, description_en, description_zh, sort_order) VALUES ('future_kind', 'F', 'F', 'F', 'F', 99)",
    ).run();

    const response = await register(me.accessToken, pairingKey(), { kinds: ["future_kind"] });

    expect(response.status).toBe(201);
  });

  it("舊版 app 不帶 kinds、不帶名稱:維持只收「需要你」(加上本來就收得到的上限通知)", async () => {
    const me = await member();
    const key = pairingKey();

    expect((await register(me.accessToken, key)).status).toBe(201);

    const [pairing] = (await pairingsOf(me.accessToken)).body.pairings;
    expect(pairing.kinds).toEqual(["blocked", "daily_limit_reached"]);
    expect(pairing.name).toBeNull();
    expect(pairing.icon).toBeNull();
    // 舊的種類代號照舊能收、不在偏好內的照舊不送。
    expect((await push(blocked(key))).body.delivered).toBe(true);
    expect((await push({ key, workspace: "w", status: "done" })).body.delivered).toBe(false);
  });

  it("重新註冊(token 輪替)不帶 kinds 時保留原偏好,不帶名稱時保留原名稱", async () => {
    const me = await member();
    const key = pairingKey();
    await register(me.accessToken, key, { kinds: ["done"], name: "MacBook", icon: { symbol: "laptopcomputer", color: "#FF8800" } });

    await register(me.accessToken, key);

    const [pairing] = (await pairingsOf(me.accessToken)).body.pairings;
    expect(pairing.kinds).toEqual(["done"]);
    expect(pairing.name).toBe("MacBook");
    expect(pairing.icon).toEqual({ symbol: "laptopcomputer", color: "#FF8800" });
  });
});

describe("配對的名稱與圖示", () => {
  it("註冊時帶電腦名稱與圖示,GET 讀得到;名稱的控制字元清成空白、修頭尾", async () => {
    const me = await member();

    await register(me.accessToken, pairingKey(), { name: "  Ray's\tMac mini \n", icon: { symbol: "macmini.fill", color: "blue" } });

    const [pairing] = (await pairingsOf(me.accessToken)).body.pairings;
    expect(pairing.name).toBe("Ray's Mac mini");
    expect(pairing.icon).toEqual({ symbol: "macmini.fill", color: "blue" });
  });

  it("名稱太長、圖示格式不對都回 400", async () => {
    const me = await member();
    const bad: Record<string, unknown>[] = [
      { name: "x".repeat(65) },
      { name: 5 },
      { icon: { symbol: "has space", color: "blue" } },
      { icon: { symbol: "a".repeat(65), color: "blue" } },
      { icon: { symbol: "desktopcomputer", color: "#12345" } },
      { icon: { symbol: "desktopcomputer", color: "x".repeat(33) } },
      { icon: { symbol: "desktopcomputer" } },
      { icon: "desktopcomputer" },
    ];
    for (const extra of bad) {
      expect((await register(me.accessToken, pairingKey(), extra)).status).toBe(400);
    }
  });

  it("GET 帶 deviceId 只回那支裝置的配對,不帶回全部", async () => {
    const me = await member();
    await register(me.accessToken, pairingKey(), { deviceId: DEVICE_ID, name: "A" });
    await register(me.accessToken, pairingKey(), { deviceId: OTHER_DEVICE_ID, name: "B" });

    const onlyA = await pairingsOf(me.accessToken, DEVICE_ID);
    const all = await pairingsOf(me.accessToken);

    expect(onlyA.body.pairings.map((pairing: { name: string }) => pairing.name)).toEqual(["A"]);
    expect(all.body.pairings).toHaveLength(2);
    expect((await pairingsOf(me.accessToken, "not-a-uuid")).status).toBe(400);
  });

  it("只看得到自己的配對,需要會員權杖", async () => {
    const me = await member("apple-user-1");
    const other = await member("apple-user-2");
    await register(me.accessToken, pairingKey(), { name: "mine" });

    expect((await pairingsOf(other.accessToken)).body.pairings).toEqual([]);
    expect((await api("GET", "/v1/members/me/push-pairings")).status).toBe(401);
  });
});

describe("PATCH /v1/members/me/push-pairings/{keyHash}", () => {
  it("改種類、名稱、圖示,回更新後的那一組;沒帶的欄位不動", async () => {
    const me = await member();
    const key = pairingKey();
    const keyHash = await hashOf(key);
    await register(me.accessToken, key, { name: "Old", icon: { symbol: "desktopcomputer", color: "red" } });

    const renamed = await patchPairing(me.accessToken, keyHash, { name: "New" });
    const changed = await patchPairing(me.accessToken, keyHash, { kinds: ["done", "stuck"], icon: { symbol: "server.rack", color: "#00AAFF" } });

    expect(renamed.status).toBe(200);
    expect(renamed.body.pairing).toEqual({ keyHash, name: "New", icon: { symbol: "desktopcomputer", color: "red" }, kinds: ["blocked", "daily_limit_reached"] });
    expect(changed.body.pairing).toEqual({ keyHash, name: "New", icon: { symbol: "server.rack", color: "#00AAFF" }, kinds: ["done", "stuck"] });
    // 改過的偏好真的影響推播。
    expect((await push({ key, workspace: "w", status: "done" })).body.delivered).toBe(true);
    expect((await push(blocked(key))).body.delivered).toBe(false);
  });

  it("name 或 icon 帶 null 就清掉", async () => {
    const me = await member();
    const key = pairingKey();
    await register(me.accessToken, key, { name: "Old", icon: { symbol: "desktopcomputer", color: "red" } });

    const cleared = await patchPairing(me.accessToken, await hashOf(key), { name: null, icon: null });

    expect(cleared.body.pairing.name).toBeNull();
    expect(cleared.body.pairing.icon).toBeNull();
  });

  it("未知或已停用的種類 400;壞的名稱、圖示 400;什麼都沒動", async () => {
    const me = await member();
    const key = pairingKey();
    const keyHash = await hashOf(key);
    await register(me.accessToken, key, { name: "Keep" });
    await env.DB.prepare("UPDATE push_kinds SET disabled = 1 WHERE code = 'done'").run();

    for (const body of [{ kinds: ["nope"] }, { kinds: ["done"] }, { name: "x".repeat(65) }, { icon: { symbol: "bad symbol", color: "red" } }, { kinds: ["blocked"], name: 5 }]) {
      expect((await patchPairing(me.accessToken, keyHash, body)).status).toBe(400);
    }
    expect((await pairingsOf(me.accessToken)).body.pairings[0]).toMatchObject({ name: "Keep", kinds: ["blocked", "daily_limit_reached"] });
  });

  it("只改得了自己的配對:別人的與不存在的都回 404", async () => {
    const me = await member("apple-user-1");
    const other = await member("apple-user-2");
    const key = pairingKey();
    await register(me.accessToken, key, { name: "Mine" });

    const foreign = await patchPairing(other.accessToken, await hashOf(key), { name: "Hacked" });
    const missing = await patchPairing(me.accessToken, "0".repeat(64), { name: "x" });

    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect((await pairingsOf(me.accessToken)).body.pairings[0].name).toBe("Mine");
    expect((await api("PATCH", `/v1/members/me/push-pairings/${await hashOf(key)}`, { body: { name: "x" } })).status).toBe(401);
  });
});
