import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { hasActiveSubscription, requireActiveSubscription } from "../src/subscriptions";
import {
  DAY,
  makeChain,
  sendNotification,
  signJws,
  submitTransaction,
  subscriptionOf,
  transaction,
  untrustedRoot,
  YEARLY,
} from "./app-store";
import { api, signInWithApple } from "./fakes";

async function member(subject = "apple-user-1") {
  const signIn = await signInWithApple(subject);
  return { accessToken: signIn.body.accessToken as string, id: signIn.body.member.id as string };
}

/// 會員買了月繳(交易 1):一天前購買、29 天後到期。
async function subscribed() {
  const me = await member();
  const purchaseDate = Date.now() - DAY;
  const submit = await submitTransaction(me.accessToken, {
    appAccountToken: me.id,
    purchaseDate,
    expiresDate: purchaseDate + 30 * DAY,
    signedDate: Date.now() - DAY,
  });
  expect(submit.status).toBe(200);
  return { ...me, purchaseDate };
}

describe("App Store Server Notifications v2", () => {
  it("續訂(DID_RENEW)延長到期時間", async () => {
    const me = await subscribed();
    const renewedExpiry = me.purchaseDate + 60 * DAY;

    const response = await sendNotification({
      notificationType: "DID_RENEW",
      transaction: { transactionId: "2000000000000002", appAccountToken: me.id, purchaseDate: me.purchaseDate + 30 * DAY, expiresDate: renewedExpiry },
    });

    expect(response.status).toBe(200);
    expect((await subscriptionOf(me.accessToken)).body.subscription).toMatchObject({
      status: "active",
      expiresAt: new Date(renewedExpiry).toISOString(),
      willAutoRenew: true,
    });
  });

  it("到期(EXPIRED)後權限停用", async () => {
    const me = await subscribed();

    await sendNotification({
      notificationType: "EXPIRED",
      subtype: "VOLUNTARY",
      transaction: { appAccountToken: me.id, purchaseDate: me.purchaseDate, expiresDate: Date.now() - 1000 },
      renewal: { autoRenewStatus: 0 },
    });

    expect((await subscriptionOf(me.accessToken)).body.subscription).toMatchObject({ status: "expired", willAutoRenew: false });
    expect(await hasActiveSubscription(env, me.id)).toBe(false);
    await expect(requireActiveSubscription(env, me.id)).rejects.toMatchObject({ status: 403, code: "subscription_required" });
  });

  it("沒收到通知，到期時間一過權限也停用", async () => {
    const me = await subscribed();

    expect(await hasActiveSubscription(env, me.id)).toBe(true);
    await expect(requireActiveSubscription(env, me.id)).resolves.toBeUndefined();
    expect(await hasActiveSubscription(env, me.id, me.purchaseDate + 30 * DAY + 1)).toBe(false);
  });

  it("退款(REFUND)後即使還沒到期，權限也停用", async () => {
    const me = await subscribed();

    await sendNotification({
      notificationType: "REFUND",
      transaction: { appAccountToken: me.id, purchaseDate: me.purchaseDate, revocationDate: Date.now() - 1000 },
    });

    expect((await subscriptionOf(me.accessToken)).body.subscription).toMatchObject({ status: "revoked" });
    expect(await hasActiveSubscription(env, me.id)).toBe(false);
  });

  it("撤銷(REVOKE)後權限停用;退款被取消(REFUND_REVERSED)後恢復", async () => {
    const me = await subscribed();
    await sendNotification({
      notificationType: "REVOKE",
      transaction: { appAccountToken: me.id, purchaseDate: me.purchaseDate, revocationDate: Date.now() - 1000, signedDate: Date.now() - 500 },
    });
    expect(await hasActiveSubscription(env, me.id)).toBe(false);

    await sendNotification({ notificationType: "REFUND_REVERSED", transaction: { appAccountToken: me.id, purchaseDate: me.purchaseDate } });

    expect(await hasActiveSubscription(env, me.id)).toBe(true);
  });

  it("晚到的舊交易不會蓋掉已續訂的狀態", async () => {
    const me = await subscribed();
    const renewedExpiry = me.purchaseDate + 60 * DAY;
    await sendNotification({
      notificationType: "DID_RENEW",
      transaction: { transactionId: "2000000000000002", appAccountToken: me.id, purchaseDate: me.purchaseDate + 30 * DAY, expiresDate: renewedExpiry },
    });

    // 第一期的舊交易(簽章時間更晚)才送到。
    await sendNotification({
      notificationType: "DID_CHANGE_RENEWAL_STATUS",
      transaction: { appAccountToken: me.id, purchaseDate: me.purchaseDate, expiresDate: me.purchaseDate + 30 * DAY, signedDate: Date.now() + 1000 },
    });

    expect((await subscriptionOf(me.accessToken)).body.subscription.expiresAt).toBe(new Date(renewedExpiry).toISOString());
  });

  it("同一筆交易，簽章時間較早的版本不會蓋掉較新的(退款不會被舊資料取消)", async () => {
    const me = await subscribed();
    await sendNotification({
      notificationType: "REFUND",
      transaction: { appAccountToken: me.id, purchaseDate: me.purchaseDate, revocationDate: Date.now() - 1000 },
    });

    // app 送來購買當時(簽章較早)的同一筆交易。
    await submitTransaction(me.accessToken, { appAccountToken: me.id, purchaseDate: me.purchaseDate, signedDate: Date.now() - DAY });

    expect(await hasActiveSubscription(env, me.id)).toBe(false);
  });

  it("較舊的續訂資訊不會蓋掉較新的", async () => {
    const me = await subscribed();
    const tx = { appAccountToken: me.id, purchaseDate: me.purchaseDate };
    await sendNotification({ notificationType: "DID_CHANGE_RENEWAL_STATUS", subtype: "AUTO_RENEW_DISABLED", transaction: tx, renewal: { autoRenewStatus: 0 } });

    await sendNotification({
      notificationType: "DID_CHANGE_RENEWAL_STATUS",
      subtype: "AUTO_RENEW_ENABLED",
      transaction: tx,
      renewal: { autoRenewStatus: 1, signedDate: Date.now() - 60_000 },
    });

    expect((await subscriptionOf(me.accessToken)).body.subscription.willAutoRenew).toBe(false);
  });

  it("扣款失敗進入帳單寬限期時仍有權限，寬限期結束(GRACE_PERIOD_EXPIRED)後停用", async () => {
    const me = await subscribed();
    const expired = Date.now() - 1000;
    await sendNotification({
      notificationType: "DID_FAIL_TO_RENEW",
      subtype: "GRACE_PERIOD",
      transaction: { appAccountToken: me.id, purchaseDate: me.purchaseDate, expiresDate: expired },
      renewal: { gracePeriodExpiresDate: Date.now() + 6 * DAY },
    });
    expect((await subscriptionOf(me.accessToken)).body.subscription).toMatchObject({ status: "in_grace_period" });
    expect(await hasActiveSubscription(env, me.id)).toBe(true);

    await sendNotification({
      notificationType: "GRACE_PERIOD_EXPIRED",
      transaction: { appAccountToken: me.id, purchaseDate: me.purchaseDate, expiresDate: expired },
      renewal: { autoRenewStatus: 1 },
    });

    expect((await subscriptionOf(me.accessToken)).body.subscription).toMatchObject({ status: "expired" });
    expect(await hasActiveSubscription(env, me.id)).toBe(false);
  });

  it("app 還沒提交就先收到購買通知時，依 appAccountToken 記到會員身上", async () => {
    const me = await member();

    await sendNotification({ notificationType: "SUBSCRIBED", subtype: "INITIAL_BUY", transaction: { appAccountToken: me.id, productId: YEARLY } });

    expect((await subscriptionOf(me.accessToken)).body.subscription).toMatchObject({ status: "active", productId: YEARLY });
  });

  it("不認得的訂閱(沒有登記、也沒有 appAccountToken)略過但回 200", async () => {
    const response = await sendNotification({ notificationType: "SUBSCRIBED", transaction: { appAccountToken: null } });

    expect(response.status).toBe(200);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM entitlements").first("count")).toBe(0);
  });

  it("帳單寬限期的時間過了，沒收到通知也停用", async () => {
    const me = await subscribed();
    const grace = Date.now() + 6 * DAY;
    await sendNotification({
      notificationType: "DID_FAIL_TO_RENEW",
      subtype: "GRACE_PERIOD",
      transaction: { appAccountToken: me.id, purchaseDate: me.purchaseDate, expiresDate: Date.now() - 1000 },
      renewal: { gracePeriodExpiresDate: grace },
    });

    expect(await hasActiveSubscription(env, me.id, grace - 1)).toBe(true);
    expect(await hasActiveSubscription(env, me.id, grace + 1)).toBe(false);
  });

  it("外層通知簽章不受信任時拒絕(即使裡面是真的交易)", async () => {
    const me = await subscribed();
    const genuine = await signJws(transaction({ appAccountToken: me.id, purchaseDate: me.purchaseDate, revocationDate: Date.now() }));
    const signedPayload = await signJws(
      {
        notificationType: "REFUND",
        notificationUUID: crypto.randomUUID(),
        version: "2.0",
        signedDate: Date.now(),
        data: { bundleId: "com.raychiu.purrdr", environment: "Sandbox", signedTransactionInfo: genuine },
      },
      await makeChain({ root: await untrustedRoot() }),
    );

    const response = await api("POST", "/v1/app-store/notifications", { body: { signedPayload } });

    expect(response.status).toBe(400);
    expect(await hasActiveSubscription(env, me.id)).toBe(true);
  });

  it("TEST 通知(沒有交易)回 200", async () => {
    const signedPayload = await signJws({
      notificationType: "TEST",
      notificationUUID: crypto.randomUUID(),
      version: "2.0",
      signedDate: Date.now(),
      data: { bundleId: "com.raychiu.purrdr", environment: "Sandbox" },
    });

    expect((await api("POST", "/v1/app-store/notifications", { body: { signedPayload } })).status).toBe(200);
  });

  it("簽章不受信任的通知拒絕，權限不變", async () => {
    const me = await subscribed();

    const response = await sendNotification({
      notificationType: "REFUND",
      transaction: { appAccountToken: me.id, purchaseDate: me.purchaseDate, revocationDate: Date.now() },
      chain: await makeChain({ root: await untrustedRoot() }),
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("invalid_notification");
    expect(await hasActiveSubscription(env, me.id)).toBe(true);
  });

  it("通知外層可信但裡面的交易簽章不受信任時拒絕", async () => {
    const me = await subscribed();
    const forgedTransaction = await signJws(
      transaction({ appAccountToken: me.id, purchaseDate: me.purchaseDate, revocationDate: Date.now() }),
      await makeChain({ root: await untrustedRoot() }),
    );
    const signedPayload = await signJws({
      notificationType: "REFUND",
      notificationUUID: crypto.randomUUID(),
      version: "2.0",
      signedDate: Date.now(),
      data: { bundleId: "com.raychiu.purrdr", environment: "Sandbox", signedTransactionInfo: forgedTransaction },
    });

    const response = await api("POST", "/v1/app-store/notifications", { body: { signedPayload } });

    expect(response.status).toBe(400);
    expect(await hasActiveSubscription(env, me.id)).toBe(true);
  });

  it("正式環境的通知要是這個 app 的 Apple ID", async () => {
    const me = await member();

    const response = await sendNotification({
      notificationType: "SUBSCRIBED",
      environment: "Production",
      appAppleId: 999,
      transaction: { appAccountToken: me.id },
    });

    expect(response.status).toBe(400);
    expect((await subscriptionOf(me.accessToken)).body.subscription).toBeNull();
  });

  it("正式環境、這個 app 的通知接受", async () => {
    const me = await member();

    const response = await sendNotification({ notificationType: "SUBSCRIBED", environment: "Production", transaction: { appAccountToken: me.id } });

    expect(response.status).toBe(200);
    expect((await subscriptionOf(me.accessToken)).body.subscription.status).toBe("active");
  });

  it("別的 app 的通知拒絕", async () => {
    const me = await member();

    const response = await sendNotification({ notificationType: "SUBSCRIBED", bundleId: "com.example.other", transaction: { appAccountToken: me.id } });

    expect(response.status).toBe(400);
    expect((await subscriptionOf(me.accessToken)).body.subscription).toBeNull();
  });
});

describe("訂閱歸屬", () => {
  it("已屬於另一個會員的訂閱不能被領走", async () => {
    const owner = await member("apple-owner");
    await submitTransaction(owner.accessToken, { appAccountToken: owner.id });
    const other = await member("apple-other");

    const submit = await submitTransaction(other.accessToken, { appAccountToken: null });

    expect(submit.status).toBe(409);
    expect(submit.body.error.code).toBe("subscription_in_use");
    expect((await subscriptionOf(other.accessToken)).body.subscription).toBeNull();
  });

  it("appAccountToken 是另一個現有會員時不能領走(即使還沒登記)", async () => {
    const owner = await member("apple-owner");
    const other = await member("apple-other");

    // StoreKit 的 UUID 可能是大寫;會員 ID 是小寫。
    const submit = await submitTransaction(other.accessToken, { appAccountToken: owner.id.toUpperCase() });

    expect(submit.status).toBe(409);
    expect((await subscriptionOf(other.accessToken)).body.subscription).toBeNull();
  });

  it("在 App Store 兌換 Offer Code 的訂閱(沒有 appAccountToken)歸提交的會員", async () => {
    const me = await member();

    const submit = await submitTransaction(me.accessToken, { appAccountToken: null, offerType: 3 });

    expect(submit.status).toBe(200);
    expect(submit.body.subscription.status).toBe("active");
  });

  it("原會員刪除後，新會員可以恢復購買領回訂閱", async () => {
    const old = await member("apple-old");
    await submitTransaction(old.accessToken, { appAccountToken: old.id });
    expect((await api("DELETE", "/v1/members/me", { accessToken: old.accessToken })).status).toBe(204);
    const fresh = await member("apple-new");

    const submit = await submitTransaction(fresh.accessToken, { appAccountToken: old.id });

    expect(submit.status).toBe(200);
    expect(submit.body.subscription.status).toBe("active");
  });

  it("同一個會員重複提交同一筆交易不會出錯(appAccountToken 大小寫不拘)", async () => {
    const me = await member();
    await submitTransaction(me.accessToken, { appAccountToken: me.id.toUpperCase() });

    const again = await submitTransaction(me.accessToken, { appAccountToken: me.id });

    expect(again.status).toBe(200);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM entitlements").first("count")).toBe(1);
  });

  it("沒登入不能提交或查詢", async () => {
    expect((await api("GET", "/v1/members/me/subscription")).status).toBe(401);
    expect((await api("POST", "/v1/members/me/subscription/app-store", { body: { signedTransaction: "x" } })).status).toBe(401);
  });
});
