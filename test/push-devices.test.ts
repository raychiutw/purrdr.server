import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DAY, submitTransaction } from "./app-store";
import { api, identityProviders, signInWithApple } from "./fakes";

/// 通知裝置(purrdr.server#5):會員看得到哪些裝置會收到通知，可以遠端關閉或改名，不必拿到那支裝置。

const PHONE_TOKEN = "a1".repeat(32);
const TABLET_TOKEN = "b2".repeat(32);
const PHONE_ID = "5f0c7d2e-1111-4a5b-9c3d-000000000001";
const TABLET_ID = "5f0c7d2e-2222-4a5b-9c3d-000000000002";

async function subscribedMember(subject = "apple-user-1") {
  const signIn = await signInWithApple(subject);
  const me = { accessToken: signIn.body.accessToken as string, id: signIn.body.member.id as string };
  const submit = await submitTransaction(me.accessToken, { appAccountToken: me.id, originalTransactionId: `original-${subject}` });
  expect(submit.status).toBe(200);
  return me;
}

function pairingKey(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashOf(key: string): Promise<string> {
  const bytes = new Uint8Array(key.match(/../g)!.map((pair) => parseInt(pair, 16)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

type Device = { deviceToken: string; deviceId?: string; deviceName?: string; model?: string };
const phone: Device = { deviceToken: PHONE_TOKEN, deviceId: PHONE_ID, deviceName: "Ray 的 iPhone", model: "iPhone" };
const tablet: Device = { deviceToken: TABLET_TOKEN, deviceId: TABLET_ID, deviceName: "Ray 的 iPad", model: "iPad" };

/// 這支裝置在一台主機開通知：註冊一組配對，回傳主機上存的配對密鑰。
async function enable(accessToken: string, device: Device, extra: Record<string, unknown> = {}): Promise<string> {
  const key = pairingKey();
  const registered = await api("POST", "/v1/members/me/push-pairings", {
    accessToken,
    body: { keyHash: await hashOf(key), platform: "apns", environment: "production", ...device, ...extra },
  });
  expect(registered.status).toBe(201);
  return key;
}

function devices(accessToken: string, currentDeviceId?: string) {
  const query = currentDeviceId === undefined ? "" : `?currentDeviceId=${currentDeviceId}`;
  return api("GET", `/v1/members/me/push-devices${query}`, { accessToken });
}

/// 訂閱已到期、手機在一台主機開過通知的會員。
async function expiredMemberWithPhone() {
  const signIn = await signInWithApple("apple-user-expired");
  const me = { accessToken: signIn.body.accessToken as string, id: signIn.body.member.id as string };
  const purchaseDate = Date.now() - 40 * DAY;
  await submitTransaction(me.accessToken, { appAccountToken: me.id, purchaseDate, expiresDate: purchaseDate + 30 * DAY });
  await env.DB.prepare(
    `INSERT INTO push_pairings (key_hash, member_id, platform, device_token, environment, device_id, created_at, updated_at)
     VALUES (?, ?, 'apns', ?, 'production', ?, 0, 0)`,
  )
    .bind(await hashOf(pairingKey()), me.id, PHONE_TOKEN, PHONE_ID)
    .run();
  return me;
}

function push(key: string) {
  return api("POST", "/v1/push", { body: { key, workspace: "weather-app", status: "blocked" } });
}

describe("通知裝置清單", () => {
  it("同一支裝置在多台主機的配對歸成一台裝置，列出名稱、型號、主機數與最後註冊時間", async () => {
    const me = await subscribedMember();
    await enable(me.accessToken, phone);
    await enable(me.accessToken, phone);
    await enable(me.accessToken, tablet);

    const listed = await devices(me.accessToken, PHONE_ID);

    expect(listed.status).toBe(200);
    const byId = Object.fromEntries(listed.body.devices.map((device: { deviceId: string }) => [device.deviceId, device]));
    expect(listed.body.devices).toHaveLength(2);
    expect(byId[PHONE_ID]).toMatchObject({ name: "Ray 的 iPhone", model: "iPhone", hostCount: 2, current: true });
    expect(byId[TABLET_ID]).toMatchObject({ name: "Ray 的 iPad", model: "iPad", hostCount: 1, current: false });
    expect(typeof byId[PHONE_ID].lastRegisteredAt).toBe("number");
  });

  it("清單不含 device token、配對密鑰與它的雜湊", async () => {
    const me = await subscribedMember();
    const key = await enable(me.accessToken, phone);
    const legacyKey = await enable(me.accessToken, { deviceToken: TABLET_TOKEN });

    const listed = JSON.stringify((await devices(me.accessToken)).body);

    for (const secret of [PHONE_TOKEN, TABLET_TOKEN, key, legacyKey, await hashOf(key), await hashOf(legacyKey)]) {
      expect(listed).not.toContain(secret);
    }
  });

  it("舊版 app 沒帶 deviceId 的配對以 device token 歸類，名稱為 null(未命名裝置)", async () => {
    const me = await subscribedMember();
    await enable(me.accessToken, { deviceToken: PHONE_TOKEN });
    await enable(me.accessToken, { deviceToken: PHONE_TOKEN });
    await enable(me.accessToken, { deviceToken: TABLET_TOKEN });

    const listed = (await devices(me.accessToken)).body.devices;

    expect(listed).toHaveLength(2);
    expect(listed.map((device: { hostCount: number }) => device.hostCount).sort()).toEqual([1, 2]);
    for (const device of listed) {
      expect(device).toMatchObject({ name: null, model: null, current: false });
    }
  });

  it("只列自己的裝置", async () => {
    const me = await subscribedMember("apple-user-1");
    const other = await subscribedMember("apple-user-2");
    await enable(other.accessToken, phone);

    expect((await devices(me.accessToken)).body.devices).toEqual([]);
  });

  it("訂閱到期後仍看得到清單，也能關閉裝置(遺失的手機)", async () => {
    const me = await expiredMemberWithPhone();

    const listed = await devices(me.accessToken);
    const revoked = await revokeDevice(me.accessToken, PHONE_ID);

    expect(listed.status).toBe(200);
    expect(listed.body.devices).toEqual([expect.objectContaining({ deviceId: PHONE_ID, hostCount: 1 })]);
    expect(revoked.status).toBe(204);
  });

  it("沒帶存取權杖時拒絕", async () => {
    expect((await api("GET", "/v1/members/me/push-devices")).status).toBe(401);
  });
});

function revokeDevice(accessToken: string, deviceId: string) {
  return api("DELETE", `/v1/members/me/push-devices/${deviceId}`, { accessToken });
}

describe("遠端關閉裝置", () => {
  it("撤銷這支裝置在所有主機的配對：之後推播回 410 pairing_revoked,另一支裝置照常收到", async () => {
    const me = await subscribedMember();
    const phoneOnMacMini = await enable(me.accessToken, phone);
    const phoneOnPc = await enable(me.accessToken, phone);
    const tabletOnMacMini = await enable(me.accessToken, tablet);

    const revoked = await revokeDevice(me.accessToken, PHONE_ID);

    expect(revoked.status).toBe(204);
    for (const key of [phoneOnMacMini, phoneOnPc]) {
      const sent = await push(key);
      expect(sent.status).toBe(410);
      expect(sent.body.error.code).toBe("pairing_revoked");
    }
    expect((await push(tabletOnMacMini)).status).toBe(200);
    expect(identityProviders.apnsCalls.map((call) => call.deviceToken)).toEqual([TABLET_TOKEN]);
    expect((await devices(me.accessToken)).body.devices.map((device: { deviceId: string }) => device.deviceId)).toEqual([TABLET_ID]);
  });

  it("舊版 app 的未命名裝置也能以清單上的 deviceId 撤銷", async () => {
    const me = await subscribedMember();
    const legacyKey = await enable(me.accessToken, { deviceToken: PHONE_TOKEN });
    const [legacy] = (await devices(me.accessToken)).body.devices;

    expect((await revokeDevice(me.accessToken, legacy.deviceId)).status).toBe(204);

    expect((await push(legacyKey)).status).toBe(410);
  });

  it("被撤銷的裝置重新開通知(同一組密鑰再註冊)後又收得到", async () => {
    const me = await subscribedMember();
    const key = await enable(me.accessToken, phone);
    await revokeDevice(me.accessToken, PHONE_ID);

    const registered = await api("POST", "/v1/members/me/push-pairings", {
      accessToken: me.accessToken,
      body: { keyHash: await hashOf(key), platform: "apns", environment: "production", ...phone },
    });

    expect(registered.status).toBe(201);
    expect((await push(key)).status).toBe(200);
  });

  it("不能撤銷別人的裝置(404 device_not_found),對方照常收到", async () => {
    const me = await subscribedMember("apple-user-1");
    const other = await subscribedMember("apple-user-2");
    const othersKey = await enable(other.accessToken, phone);

    const revoked = await revokeDevice(me.accessToken, PHONE_ID);

    expect(revoked.status).toBe(404);
    expect(revoked.body.error.code).toBe("device_not_found");
    expect((await push(othersKey)).status).toBe(200);
  });

  it("沒有配對的裝置回 404 device_not_found", async () => {
    const me = await subscribedMember();
    const revoked = await revokeDevice(me.accessToken, PHONE_ID);
    expect(revoked.status).toBe(404);
    expect(revoked.body.error.code).toBe("device_not_found");
  });
});

function rename(accessToken: string, deviceId: string, name: unknown) {
  return api("PATCH", `/v1/members/me/push-devices/${deviceId}`, { accessToken, body: { name } });
}

describe("裝置改名", () => {
  it("改名後清單顯示新名稱，回傳改好的裝置；之後再開一台主機帶預設名稱也不會蓋掉", async () => {
    const me = await subscribedMember();
    await enable(me.accessToken, phone);

    const renamed = await rename(me.accessToken, PHONE_ID, "  舊手機  ");
    await enable(me.accessToken, phone);

    expect(renamed.status).toBe(200);
    expect(renamed.body.device).toMatchObject({ deviceId: PHONE_ID, name: "舊手機", hostCount: 1 });
    expect((await devices(me.accessToken)).body.devices[0]).toMatchObject({ name: "舊手機", hostCount: 2 });
  });

  it("舊版 app 的未命名裝置也能改名", async () => {
    const me = await subscribedMember();
    await enable(me.accessToken, { deviceToken: PHONE_TOKEN });
    const [legacy] = (await devices(me.accessToken)).body.devices;

    expect((await rename(me.accessToken, legacy.deviceId, "書房 iPad")).status).toBe(200);

    expect((await devices(me.accessToken)).body.devices).toEqual([expect.objectContaining({ deviceId: legacy.deviceId, name: "書房 iPad" })]);
  });

  it.each([
    ["空白", "   "],
    ["太長", "名".repeat(65)],
    ["不是字串", 42],
  ])("名稱%s時回 400 invalid_request", async (_, name) => {
    const me = await subscribedMember();
    await enable(me.accessToken, phone);
    const renamed = await rename(me.accessToken, PHONE_ID, name);
    expect(renamed.status).toBe(400);
    expect(renamed.body.error.code).toBe("invalid_request");
  });

  it("不能改別人的裝置(404 device_not_found)", async () => {
    const me = await subscribedMember("apple-user-1");
    const other = await subscribedMember("apple-user-2");
    await enable(other.accessToken, phone);

    const renamed = await rename(me.accessToken, PHONE_ID, "我的");

    expect(renamed.status).toBe(404);
    expect(renamed.body.error.code).toBe("device_not_found");
    expect((await devices(other.accessToken)).body.devices[0].name).toBe("Ray 的 iPhone");
  });

  it("訂閱到期後不能改名(403 subscription_required)", async () => {
    const me = await expiredMemberWithPhone();
    const renamed = await rename(me.accessToken, PHONE_ID, "我的");
    expect(renamed.status).toBe(403);
    expect(renamed.body.error.code).toBe("subscription_required");
  });

  it.each([
    ["C1 控制字元", "手機\u0085"],
    ["bidi 覆寫", "\u202Eenohpi"],
    ["零寬字元", "手\u200B機"],
    ["行分隔", "手機\u2028第二行"],
    ["段落分隔", "手機\u2029第二段"],
  ])("名稱含%s時回 400 invalid_request", async (_, name) => {
    const me = await subscribedMember();
    await enable(me.accessToken, phone);
    expect((await rename(me.accessToken, PHONE_ID, name)).status).toBe(400);
  });

  it("舊版 app 的裝置改名後，仍能再改名與撤銷", async () => {
    const me = await subscribedMember();
    const legacyKey = await enable(me.accessToken, { deviceToken: PHONE_TOKEN });
    const [legacy] = (await devices(me.accessToken)).body.devices;
    await rename(me.accessToken, legacy.deviceId, "書房 iPad");

    expect((await rename(me.accessToken, legacy.deviceId, "客廳 iPad")).status).toBe(200);
    expect((await revokeDevice(me.accessToken, legacy.deviceId)).status).toBe(204);
    expect((await push(legacyKey)).status).toBe(410);
  });

  it("舊版 app 的裝置改名後再開一台主機，清單仍是同一台裝置", async () => {
    const me = await subscribedMember();
    await enable(me.accessToken, { deviceToken: PHONE_TOKEN });
    const [legacy] = (await devices(me.accessToken)).body.devices;
    await rename(me.accessToken, legacy.deviceId, "書房 iPad");

    await enable(me.accessToken, { deviceToken: PHONE_TOKEN });

    expect((await devices(me.accessToken)).body.devices).toEqual([
      expect.objectContaining({ deviceId: legacy.deviceId, name: "書房 iPad", hostCount: 2 }),
    ]);
  });
});

describe("註冊配對帶裝置欄位", () => {
  it.each([
    ["deviceId 不是 UUID", { deviceId: "legacy-abc" }],
    ["型號不認得", { model: "Pixel" }],
    ["名稱空白", { deviceName: " " }],
  ])("%s時回 400 invalid_request,什麼都不存", async (_, extra) => {
    const me = await subscribedMember();
    const registered = await api("POST", "/v1/members/me/push-pairings", {
      accessToken: me.accessToken,
      body: { keyHash: await hashOf(pairingKey()), platform: "apns", environment: "production", ...phone, ...extra },
    });
    expect(registered.status).toBe(400);
    expect(registered.body.error.code).toBe("invalid_request");
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM push_pairings").first<{ count: number }>())!.count).toBe(0);
  });

  it("app 的 UUID 是大寫也歸成同一台裝置", async () => {
    const me = await subscribedMember();
    await enable(me.accessToken, phone);
    await enable(me.accessToken, { ...phone, deviceId: PHONE_ID.toUpperCase() });

    expect((await devices(me.accessToken, PHONE_ID.toUpperCase())).body.devices).toEqual([
      expect.objectContaining({ deviceId: PHONE_ID, hostCount: 2, current: true }),
    ]);
  });

  it("改名回應的 current 依 currentDeviceId 標出呼叫者自己", async () => {
    const me = await subscribedMember();
    await enable(me.accessToken, phone);
    const renamed = await api("PATCH", `/v1/members/me/push-devices/${PHONE_ID}?currentDeviceId=${PHONE_ID}`, {
      accessToken: me.accessToken,
      body: { name: "我的" },
    });
    expect(renamed.body.device.current).toBe(true);
  });
});

describe("遠端關閉紀錄的清理", () => {
  it("被關閉的密鑰第一次推播回 410 後就清掉紀錄，之後回 404 pairing_not_found", async () => {
    const me = await subscribedMember();
    const key = await enable(me.accessToken, phone);
    await revokeDevice(me.accessToken, PHONE_ID);

    expect((await push(key)).status).toBe(410);
    const again = await push(key);

    expect(again.status).toBe(404);
    expect(again.body.error.code).toBe("pairing_not_found");
  });

  it("關閉裝置時順手刪掉 90 天前的關閉紀錄", async () => {
    const me = await subscribedMember();
    const staleKey = pairingKey();
    const recentKey = pairingKey();
    for (const [key, revokedAt] of [[staleKey, Date.now() - 91 * DAY], [recentKey, Date.now() - 89 * DAY]] as const) {
      await env.DB.prepare("INSERT INTO revoked_push_pairings (key_hash, member_id, revoked_at) VALUES (?, ?, ?)").bind(await hashOf(key), me.id, revokedAt).run();
    }
    await enable(me.accessToken, phone);

    await revokeDevice(me.accessToken, PHONE_ID);

    expect((await push(staleKey)).status).toBe(404);
    expect((await push(recentKey)).status).toBe(410);
  });
});
