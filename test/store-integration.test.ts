import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { AppStoreApiError, AppStoreApiUnavailable, setAppAccountToken } from "../src/app-store-api";
import {
  DAY,
  notification,
  renewalInfo,
  sendNotification,
  signJws,
  submitTransaction,
  subscriptionOf,
  transaction,
  type TransactionOptions,
} from "./app-store";
import { api, identityProviders, signInWithApple } from "./fakes";

async function member(subject = "apple-user-1", email?: string) {
  const signIn = await signInWithApple(subject, email ? { email } : {});
  return { accessToken: signIn.body.accessToken as string, id: signIn.body.member.id as string };
}

type EventRow = { source: string; type: string; notification_uuid: string | null; external_id: string };

async function events(): Promise<EventRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT e.source, e.type, e.notification_uuid, s.external_id FROM subscription_events e
     JOIN subscriptions s ON s.id = e.subscription_id ORDER BY e.received_at, e.rowid`,
  ).all<EventRow>();
  return results;
}

async function stored(originalTransactionId = "2000000000000001") {
  return env.DB.prepare("SELECT status, environment, expires_at FROM subscriptions WHERE external_id = ?")
    .bind(originalTransactionId)
    .first<{ status: string; environment: string; expires_at: number }>();
}

/// 假 App Store Server API 的 Get All Subscription Statuses 回應。
async function statusesBody(tx: TransactionOptions, status: number, environment = "Sandbox") {
  const payload = transaction({ environment, ...tx });
  return {
    environment,
    appAppleId: Number(env.APP_STORE_APP_APPLE_ID),
    bundleId: "com.raychiu.purrdr",
    data: [
      {
        subscriptionGroupIdentifier: "21500000",
        lastTransactions: [
          {
            originalTransactionId: payload.originalTransactionId,
            status,
            signedTransactionInfo: await signJws(payload),
            signedRenewalInfo: await signJws(renewalInfo({ environment, originalTransactionId: payload.originalTransactionId })),
          },
        ],
      },
    ],
  };
}

const TOKEN = "6f9619ff-8b86-4011-b42d-00c04fc964ff";

describe("通知冪等(notificationUUID)", () => {
  it("同一個通知重送回 200、不重複處理,只記一筆事件", async () => {
    const me = await member();
    const signedPayload = await notification({
      notificationType: "SUBSCRIBED",
      subtype: "INITIAL_BUY",
      notificationUUID: "11111111-1111-4111-8111-111111111111",
      transaction: { appAccountToken: me.id },
    });

    const first = await api("POST", "/v1/app-store/notifications", { body: { signedPayload } });
    expect(first.status).toBe(200);
    // 竄改已處理的結果:重送若再處理一次,就會把它改回來。
    await env.DB.prepare("UPDATE subscriptions SET expires_at = 1234").run();
    const again = await api("POST", "/v1/app-store/notifications", { body: { signedPayload } });

    expect(again.status).toBe(200);
    expect((await stored())?.expires_at).toBe(1234);
    expect(await events()).toEqual([
      { source: "store_notification", type: "SUBSCRIBED.INITIAL_BUY", notification_uuid: "11111111-1111-4111-8111-111111111111", external_id: "2000000000000001" },
    ]);
  });

  it("不同 UUID 的通知各記一筆", async () => {
    const me = await member();
    await sendNotification({ notificationType: "SUBSCRIBED", transaction: { appAccountToken: me.id } });
    await sendNotification({
      notificationType: "DID_CHANGE_RENEWAL_STATUS",
      subtype: "AUTO_RENEW_DISABLED",
      transaction: { appAccountToken: me.id },
      renewal: { autoRenewStatus: 0 },
    });

    const rows = await events();
    expect(rows.map((row) => row.type)).toEqual(["SUBSCRIBED", "DID_CHANGE_RENEWAL_STATUS.AUTO_RENEW_DISABLED"]);
    expect(new Set(rows.map((row) => row.notification_uuid)).size).toBe(2);
  });

  it("不認得的訂閱略過、回 200、不記事件", async () => {
    const response = await sendNotification({ notificationType: "DID_RENEW", transaction: { appAccountToken: null } });
    expect(response.status).toBe(200);
    expect(await events()).toEqual([]);
  });
});

describe("通知的狀態轉換(依 data.status)", () => {
  const past = () => Date.now() - 1000;
  const cases: { name: string; notificationType: string; subtype?: string; tx?: TransactionOptions; status?: number | null; expected: string }[] = [
    { name: "續訂 -> active", notificationType: "DID_RENEW", expected: "active" },
    { name: "扣款失敗進寬限期 -> grace", notificationType: "DID_FAIL_TO_RENEW", subtype: "GRACE_PERIOD", tx: { expiresDate: past() }, expected: "grace" },
    { name: "扣款失敗沒有寬限期 -> billing_retry", notificationType: "DID_FAIL_TO_RENEW", tx: { expiresDate: past() }, expected: "billing_retry" },
    { name: "寬限期結束(GRACE_PERIOD_EXPIRED)仍在重試 -> billing_retry", notificationType: "GRACE_PERIOD_EXPIRED", tx: { expiresDate: past() }, expected: "billing_retry" },
    { name: "到期 -> expired", notificationType: "EXPIRED", subtype: "VOLUNTARY", tx: { expiresDate: past() }, expected: "expired" },
    { name: "退款 -> refunded", notificationType: "REFUND", tx: { revocationDate: past() }, expected: "refunded" },
    { name: "撤銷 -> revoked", notificationType: "REVOKE", tx: { revocationDate: past() }, expected: "revoked" },
    { name: "data.status 優先於通知類型(DID_RENEW 但 status=3)", notificationType: "DID_RENEW", status: 3, tx: { expiresDate: past() }, expected: "billing_retry" },
    // 通知沒有 data.status 時依通知類型。
    { name: "沒有 data.status:DID_FAIL_TO_RENEW(GRACE_PERIOD) -> grace", notificationType: "DID_FAIL_TO_RENEW", subtype: "GRACE_PERIOD", status: null, tx: { expiresDate: past() }, expected: "grace" },
    { name: "沒有 data.status:DID_FAIL_TO_RENEW -> billing_retry", notificationType: "DID_FAIL_TO_RENEW", status: null, tx: { expiresDate: past() }, expected: "billing_retry" },
    { name: "沒有 data.status:GRACE_PERIOD_EXPIRED -> billing_retry", notificationType: "GRACE_PERIOD_EXPIRED", status: null, tx: { expiresDate: past() }, expected: "billing_retry" },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const me = await member();
      await sendNotification({
        notificationType: c.notificationType,
        subtype: c.subtype,
        status: c.status,
        transaction: { appAccountToken: me.id, ...c.tx },
        ...(c.expected === "grace" ? { renewal: { gracePeriodExpiresDate: Date.now() + 6 * DAY } } : {}),
      });
      expect((await stored())?.status).toBe(c.expected);
    });
  }

  it("billing_retry 沒有 Plus 權限;會員重新購買(新的 original transaction)時,舊的重試中訂閱讓位成 expired", async () => {
    const me = await member();
    await sendNotification({ notificationType: "GRACE_PERIOD_EXPIRED", transaction: { appAccountToken: me.id, expiresDate: Date.now() - 1000 } });
    expect((await subscriptionOf(me.accessToken)).body.subscription.status).toBe("expired");

    const second = await submitTransaction(me.accessToken, {
      appAccountToken: me.id,
      originalTransactionId: "2000000000000777",
      transactionId: "2000000000000777",
    });

    expect(second.status).toBe(200);
    expect(second.body.subscription.status).toBe("active");
    expect((await stored("2000000000000001"))?.status).toBe("expired");
  });

  it("退款被取消(REFUND_REVERSED)後恢復 active", async () => {
    const me = await member();
    await sendNotification({ notificationType: "REFUND", transaction: { appAccountToken: me.id, revocationDate: Date.now() - 500, signedDate: Date.now() - 2000 } });
    await sendNotification({ notificationType: "REFUND_REVERSED", transaction: { appAccountToken: me.id, signedDate: Date.now() } });
    expect((await stored())?.status).toBe("active");
  });

  it("Production 與 Sandbox 用同一個網址,依 data.environment 區分", async () => {
    const prod = await member("apple-prod");
    const sandbox = await member("apple-sandbox");
    await sendNotification({
      notificationType: "SUBSCRIBED",
      environment: "Production",
      transaction: { appAccountToken: prod.id, originalTransactionId: "3000000000000001", transactionId: "3000000000000001" },
    });
    await sendNotification({
      notificationType: "SUBSCRIBED",
      environment: "Sandbox",
      transaction: { appAccountToken: sandbox.id, originalTransactionId: "3000000000000002", transactionId: "3000000000000002" },
    });

    expect((await stored("3000000000000001"))?.environment).toBe("production");
    expect((await stored("3000000000000002"))?.environment).toBe("sandbox");
  });

  it("data.environment 與交易的 environment 不符時拒絕", async () => {
    const me = await member();
    const signedPayload = await notification({
      notificationType: "SUBSCRIBED",
      environment: "Sandbox",
      transaction: { appAccountToken: me.id, environment: "Production" },
    });
    const response = await api("POST", "/v1/app-store/notifications", { body: { signedPayload } });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("invalid_notification");
  });
});

describe("綁定交易", () => {
  it("app 提交的交易記一筆 client 事件", async () => {
    const me = await member();
    const submit = await submitTransaction(me.accessToken, { appAccountToken: me.id });
    expect(submit.status).toBe(200);
    expect((await events()).filter((row) => row.source === "client")).toEqual([
      { source: "client", type: "transaction_submitted", notification_uuid: null, external_id: "2000000000000001" },
    ]);
  });

  describe("屬於其他會員", () => {
    it("回 409 帶遮蔽 email,請求者沒有訂閱時 canTransfer 為 true,不洩漏會員 ID", async () => {
      const owner = await member("apple-owner", "ray@example.com");
      await submitTransaction(owner.accessToken, { appAccountToken: owner.id });
      const other = await member("apple-other");

      const submit = await submitTransaction(other.accessToken, { appAccountToken: null });

      expect(submit.status).toBe(409);
      expect(submit.body.error.code).toBe("subscription_in_use");
      expect(submit.body.error.details).toEqual({ ownerEmail: "r***@example.com", canTransfer: true });
      expect(JSON.stringify(submit.body)).not.toContain(owner.id);
    });

    it("請求者自己已有有效訂閱時 canTransfer 為 false", async () => {
      const owner = await member("apple-owner", "ray@example.com");
      await submitTransaction(owner.accessToken, { appAccountToken: owner.id });
      const other = await member("apple-other");
      await submitTransaction(other.accessToken, { appAccountToken: other.id, originalTransactionId: "2000000000000555", transactionId: "2000000000000555" });

      const submit = await submitTransaction(other.accessToken, { appAccountToken: null });

      expect(submit.status).toBe(409);
      expect(submit.body.error.details).toEqual({ ownerEmail: "r***@example.com", canTransfer: false });
    });

    it("擁有者沒有 email 時 ownerEmail 是 null", async () => {
      const owner = await member("apple-owner");
      await submitTransaction(owner.accessToken, { appAccountToken: owner.id });
      const other = await member("apple-other");

      const submit = await submitTransaction(other.accessToken, { appAccountToken: null });

      expect(submit.body.error.details).toEqual({ ownerEmail: null, canTransfer: true });
    });

    it("appAccountToken 指向另一個現有會員(還沒登記)時同樣帶 details", async () => {
      const owner = await member("apple-owner", "ray@example.com");
      const other = await member("apple-other");

      const submit = await submitTransaction(other.accessToken, { appAccountToken: owner.id });

      expect(submit.status).toBe(409);
      expect(submit.body.error.details).toEqual({ ownerEmail: "r***@example.com", canTransfer: true });
    });
  });
});

describe("向 App Store Server API 查證", () => {
  it("綁定時呼叫 Get All Subscription Statuses(帶正確的 JWT,依交易環境選主機),並記 store_api 事件", async () => {
    const me = await member();
    identityProviders.appStoreApiHandler = async () => ({ status: 200, body: await statusesBody({ appAccountToken: me.id }, 1) });

    const submit = await submitTransaction(me.accessToken, { appAccountToken: me.id });

    expect(submit.status).toBe(200);
    expect(identityProviders.appStoreApiCalls).toMatchObject([
      { method: "GET", environment: "sandbox", path: "/inApps/v1/subscriptions/2000000000000001", jwtValid: true },
    ]);
    expect((await events()).map((row) => `${row.source}:${row.type}`)).toEqual(["client:transaction_submitted", "store_api:status_checked"]);
  });

  it("Production 的交易打 Production 主機", async () => {
    const me = await member();
    await submitTransaction(me.accessToken, { appAccountToken: me.id, environment: "Production" });
    expect(identityProviders.appStoreApiCalls[0]?.environment).toBe("production");
  });

  it("以 Apple 回報的狀態為準(提交的交易看起來有效,Apple 說已進入 billing retry)", async () => {
    const me = await member();
    identityProviders.appStoreApiHandler = async () => ({ status: 200, body: await statusesBody({ appAccountToken: me.id, expiresDate: Date.now() - 1000 }, 3) });

    await submitTransaction(me.accessToken, { appAccountToken: me.id });

    expect((await stored())?.status).toBe("billing_retry");
  });

  it("Apple 查無此交易時不擋購買,以簽章交易為準並記 lookup_not_found", async () => {
    const me = await member();
    const submit = await submitTransaction(me.accessToken, { appAccountToken: me.id });
    expect(submit.status).toBe(200);
    expect(submit.body.subscription.status).toBe("active");
    expect((await events()).map((row) => row.type)).toEqual(["transaction_submitted", "lookup_not_found"]);
  });

  it("Apple 回 500 時不擋購買,記 lookup_unreachable", async () => {
    const me = await member();
    identityProviders.appStoreApiHandler = () => ({ status: 500, body: { errorCode: 5000000 } });
    const submit = await submitTransaction(me.accessToken, { appAccountToken: me.id });
    expect(submit.status).toBe(200);
    expect(submit.body.subscription.status).toBe("active");
    expect((await events()).map((row) => row.type)).toEqual(["transaction_submitted", "lookup_unreachable"]);
  });

  it("連不上 Apple 時不擋購買,記 lookup_unreachable", async () => {
    const me = await member();
    identityProviders.appStoreApiHandler = () => Promise.reject(new TypeError("network down"));
    const submit = await submitTransaction(me.accessToken, { appAccountToken: me.id });
    expect(submit.status).toBe(200);
    expect(submit.body.subscription.status).toBe("active");
    expect((await events()).map((row) => row.type)).toEqual(["transaction_submitted", "lookup_unreachable"]);
  });
});

describe("setAppAccountToken(#27 轉移用)", () => {
  it("PUT /inApps/v1/transactions/{id}/appAccountToken,帶正確的 JWT 與 body", async () => {
    identityProviders.appStoreApiHandler = () => ({ status: 200 });

    await setAppAccountToken(env, "2000000000000001", TOKEN, "Sandbox");

    expect(identityProviders.appStoreApiCalls).toMatchObject([
      { method: "PUT", environment: "sandbox", path: "/inApps/v1/transactions/2000000000000001/appAccountToken", jwtValid: true, body: { appAccountToken: TOKEN } },
    ]);
  });

  it("Production 打 Production 主機", async () => {
    identityProviders.appStoreApiHandler = () => ({ status: 200 });
    await setAppAccountToken(env, "2000000000000001", TOKEN, "Production");
    expect(identityProviders.appStoreApiCalls[0]?.environment).toBe("production");
  });

  it("Apple 拒絕(404 交易不存在)丟 AppStoreApiError,帶 errorCode", async () => {
    identityProviders.appStoreApiHandler = () => ({ status: 404, body: { errorCode: 4040005 } });
    const attempt = setAppAccountToken(env, "x", TOKEN, "Sandbox");
    await expect(attempt).rejects.toBeInstanceOf(AppStoreApiError);
    await expect(attempt).rejects.toMatchObject({ status: 404, errorCode: 4040005 });
  });

  it("Apple 暫時不可用(500、429、連不上)丟 AppStoreApiUnavailable,呼叫端可以重試", async () => {
    identityProviders.appStoreApiHandler = () => ({ status: 500 });
    await expect(setAppAccountToken(env, "x", TOKEN, "Sandbox")).rejects.toBeInstanceOf(AppStoreApiUnavailable);
    identityProviders.appStoreApiHandler = () => ({ status: 429 });
    await expect(setAppAccountToken(env, "x", TOKEN, "Sandbox")).rejects.toBeInstanceOf(AppStoreApiUnavailable);
    identityProviders.appStoreApiHandler = () => Promise.reject(new TypeError("down"));
    await expect(setAppAccountToken(env, "x", TOKEN, "Sandbox")).rejects.toBeInstanceOf(AppStoreApiUnavailable);
  });
});
