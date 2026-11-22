import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DAY, sendNotification, signJws, submitTransaction, subscriptionOf, transaction, type TransactionOptions } from "./app-store";
import { api, identityProviders, signInWithApple } from "./fakes";

/// 訂閱轉移(purrdr.server#27):目前會員沒有有效訂閱時,可把屬於其他會員的 App Store 訂閱轉過來。

const ORIGINAL = "2000000000000001";
const PHONE_TOKEN = "a1".repeat(32);
const PHONE_ID = "5f0c7d2e-1111-4a5b-9c3d-000000000001";

async function member(subject: string) {
  const signIn = await signInWithApple(subject);
  return { accessToken: signIn.body.accessToken as string, id: signIn.body.member.id as string };
}

function pairingKey(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashOf(key: string): Promise<string> {
  const bytes = new Uint8Array(key.match(/../g)!.map((pair) => parseInt(pair, 16)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function enablePush(accessToken: string): Promise<string> {
  const key = pairingKey();
  const registered = await api("POST", "/v1/members/me/push-pairings", {
    accessToken,
    body: { keyHash: await hashOf(key), platform: "apns", environment: "production", deviceToken: PHONE_TOKEN, deviceId: PHONE_ID },
  });
  expect(registered.status).toBe(201);
  return key;
}

const push = (key: string) => api("POST", "/v1/push", { body: { key, workspace: "weather-app", status: "blocked" } });
const sync = (accessToken: string) => api("POST", "/v1/members/me/hosts/sync", { accessToken, body: { changes: [] } });

async function transfer(accessToken: string, options: TransactionOptions = {}) {
  return api("POST", "/v1/members/me/subscription/transfer", {
    accessToken,
    body: { signedTransaction: await signJws(transaction({ originalTransactionId: ORIGINAL, ...options })) },
  });
}

/// 原會員 A 有訂閱(並在一台主機開了通知),目前會員 B 沒有訂閱。
async function setup() {
  const owner = await member("apple-owner");
  const me = await member("apple-me");
  expect((await submitTransaction(owner.accessToken, { appAccountToken: owner.id })).status).toBe(200);
  const ownerKey = await enablePush(owner.accessToken);
  return { owner, me, ownerKey };
}

async function eventTypes(): Promise<{ source: string; type: string }[]> {
  const { results } = await env.DB.prepare("SELECT source, type FROM subscription_events ORDER BY received_at, rowid").all<{ source: string; type: string }>();
  return results;
}

async function ownerOfSubscription(externalId = ORIGINAL): Promise<string | undefined> {
  const row = await env.DB.prepare("SELECT member_id FROM subscriptions WHERE external_id = ?").bind(externalId).first<{ member_id: string }>();
  return row?.member_id;
}

async function seedSubscription(memberId: string, status: "active" | "grace" | "billing_retry") {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO subscriptions (id, member_id, store, external_id, product_id, status, expires_at, environment, updated_at, grace_expires_at)
     VALUES ('seeded', ?, 'app_store', 'other', 'p', ?, ?, 'sandbox', 0, ?)`,
  )
    .bind(memberId, status, status === "active" ? now + DAY : now - DAY, status === "grace" ? now + DAY : null)
    .run();
}

describe("轉移成功", () => {
  it("訂閱改歸目前會員、記轉移紀錄與事件、以 Set App Account Token 讓續訂歸新會員", async () => {
    const { owner, me } = await setup();
    identityProviders.appStoreApiCalls = [];
    identityProviders.appStoreApiHandler = () => ({ status: 200 });

    const response = await transfer(me.accessToken);

    expect(response.status).toBe(200);
    expect(response.body.appAccountTokenUpdated).toBe(true);
    expect(response.body.subscription.status).toBe("active");
    expect((await subscriptionOf(me.accessToken)).body.subscription.status).toBe("active");
    expect(await ownerOfSubscription()).toBe(me.id);
    const transfers = await env.DB.prepare("SELECT from_member, to_member FROM subscription_transfers").all();
    expect(transfers.results).toEqual([{ from_member: owner.id, to_member: me.id }]);
    expect((await eventTypes()).filter((event) => event.type === "transferred")).toEqual([{ source: "client", type: "transferred" }]);
    const calls = identityProviders.appStoreApiCalls.filter((call) => call.method === "PUT");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe(`/inApps/v1/transactions/${ORIGINAL}/appAccountToken`);
    expect(calls[0]!.body).toEqual({ appAccountToken: me.id });
    expect(calls[0]!.environment).toBe("sandbox");
    expect(calls[0]!.jwtValid).toBe(true);
  });

  it("原會員的 Plus 立即失效:訂閱讀不到、推播配對回 410、主機同步 403;新會員同步成功", async () => {
    const { owner, me, ownerKey } = await setup();
    expect((await push(ownerKey)).status).toBe(200);
    expect((await sync(owner.accessToken)).status).toBe(200);
    identityProviders.appStoreApiHandler = () => ({ status: 200 });

    expect((await transfer(me.accessToken)).status).toBe(200);

    expect((await subscriptionOf(owner.accessToken)).body.subscription).toBeNull();
    const sent = await push(ownerKey);
    expect(sent.status).toBe(410);
    expect(sent.body.error.code).toBe("pairing_revoked");
    const ownerSync = await sync(owner.accessToken);
    expect(ownerSync.status).toBe(403);
    expect(ownerSync.body.error.code).toBe("subscription_required");
    expect((await sync(me.accessToken)).status).toBe(200);
  });

  it("Apple 不可達:轉移仍成立,回 appAccountTokenUpdated: false,記 set_app_account_token_failed", async () => {
    const { me } = await setup();
    identityProviders.appStoreApiHandler = () => ({ status: 500, body: { errorCode: 5000000 } });

    const response = await transfer(me.accessToken);

    expect(response.status).toBe(200);
    expect(response.body.appAccountTokenUpdated).toBe(false);
    expect(response.body.subscription.status).toBe("active");
    expect(await ownerOfSubscription()).toBe(me.id);
    const types = await eventTypes();
    expect(types).toContainEqual({ source: "client", type: "transferred" });
    expect(types).toContainEqual({ source: "store_api", type: "set_app_account_token_failed" });
  });

  it("Apple 明確拒絕(400)同樣不回滾轉移", async () => {
    const { me } = await setup();
    identityProviders.appStoreApiHandler = () => ({ status: 400, body: { errorCode: 4000018 } });

    const response = await transfer(me.accessToken);

    expect(response.status).toBe(200);
    expect(response.body.appAccountTokenUpdated).toBe(false);
    expect(await eventTypes()).toContainEqual({ source: "store_api", type: "set_app_account_token_failed" });
  });

  it("轉移之後通知仍帶舊的 appAccountToken(原會員):以資料庫登記的歸屬為準,更新的是新會員", async () => {
    const { owner, me } = await setup();
    identityProviders.appStoreApiHandler = () => ({ status: 200 });
    expect((await transfer(me.accessToken)).status).toBe(200);

    const response = await sendNotification({
      notificationType: "DID_RENEW",
      transaction: { appAccountToken: owner.id, transactionId: "2000000000000002", purchaseDate: Date.now(), expiresDate: Date.now() + 30 * DAY },
    });

    expect(response.status).toBe(200);
    expect((await subscriptionOf(me.accessToken)).body.subscription.status).toBe("active");
    expect((await subscriptionOf(owner.accessToken)).body.subscription).toBeNull();
  });
});

describe("轉移被拒", () => {
  it.each([["active"], ["grace"], ["billing_retry"]] as const)(
    "目前會員已有 %s 的訂閱:409 subscription_already_active,什麼都沒動",
    async (status) => {
      const { owner, me, ownerKey } = await setup();
      await seedSubscription(me.id, status);
      identityProviders.appStoreApiCalls = [];

      const response = await transfer(me.accessToken);

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("subscription_already_active");
      expect(await ownerOfSubscription()).toBe(owner.id);
      expect((await env.DB.prepare("SELECT * FROM subscription_transfers").all()).results).toEqual([]);
      expect(identityProviders.appStoreApiCalls.filter((call) => call.method === "PUT")).toEqual([]);
      expect((await push(ownerKey)).status).toBe(200);
    },
  );

  it("訂閱還沒登記在任何會員:404 subscription_not_found", async () => {
    const me = await member("apple-me");

    const response = await transfer(me.accessToken);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("subscription_not_found");
  });

  it("訂閱已屬於自己:409 subscription_already_owned", async () => {
    const me = await member("apple-me");
    await submitTransaction(me.accessToken, { appAccountToken: me.id });

    const response = await transfer(me.accessToken);

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("subscription_already_owned");
  });

  it("簽章交易驗不過:400 invalid_transaction;沒登入:401", async () => {
    const { me } = await setup();
    const bad = await api("POST", "/v1/members/me/subscription/transfer", { accessToken: me.accessToken, body: { signedTransaction: "not-a-jws" } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("invalid_transaction");
    expect((await api("POST", "/v1/members/me/subscription/transfer", { body: { signedTransaction: "x" } })).status).toBe(401);
  });
});

describe("billing_retry 舊訂閱被新購買標成 expired 之後收到 DID_RENEW", () => {
  it("不回 409 讓 Apple 一直重送:回 200、記 slot_conflict_ignored 事件,新訂閱不受影響", async () => {
    const me = await member("apple-me");
    const past = Date.now() - 2 * DAY;
    const old = { appAccountToken: me.id, originalTransactionId: "old-1", transactionId: "old-0", purchaseDate: past - 30 * DAY, expiresDate: past };
    await submitTransaction(me.accessToken, old);
    await sendNotification({ notificationType: "DID_FAIL_TO_RENEW", transaction: old });
    expect((await submitTransaction(me.accessToken, { appAccountToken: me.id, originalTransactionId: "new-1", transactionId: "new-1" })).status).toBe(200);
    expect((await env.DB.prepare("SELECT status FROM subscriptions WHERE external_id = 'old-1'").first<{ status: string }>())?.status).toBe("expired");

    const response = await sendNotification({
      notificationType: "DID_RENEW",
      transaction: { appAccountToken: me.id, originalTransactionId: "old-1", transactionId: "old-2", purchaseDate: Date.now(), expiresDate: Date.now() + 30 * DAY },
    });

    expect(response.status).toBe(200);
    expect(await eventTypes()).toContainEqual({ source: "store_notification", type: "slot_conflict_ignored" });
    expect((await env.DB.prepare("SELECT status FROM subscriptions WHERE external_id = 'new-1'").first<{ status: string }>())?.status).toBe("active");
  });
});
