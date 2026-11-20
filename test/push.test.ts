import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { DAY, submitTransaction } from "./app-store";
import { api, identityProviders, signInWithApple } from "./fakes";

/// 推播(#29、ADR-0004):app 註冊推播配對(只送配對密鑰的雜湊),主機外掛帶密鑰呼叫 /v1/push,
/// 後台確認會員有有效訂閱後轉給 APNs(這裡是 test/fakes.ts 的假 APNs 端點)。

const DEVICE_TOKEN = "a1".repeat(32);

async function member(subject = "apple-user-1") {
  const signIn = await signInWithApple(subject);
  return { accessToken: signIn.body.accessToken as string, id: signIn.body.member.id as string };
}

async function subscribedMember(subject = "apple-user-1") {
  const me = await member(subject);
  const submit = await submitTransaction(me.accessToken, { appAccountToken: me.id, originalTransactionId: `original-${subject}` });
  expect(submit.status).toBe(200);
  return me;
}

/// 配對密鑰：32 bytes 亂數的小寫 hex。
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

const blocked = (key: string) => ({ key, workspace: "weather-app", status: "blocked", pane: "w2:p1" });

async function pairingRows() {
  return (await env.DB.prepare("SELECT * FROM push_pairings").all<Record<string, unknown>>()).results;
}

describe("註冊推播配對", () => {
  it("有訂閱的會員註冊後，後台只存密鑰的雜湊，不存密鑰本身", async () => {
    const me = await subscribedMember();
    const key = pairingKey();

    const registered = await register(me.accessToken, key);

    expect(registered.status).toBe(201);
    const rows = await pairingRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key_hash).toBe(await hashOf(key));
    expect(JSON.stringify(rows)).not.toContain(key);
  });

  it("沒有有效訂閱時拒絕(403 subscription_required),什麼都不存", async () => {
    const me = await member();

    const registered = await register(me.accessToken, pairingKey());

    expect(registered.status).toBe(403);
    expect(registered.body.error.code).toBe("subscription_required");
    expect(await pairingRows()).toHaveLength(0);
  });

  it("沒帶存取權杖時拒絕", async () => {
    const registered = await api("POST", "/v1/members/me/push-pairings", {
      body: { keyHash: "0".repeat(64), platform: "apns", deviceToken: DEVICE_TOKEN, environment: "production" },
    });
    expect(registered.status).toBe(401);
  });

  it.each([
    ["雜湊不是 64 位 hex", { keyHash: "xyz" }],
    ["平台不認得", { platform: "fcm" }],
    ["device token 不是 hex", { deviceToken: "not-a-token" }],
    ["環境不認得", { environment: "development" }],
  ])("%s時回 400 invalid_request", async (_, extra) => {
    const me = await subscribedMember();
    const registered = await register(me.accessToken, pairingKey(), extra);
    expect(registered.status).toBe(400);
    expect(registered.body.error.code).toBe("invalid_request");
  });

  it("同一組密鑰再註冊一次(APNs token 輪替)會更新 device token,不會多一筆", async () => {
    const me = await subscribedMember();
    const key = pairingKey();
    await register(me.accessToken, key);

    const again = await register(me.accessToken, key, { deviceToken: "b2".repeat(32) });

    expect(again.status).toBe(201);
    const rows = await pairingRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.device_token).toBe("b2".repeat(32));
  });

  it("密鑰雜湊已屬於另一個會員時拒絕(409 pairing_in_use)", async () => {
    const key = pairingKey();
    await register((await subscribedMember("apple-user-1")).accessToken, key);

    const other = await register((await subscribedMember("apple-user-2")).accessToken, key);

    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe("pairing_in_use");
  });

  it("撤銷後這組密鑰就不能再推播", async () => {
    const me = await subscribedMember();
    const key = pairingKey();
    await register(me.accessToken, key);

    const revoked = await api("DELETE", `/v1/members/me/push-pairings/${await hashOf(key)}`, { accessToken: me.accessToken });

    expect(revoked.status).toBe(204);
    expect((await push(blocked(key))).status).toBe(404);
    expect(identityProviders.apnsCalls).toHaveLength(0);
  });

  it("只能撤銷自己的配對", async () => {
    const key = pairingKey();
    await register((await subscribedMember("apple-user-1")).accessToken, key);
    const other = await subscribedMember("apple-user-2");

    const revoked = await api("DELETE", `/v1/members/me/push-pairings/${await hashOf(key)}`, { accessToken: other.accessToken });

    expect(revoked.status).toBe(204);
    expect(await pairingRows()).toHaveLength(1);
  });

  it("撤銷配對不需要有效訂閱(到期後仍能關閉推播)", async () => {
    const me = await member();
    const revoked = await api("DELETE", `/v1/members/me/push-pairings/${"0".repeat(64)}`, { accessToken: me.accessToken });
    expect(revoked.status).toBe(204);
  });

  it("刪除會員時一併刪除推播配對", async () => {
    const me = await subscribedMember();
    await register(me.accessToken, pairingKey());

    expect((await api("DELETE", "/v1/members/me", { accessToken: me.accessToken })).status).toBe(204);

    expect(await pairingRows()).toHaveLength(0);
  });
});

describe("主機外掛送推播", () => {
  it("有效的密鑰與訂閱:轉給 APNs,payload 只有 workspace 名稱與狀態(加上點通知要用的配對與 pane)", async () => {
    const me = await subscribedMember();
    const key = pairingKey();
    await register(me.accessToken, key);

    const sent = await push(blocked(key));

    expect(sent.status).toBe(200);
    expect(identityProviders.apnsCalls).toHaveLength(1);
    const call = identityProviders.apnsCalls[0]!;
    expect(call.environment).toBe("production");
    expect(call.deviceToken).toBe(DEVICE_TOKEN);
    expect(call.providerTokenValid).toBe(true);
    expect(call.headers["apns-topic"]).toBe("com.raychiu.purrdr");
    expect(call.headers["apns-push-type"]).toBe("alert");
    expect(call.headers["apns-priority"]).toBe("10");
    expect(call.payload).toEqual({
      aps: {
        alert: { title: "weather-app", "loc-key": "An agent needs you." },
        sound: "default",
        "interruption-level": "time-sensitive",
        category: "AGENT_BLOCKED",
      },
      pairing: await hashOf(key),
      pane: "w2:p1",
      status: "blocked",
    });
  });

  it("sandbox 的配對送到 APNs 的 sandbox 端點", async () => {
    const me = await subscribedMember();
    const key = pairingKey();
    await register(me.accessToken, key, { environment: "sandbox" });

    expect((await push(blocked(key))).status).toBe(200);

    expect(identityProviders.apnsCalls[0]!.environment).toBe("sandbox");
  });

  it("請求裡多帶任何欄位(例如對話內容)一律拒絕，不轉給 APNs", async () => {
    const me = await subscribedMember();
    const key = pairingKey();
    await register(me.accessToken, key);

    const sent = await push({ ...blocked(key), body: "rm -rf ~/secret-project" });

    expect(sent.status).toBe(400);
    expect(sent.body.error.code).toBe("invalid_request");
    expect(identityProviders.apnsCalls).toHaveLength(0);
  });

  it.each([
    ["狀態不認得", { status: "running" }],
    ["workspace 名稱是空的", { workspace: "" }],
    ["workspace 名稱太長", { workspace: "w".repeat(101) }],
    ["pane id 形狀不對", { pane: "w1:p1; echo" }],
    ["密鑰不是 64 位 hex", { key: "short" }],
  ])("%s時回 400", async (_, extra) => {
    const me = await subscribedMember();
    const key = pairingKey();
    await register(me.accessToken, key);

    const sent = await push({ ...blocked(key), ...extra });

    expect(sent.status).toBe(400);
    expect(identityProviders.apnsCalls).toHaveLength(0);
  });

  it("不認得的密鑰回 404 pairing_not_found", async () => {
    const sent = await push(blocked(pairingKey()));
    expect(sent.status).toBe(404);
    expect(sent.body.error.code).toBe("pairing_not_found");
  });

  it("會員的訂閱到期後不轉送(403 subscription_required)", async () => {
    const me = await member();
    const purchaseDate = Date.now() - 40 * DAY;
    await submitTransaction(me.accessToken, { appAccountToken: me.id, purchaseDate, expiresDate: purchaseDate + 30 * DAY });
    const key = pairingKey();
    await env.DB.prepare(
      `INSERT INTO push_pairings (key_hash, member_id, platform, device_token, environment, created_at, updated_at)
       VALUES (?, ?, 'apns', ?, 'production', 0, 0)`,
    )
      .bind(await hashOf(key), me.id, DEVICE_TOKEN)
      .run();

    const sent = await push(blocked(key));

    expect(sent.status).toBe(403);
    expect(sent.body.error.code).toBe("subscription_required");
    expect(identityProviders.apnsCalls).toHaveLength(0);
  });

  it("每組密鑰每分鐘最多 10 則，超過回 429 rate_limited", async () => {
    const me = await subscribedMember();
    const key = pairingKey();
    await register(me.accessToken, key);

    for (let index = 0; index < 10; index += 1) expect((await push(blocked(key))).status).toBe(200);
    const limited = await push(blocked(key));

    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("rate_limited");
    expect(identityProviders.apnsCalls).toHaveLength(10);
  });

  it("速率限制以密鑰為單位：一組用完不影響另一組", async () => {
    const me = await subscribedMember();
    const first = pairingKey();
    const second = pairingKey();
    await register(me.accessToken, first);
    await register(me.accessToken, second);

    for (let index = 0; index < 11; index += 1) await push(blocked(first));

    expect((await push(blocked(second))).status).toBe(200);
  });

  it.each([
    [410, "Unregistered"],
    [400, "BadDeviceToken"],
    [400, "DeviceTokenNotForTopic"],
  ])("APNs 回 %i %s 時刪掉這個配對，回 410 pairing_revoked", async (status, reason) => {
    const me = await subscribedMember();
    const key = pairingKey();
    await register(me.accessToken, key);
    identityProviders.apnsReplies = [{ status, reason }];

    const sent = await push(blocked(key));

    expect(sent.status).toBe(410);
    expect(sent.body.error.code).toBe("pairing_revoked");
    expect(await pairingRows()).toHaveLength(0);
  });

  it("APNs 其他錯誤回 502 apns_failed,配對保留", async () => {
    const me = await subscribedMember();
    const key = pairingKey();
    await register(me.accessToken, key);
    identityProviders.apnsReplies = [{ status: 500, reason: "InternalServerError" }];

    const sent = await push(blocked(key));

    expect(sent.status).toBe(502);
    expect(sent.body.error.code).toBe("apns_failed");
    expect(await pairingRows()).toHaveLength(1);
  });
});

describe("Agent 完成(done)與種類偏好", () => {
  const done = (key: string) => ({ key, workspace: "weather-app", status: "done", pane: "w2:p1" });

  it("偏好含 done 時轉給 APNs:標題 workspace、「An agent finished.」、AGENT_DONE、active", async () => {
    const me = await subscribedMember();
    const key = pairingKey();
    await register(me.accessToken, key, { kinds: ["blocked", "done"] });

    const sent = await push(done(key));

    expect(sent.status).toBe(200);
    expect(sent.body).toEqual({ delivered: true });
    expect(identityProviders.apnsCalls).toHaveLength(1);
    expect(identityProviders.apnsCalls[0]!.payload).toEqual({
      aps: {
        alert: { title: "weather-app", "loc-key": "An agent finished." },
        sound: "default",
        "interruption-level": "active",
        category: "AGENT_DONE",
      },
      pairing: await hashOf(key),
      pane: "w2:p1",
      status: "done",
    });
  });

  it("註冊時沒帶 kinds(舊版 app)只收 blocked:done 回 200 delivered false,不呼叫 APNs", async () => {
    const me = await subscribedMember();
    const key = pairingKey();
    expect((await register(me.accessToken, key)).status).toBe(201);

    const sent = await push(done(key));

    expect(sent.status).toBe(200);
    expect(sent.body).toEqual({ delivered: false });
    expect(identityProviders.apnsCalls).toHaveLength(0);
    expect((await push(blocked(key))).body).toEqual({ delivered: true });
  });

  it("同一組密鑰再註冊帶 kinds 即更新偏好，不會多一筆", async () => {
    const me = await subscribedMember();
    const key = pairingKey();
    await register(me.accessToken, key);

    expect((await register(me.accessToken, key, { kinds: ["blocked", "done", "host_service"] })).status).toBe(201);
    expect((await push(done(key))).body).toEqual({ delivered: true });

    expect((await register(me.accessToken, key, { kinds: ["blocked"] })).status).toBe(201);
    expect((await push(done(key))).body).toEqual({ delivered: false });
    expect(await pairingRows()).toHaveLength(1);
  });

  it("再註冊沒帶 kinds(APNs token 輪替)保留原本的偏好", async () => {
    const me = await subscribedMember();
    const key = pairingKey();
    await register(me.accessToken, key, { kinds: ["done"] });

    await register(me.accessToken, key, { deviceToken: "b2".repeat(32) });

    expect((await push(done(key))).body).toEqual({ delivered: true });
    expect((await push(blocked(key))).body).toEqual({ delivered: false });
  });

  it("速率限制對 done 一樣生效", async () => {
    const me = await subscribedMember();
    const key = pairingKey();
    await register(me.accessToken, key, { kinds: ["blocked", "done"] });

    for (let index = 0; index < 10; index += 1) expect((await push(done(key))).status).toBe(200);
    const limited = await push(done(key));

    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("rate_limited");
  });

  it("訂閱到期後 done 一樣不轉送(403 subscription_required)", async () => {
    const me = await member();
    const purchaseDate = Date.now() - 40 * DAY;
    await submitTransaction(me.accessToken, { appAccountToken: me.id, purchaseDate, expiresDate: purchaseDate + 30 * DAY });
    const key = pairingKey();
    await env.DB.prepare(
      `INSERT INTO push_pairings (key_hash, member_id, platform, device_token, environment, kinds, created_at, updated_at)
       VALUES (?, ?, 'apns', ?, 'production', '["blocked","done"]', 0, 0)`,
    )
      .bind(await hashOf(key), me.id, DEVICE_TOKEN)
      .run();

    const sent = await push(done(key));

    expect(sent.status).toBe(403);
    expect(sent.body.error.code).toBe("subscription_required");
    expect(identityProviders.apnsCalls).toHaveLength(0);
  });

  it("APNs 回 Unregistered 時 done 一樣回 410 pairing_revoked 並刪掉配對", async () => {
    const me = await subscribedMember();
    const key = pairingKey();
    await register(me.accessToken, key, { kinds: ["done"] });
    identityProviders.apnsReplies = [{ status: 410, reason: "Unregistered" }];

    const sent = await push(done(key));

    expect(sent.status).toBe(410);
    expect(sent.body.error.code).toBe("pairing_revoked");
    expect(await pairingRows()).toHaveLength(0);
  });

  it("遠端關閉的配對送 done 回 410 pairing_revoked,只回一次", async () => {
    const me = await subscribedMember();
    const key = pairingKey();
    await env.DB.prepare("INSERT INTO revoked_push_pairings (key_hash, member_id, revoked_at) VALUES (?, ?, ?)").bind(await hashOf(key), me.id, Date.now()).run();

    const first = await push(done(key));
    const second = await push(done(key));

    expect(first.status).toBe(410);
    expect(first.body.error.code).toBe("pairing_revoked");
    expect(second.status).toBe(404);
  });

  it.each([
    ["kinds 不是陣列", { kinds: "done" }],
    ["kinds 有不認得的種類", { kinds: ["blocked", "chat"] }],
    ["kinds 的值不是字串", { kinds: [1] }],
  ])("%s時註冊回 400 invalid_request,什麼都不存", async (_, extra) => {
    const me = await subscribedMember();

    const registered = await register(me.accessToken, pairingKey(), extra);

    expect(registered.status).toBe(400);
    expect(registered.body.error.code).toBe("invalid_request");
    expect(await pairingRows()).toHaveLength(0);
  });
});

describe("主機服務事件(有新版、已更新、已退回)", () => {
  const hostEvent = (key: string, event: string, version?: string) => ({ key, event, ...(version === undefined ? {} : { version }) });

  async function hostServicePairing(kinds: string[] = ["blocked", "host_service"]) {
    const me = await subscribedMember();
    const key = pairingKey();
    expect((await register(me.accessToken, key, { kinds })).status).toBe(201);
    return { me, key };
  }

  it("已更新：轉給 APNs,標題「Host service」、內文帶版本、HOST_SERVICE_EVENT、passive 不帶 sound,根層 event 與 version", async () => {
    const { key } = await hostServicePairing();

    const sent = await push(hostEvent(key, "host_service_updated", "0.7.0"));

    expect(sent.status).toBe(200);
    expect(sent.body).toEqual({ delivered: true });
    expect(identityProviders.apnsCalls).toHaveLength(1);
    expect(identityProviders.apnsCalls[0]!.payload).toEqual({
      aps: {
        alert: { "title-loc-key": "Host service", "loc-key": "Host service updated to %@.", "loc-args": ["0.7.0"] },
        "interruption-level": "passive",
        category: "HOST_SERVICE_EVENT",
      },
      pairing: await hashOf(key),
      event: "host_service_updated",
      version: "0.7.0",
    });
  });

  it.each([
    ["host_service_update_available", "A host service update is available."],
    ["host_service_update_rolled_back", "Host service update failed and was rolled back."],
  ])("%s 沒帶版本：內文「%s」,根層沒有 version", async (event, locKey) => {
    const { key } = await hostServicePairing();

    expect((await push(hostEvent(key, event))).body).toEqual({ delivered: true });

    expect(identityProviders.apnsCalls[0]!.payload).toEqual({
      aps: {
        alert: { "title-loc-key": "Host service", "loc-key": locKey },
        "interruption-level": "passive",
        category: "HOST_SERVICE_EVENT",
      },
      pairing: await hashOf(key),
      event,
    });
  });

  it("有新版帶版本時，根層帶 version,內文不變", async () => {
    const { key } = await hostServicePairing();

    await push(hostEvent(key, "host_service_update_available", "0.8.0"));

    const payload = identityProviders.apnsCalls[0]!.payload;
    expect(payload.aps.alert).toEqual({ "title-loc-key": "Host service", "loc-key": "A host service update is available." });
    expect(payload.version).toBe("0.8.0");
  });

  it.each([
    ["同時帶 status 與 event", (key: string) => ({ ...blocked(key), event: "host_service_updated", version: "0.7.0" })],
    ["同時帶 workspace 與 event", (key: string) => ({ key, workspace: "weather-app", event: "host_service_update_available" })],
    ["事件帶 pane", (key: string) => ({ key, event: "host_service_update_available", pane: "w2:p1" })],
    ["事件多帶其他欄位", (key: string) => ({ key, event: "host_service_update_available", message: "secret" })],
    ["事件不認得", (key: string) => ({ key, event: "host_service_exploded" })],
    ["event 不是字串", (key: string) => ({ key, event: 1 })],
    ["已更新沒帶版本", (key: string) => ({ key, event: "host_service_updated" })],
    ["版本不是語意化版本", (key: string) => ({ key, event: "host_service_updated", version: "latest" })],
    ["版本前面有 v", (key: string) => ({ key, event: "host_service_updated", version: "v0.7.0" })],
    ["版本不是字串", (key: string) => ({ key, event: "host_service_updated", version: 7 })],
    ["版本太長", (key: string) => ({ key, event: "host_service_updated", version: `1.0.0-${"a".repeat(60)}` })],
    ["密鑰不是 64 位 hex", () => ({ key: "short", event: "host_service_update_available" })],
  ])("%s時回 400 invalid_request,不轉給 APNs", async (_, body) => {
    const { key } = await hostServicePairing();

    const sent = await push(body(key));

    expect(sent.status).toBe(400);
    expect(sent.body.error.code).toBe("invalid_request");
    expect(identityProviders.apnsCalls).toHaveLength(0);
  });

  it("版本可以帶 prerelease 與 build metadata", async () => {
    const { key } = await hostServicePairing();

    const sent = await push(hostEvent(key, "host_service_updated", "1.2.3-beta.1+build.5"));

    expect(sent.body).toEqual({ delivered: true });
    expect(identityProviders.apnsCalls[0]!.payload.version).toBe("1.2.3-beta.1+build.5");
  });

  it.each([
    ["註冊時沒帶 kinds(舊版 app)", undefined],
    ["偏好不含 host_service", ["blocked", "done"]],
  ])("%s:回 200 delivered false,不呼叫 APNs", async (_, kinds) => {
    const me = await subscribedMember();
    const key = pairingKey();
    await register(me.accessToken, key, kinds === undefined ? {} : { kinds });

    const sent = await push(hostEvent(key, "host_service_updated", "0.7.0"));

    expect(sent.status).toBe(200);
    expect(sent.body).toEqual({ delivered: false });
    expect(identityProviders.apnsCalls).toHaveLength(0);
  });

  it("只收 host_service 的配對收不到 blocked", async () => {
    const { key } = await hostServicePairing(["host_service"]);

    expect((await push(blocked(key))).body).toEqual({ delivered: false });
    expect((await push(hostEvent(key, "host_service_update_available"))).body).toEqual({ delivered: true });
  });

  it("速率限制對主機服務事件一樣生效", async () => {
    const { key } = await hostServicePairing();

    for (let index = 0; index < 10; index += 1) {
      expect((await push(hostEvent(key, "host_service_updated", `0.7.${index}`))).status).toBe(200);
    }
    const limited = await push(hostEvent(key, "host_service_updated", "0.7.99"));

    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("rate_limited");
  });

  it("訂閱到期後主機服務事件一樣不轉送(403 subscription_required)", async () => {
    const me = await member();
    const purchaseDate = Date.now() - 40 * DAY;
    await submitTransaction(me.accessToken, { appAccountToken: me.id, purchaseDate, expiresDate: purchaseDate + 30 * DAY });
    const key = pairingKey();
    await env.DB.prepare(
      `INSERT INTO push_pairings (key_hash, member_id, platform, device_token, environment, kinds, created_at, updated_at)
       VALUES (?, ?, 'apns', ?, 'production', '["host_service"]', 0, 0)`,
    )
      .bind(await hashOf(key), me.id, DEVICE_TOKEN)
      .run();

    const sent = await push(hostEvent(key, "host_service_update_available"));

    expect(sent.status).toBe(403);
    expect(sent.body.error.code).toBe("subscription_required");
    expect(identityProviders.apnsCalls).toHaveLength(0);
  });

  it("遠端關閉的配對送主機服務事件回 410 pairing_revoked,只回一次", async () => {
    const me = await subscribedMember();
    const key = pairingKey();
    await env.DB.prepare("INSERT INTO revoked_push_pairings (key_hash, member_id, revoked_at) VALUES (?, ?, ?)").bind(await hashOf(key), me.id, Date.now()).run();

    const first = await push(hostEvent(key, "host_service_update_available"));
    const second = await push(hostEvent(key, "host_service_update_available"));

    expect(first.status).toBe(410);
    expect(first.body.error.code).toBe("pairing_revoked");
    expect(second.status).toBe(404);
  });

  it("APNs 回 Unregistered 時主機服務事件一樣回 410 並刪掉配對", async () => {
    const { key } = await hostServicePairing();
    identityProviders.apnsReplies = [{ status: 410, reason: "Unregistered" }];

    const sent = await push(hostEvent(key, "host_service_update_available"));

    expect(sent.status).toBe(410);
    expect(sent.body.error.code).toBe("pairing_revoked");
    expect(await pairingRows()).toHaveLength(0);
  });
});

describe("主機服務事件去重(同一組密鑰＋event＋version 24 小時一次)", () => {
  const hostEvent = (key: string, event: string, version?: string) => ({ key, event, ...(version === undefined ? {} : { version }) });
  const HOUR = 60 * 60_000;

  async function hostServicePairing() {
    const me = await subscribedMember();
    const key = pairingKey();
    await register(me.accessToken, key, { kinds: ["blocked", "done", "host_service"] });
    return { me, key };
  }

  let clock: MockInstance<typeof Date.now> | undefined;

  afterEach(() => {
    clock?.mockRestore();
    clock = undefined;
  });

  it("同一個事件與版本再送一次：回 200 delivered false,APNs 只收到一則", async () => {
    const { key } = await hostServicePairing();

    expect((await push(hostEvent(key, "host_service_updated", "0.7.0"))).body).toEqual({ delivered: true });
    const again = await push(hostEvent(key, "host_service_updated", "0.7.0"));

    expect(again.status).toBe(200);
    expect(again.body).toEqual({ delivered: false });
    expect(identityProviders.apnsCalls).toHaveLength(1);
  });

  it("沒帶版本的同一個事件也只送一次", async () => {
    const { key } = await hostServicePairing();

    await push(hostEvent(key, "host_service_update_rolled_back"));
    expect((await push(hostEvent(key, "host_service_update_rolled_back"))).body).toEqual({ delivered: false });

    expect(identityProviders.apnsCalls).toHaveLength(1);
  });

  it("版本不同、事件不同或密鑰不同都各自送出", async () => {
    const { me, key } = await hostServicePairing();
    const otherKey = pairingKey();
    await register(me.accessToken, otherKey, { kinds: ["host_service"] });

    await push(hostEvent(key, "host_service_update_available", "0.7.0"));
    expect((await push(hostEvent(key, "host_service_update_available", "0.8.0"))).body).toEqual({ delivered: true });
    expect((await push(hostEvent(key, "host_service_update_available"))).body).toEqual({ delivered: true });
    expect((await push(hostEvent(key, "host_service_updated", "0.7.0"))).body).toEqual({ delivered: true });
    expect((await push(hostEvent(otherKey, "host_service_update_available", "0.7.0"))).body).toEqual({ delivered: true });

    expect(identityProviders.apnsCalls).toHaveLength(5);
  });

  it("超過 24 小時後同一個事件可以再送", async () => {
    const { key } = await hostServicePairing();
    const start = Date.now();
    clock = vi.spyOn(Date, "now").mockReturnValue(start);
    await push(hostEvent(key, "host_service_update_available", "0.8.0"));

    clock.mockReturnValue(start + 23 * HOUR);
    expect((await push(hostEvent(key, "host_service_update_available", "0.8.0"))).body).toEqual({ delivered: false });

    clock.mockReturnValue(start + 24 * HOUR + 1);
    expect((await push(hostEvent(key, "host_service_update_available", "0.8.0"))).body).toEqual({ delivered: true });
    expect(identityProviders.apnsCalls).toHaveLength(2);
  });

  it("APNs 失敗(502)不算送過，主機服務重送會再轉給 APNs", async () => {
    const { key } = await hostServicePairing();
    identityProviders.apnsReplies = [{ status: 500, reason: "InternalServerError" }];

    expect((await push(hostEvent(key, "host_service_updated", "0.7.0"))).status).toBe(502);
    const retried = await push(hostEvent(key, "host_service_updated", "0.7.0"));

    expect(retried.body).toEqual({ delivered: true });
    expect(identityProviders.apnsCalls).toHaveLength(2);
  });

  it("偏好不含 host_service 時沒送出，之後開啟偏好再送會轉給 APNs", async () => {
    const me = await subscribedMember();
    const key = pairingKey();
    await register(me.accessToken, key);

    expect((await push(hostEvent(key, "host_service_updated", "0.7.0"))).body).toEqual({ delivered: false });
    await register(me.accessToken, key, { kinds: ["host_service"] });

    expect((await push(hostEvent(key, "host_service_updated", "0.7.0"))).body).toEqual({ delivered: true });
  });

  it("done 不去重：同一個 workspace 連送兩次都轉給 APNs", async () => {
    const { key } = await hostServicePairing();
    const done = { key, workspace: "weather-app", status: "done", pane: "w2:p1" };

    expect((await push(done)).body).toEqual({ delivered: true });
    expect((await push(done)).body).toEqual({ delivered: true });
  });

  it("有去重紀錄的會員也能刪除", async () => {
    const { me, key } = await hostServicePairing();
    await push(hostEvent(key, "host_service_updated", "0.7.0"));

    expect((await api("DELETE", "/v1/members/me", { accessToken: me.accessToken })).status).toBe(204);
  });
});
