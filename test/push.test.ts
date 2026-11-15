import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
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
    ["狀態不是 blocked", { status: "done" }],
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
