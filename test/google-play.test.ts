import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { hasActiveSubscription } from "../src/subscriptions";
import { submitTransaction, subscriptionOf } from "./app-store";
import { api, identityProviders, pubSubToken, signInWithApple } from "./fakes";
import { acknowledgements, bindGoogle, DAY, lookups, PACKAGE, PLAY_MONTHLY, PLAY_YEARLY, purchase, sendRtdn, serveGoogle } from "./google-play";

async function member(subject = "apple-user-1", email?: string) {
  const signIn = await signInWithApple(subject, email ? { email } : {});
  return { accessToken: signIn.body.accessToken as string, id: signIn.body.member.id as string };
}

async function stored(token: string) {
  return env.DB.prepare("SELECT status, store, product_id, environment, expires_at, auto_renew, revoked_at, member_id FROM subscriptions WHERE external_id = ?")
    .bind(token)
    .first<{ status: string; store: string; product_id: string; environment: string; expires_at: number; auto_renew: number | null; revoked_at: number | null; member_id: string }>();
}

async function events() {
  const { results } = await env.DB.prepare(
    `SELECT e.source, e.type, e.notification_uuid, s.external_id FROM subscription_events e
     JOIN subscriptions s ON s.id = e.subscription_id ORDER BY e.received_at, e.rowid`,
  ).all<{ source: string; type: string; notification_uuid: string | null; external_id: string }>();
  return results;
}

describe("綁定 Google Play 訂閱", () => {
  it("向 Google 查證後寫入 google_play 訂閱,Plus 權限有效,GET 顯示商店", async () => {
    const me = await member();
    const expiry = Date.now() + 29 * DAY;
    serveGoogle({ tokenA: purchase({ expiryTime: expiry, testPurchase: true }) });

    const bind = await bindGoogle(me.accessToken, "tokenA");

    expect(bind.status).toBe(200);
    const expected = { status: "active", store: "google_play", productId: PLAY_MONTHLY, expiresAt: new Date(expiry).toISOString(), willAutoRenew: true };
    expect(bind.body.subscription).toMatchObject(expected);
    expect((await subscriptionOf(me.accessToken)).body.subscription).toMatchObject(expected);
    expect(await hasActiveSubscription(env, me.id)).toBe(true);
    expect(await stored("tokenA")).toMatchObject({ status: "active", store: "google_play", environment: "sandbox", member_id: me.id });
    // 認證:服務帳戶 JWT 換 access token、帶 Bearer 查 subscriptionsv2。
    expect(identityProviders.googleTokenCalls).toEqual([{ assertionValid: true, grantType: "urn:ietf:params:oauth:grant-type:jwt-bearer" }]);
    expect(lookups()).toMatchObject([{ path: `/androidpublisher/v3/applications/${PACKAGE}/purchases/subscriptionsv2/tokens/tokenA`, authorized: true }]);
  });

  it("正式購買(沒有 testPurchase)是 production", async () => {
    const me = await member();
    serveGoogle({ tokenA: purchase() });
    await bindGoogle(me.accessToken, "tokenA");
    expect((await stored("tokenA"))?.environment).toBe("production");
  });

  it("還沒 acknowledge 的新購買由後台 acknowledge;已 acknowledge 的不重送", async () => {
    const me = await member();
    serveGoogle({ pending: purchase({ acknowledged: false }), done: purchase({ acknowledged: true }) });

    await bindGoogle(me.accessToken, "pending");
    expect(acknowledgements()).toMatchObject([
      { method: "POST", path: `/androidpublisher/v3/applications/${PACKAGE}/purchases/subscriptions/${PLAY_MONTHLY}/tokens/pending:acknowledge`, authorized: true },
    ]);

    identityProviders.googlePlayCalls = [];
    const other = await member("apple-user-2");
    await bindGoogle(other.accessToken, "done");
    expect(acknowledgements()).toEqual([]);
  });

  it("acknowledge 失敗不擋綁定,記事件,之後重新查證時補送", async () => {
    const me = await member();
    serveGoogle({ pending: purchase({ acknowledged: false }) });
    const normal = identityProviders.googlePlayHandler;
    identityProviders.googlePlayHandler = (call) => (call.method === "POST" ? { status: 500 } : normal(call));

    const bind = await bindGoogle(me.accessToken, "pending");
    expect(bind.status).toBe(200);
    expect((await events()).map((event) => event.type)).toContain("acknowledge_failed");

    identityProviders.googlePlayHandler = normal;
    identityProviders.googlePlayCalls = [];
    await sendRtdn({ type: 2, token: "pending" });
    expect(acknowledgements()).toHaveLength(1);
  });

  it("商品不在白名單(body 的 productId 或 Google 回的商品)回 400 invalid_purchase", async () => {
    const me = await member();
    serveGoogle({ tokenA: purchase({ productId: "other.product" }), tokenB: purchase() });

    const wrongBody = await bindGoogle(me.accessToken, "tokenB", "other.product");
    // 白名單外的商品不必問 Google。
    expect(identityProviders.googlePlayCalls).toEqual([]);
    const wrongStore = await bindGoogle(me.accessToken, "tokenA", PLAY_MONTHLY);

    expect(wrongBody.status).toBe(400);
    expect(wrongBody.body.error.code).toBe("invalid_purchase");
    expect(wrongStore.status).toBe(400);
    expect(wrongStore.body.error.code).toBe("invalid_purchase");
    expect(await stored("tokenA")).toBeNull();
    expect(await stored("tokenB")).toBeNull();
  });

  it("Google 查無此 token 回 400 invalid_purchase;缺欄位回 400 invalid_request", async () => {
    const me = await member();
    serveGoogle({});
    const unknown = await bindGoogle(me.accessToken, "nope");
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe("invalid_purchase");
    const missing = await api("POST", "/v1/members/me/subscription/google-play", { accessToken: me.accessToken, body: { productId: PLAY_MONTHLY } });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe("invalid_request");
  });

  it("Google 連不上、token 端點拒絕時回 502 store_unavailable,不寫入", async () => {
    const me = await member();
    identityProviders.googlePlayHandler = () => ({ status: 503 });
    const down = await bindGoogle(me.accessToken, "tokenA");
    expect(down.status).toBe(502);
    expect(down.body.error.code).toBe("store_unavailable");
    identityProviders.googleTokenStatus = 400;
    const denied = await bindGoogle(me.accessToken, "tokenA");
    expect(denied.status).toBe(502);
    expect(await stored("tokenA")).toBeNull();
  });

  it("沒設定服務帳戶金鑰(Android 上線前)時綁定回 502 store_unavailable,不寫入", async () => {
    const me = await member();
    serveGoogle({ tokenA: purchase({ expiryTime: Date.now() + 29 * DAY }) });
    const optionalEnv = env as { GOOGLE_PLAY_SERVICE_ACCOUNT_KEY?: string };
    const original = optionalEnv.GOOGLE_PLAY_SERVICE_ACCOUNT_KEY;
    delete optionalEnv.GOOGLE_PLAY_SERVICE_ACCOUNT_KEY;
    try {
      const bind = await bindGoogle(me.accessToken, "tokenA");
      expect(bind.status).toBe(502);
      expect(bind.body.error.code).toBe("store_unavailable");
      expect(await stored("tokenA")).toBeNull();
    } finally {
      optionalEnv.GOOGLE_PLAY_SERVICE_ACCOUNT_KEY = original;
    }
  });

  it("沒登入回 401", async () => {
    expect((await api("POST", "/v1/members/me/subscription/google-play", { body: { purchaseToken: "x", productId: PLAY_MONTHLY } })).status).toBe(401);
  });
});

describe("Google 訂閱狀態對應", () => {
  const cases: { name: string; options: Parameters<typeof purchase>[0]; stored: string; view: string }[] = [
    { name: "ACTIVE -> active", options: {}, stored: "active", view: "active" },
    { name: "CANCELED、還沒到期 -> active(不續訂)", options: { subscriptionState: "SUBSCRIPTION_STATE_CANCELED", autoRenewEnabled: false }, stored: "active", view: "active" },
    { name: "CANCELED、已過期 -> expired", options: { subscriptionState: "SUBSCRIPTION_STATE_CANCELED", expiryTime: Date.now() - DAY }, stored: "expired", view: "expired" },
    { name: "IN_GRACE_PERIOD -> grace", options: { subscriptionState: "SUBSCRIPTION_STATE_IN_GRACE_PERIOD", expiryTime: Date.now() - DAY }, stored: "grace", view: "in_grace_period" },
    { name: "ON_HOLD -> billing_retry(沒有 Plus 權限)", options: { subscriptionState: "SUBSCRIPTION_STATE_ON_HOLD", expiryTime: Date.now() - DAY }, stored: "billing_retry", view: "expired" },
    { name: "EXPIRED -> expired", options: { subscriptionState: "SUBSCRIPTION_STATE_EXPIRED", expiryTime: Date.now() - DAY }, stored: "expired", view: "expired" },
    { name: "PAUSED -> expired", options: { subscriptionState: "SUBSCRIPTION_STATE_PAUSED", expiryTime: Date.now() - DAY }, stored: "expired", view: "expired" },
    { name: "PENDING -> 沒有權限", options: { subscriptionState: "SUBSCRIPTION_STATE_PENDING" }, stored: "expired", view: "expired" },
  ];
  for (const item of cases) {
    it(item.name, async () => {
      const me = await member();
      serveGoogle({ tokenA: purchase(item.options) });
      const bind = await bindGoogle(me.accessToken, "tokenA");
      expect(bind.status).toBe(200);
      expect((await stored("tokenA"))?.status).toBe(item.stored);
      expect(bind.body.subscription.status).toBe(item.view);
      expect(await hasActiveSubscription(env, me.id)).toBe(item.view === "active" || item.view === "in_grace_period");
    });
  }
});

describe("一會員一訂閱跨商店", () => {
  it("已有有效的 App Store 訂閱時綁定 Google Play 回 409 subscription_already_active", async () => {
    const me = await member();
    await submitTransaction(me.accessToken, { appAccountToken: me.id });
    serveGoogle({ tokenA: purchase() });

    const bind = await bindGoogle(me.accessToken, "tokenA");

    expect(bind.status).toBe(409);
    expect(bind.body.error.code).toBe("subscription_already_active");
    expect(await stored("tokenA")).toBeNull();
  });

  it("已有有效的 Google Play 訂閱時提交 App Store 交易回 409 subscription_already_active", async () => {
    const me = await member();
    serveGoogle({ tokenA: purchase() });
    await bindGoogle(me.accessToken, "tokenA");

    const submit = await submitTransaction(me.accessToken, { appAccountToken: me.id });

    expect(submit.status).toBe(409);
    expect(submit.body.error.code).toBe("subscription_already_active");
  });

  it("Google Play 帳單重試期(on hold)沒有權限,會員重新購買時讓位成 expired(與 App Store 的 billing_retry 相同)", async () => {
    const me = await member();
    serveGoogle({ held: purchase({ subscriptionState: "SUBSCRIPTION_STATE_ON_HOLD", expiryTime: Date.now() - DAY }), tokenB: purchase() });
    await bindGoogle(me.accessToken, "held");
    expect((await bindGoogle(me.accessToken, "tokenB")).status).toBe(200);
    expect((await stored("held"))?.status).toBe("expired");
  });

  it("舊訂閱已經到期時可以改綁另一個商店", async () => {
    const me = await member();
    await submitTransaction(me.accessToken, { appAccountToken: me.id, expiresDate: Date.now() - DAY });
    serveGoogle({ tokenA: purchase() });
    const bind = await bindGoogle(me.accessToken, "tokenA");
    expect(bind.status).toBe(200);
    expect(bind.body.subscription.store).toBe("google_play");
  });
});

describe("purchase token 屬於另一個會員", () => {
  it("回 409 subscription_in_use,details 帶遮蔽 email 與 canTransfer", async () => {
    const owner = await member("owner", "owner@example.com");
    const other = await member("other");
    serveGoogle({ tokenA: purchase() });
    await bindGoogle(owner.accessToken, "tokenA");

    const bind = await bindGoogle(other.accessToken, "tokenA");

    expect(bind.status).toBe(409);
    expect(bind.body.error.code).toBe("subscription_in_use");
    expect(bind.body.error.details).toEqual({ ownerEmail: "o***@example.com", canTransfer: true });
    expect((await stored("tokenA"))?.member_id).toBe(owner.id);
  });

  it("提交者自己已有有效訂閱時 canTransfer 是 false", async () => {
    const owner = await member("owner", "owner@example.com");
    const other = await member("other");
    await submitTransaction(other.accessToken, { appAccountToken: other.id });
    serveGoogle({ tokenA: purchase() });
    await bindGoogle(owner.accessToken, "tokenA");

    const bind = await bindGoogle(other.accessToken, "tokenA");

    expect(bind.body.error.details.canTransfer).toBe(false);
  });

  it("購買時帶的 obfuscatedAccountId 是另一個現有會員也不能領走", async () => {
    const buyer = await member("buyer");
    const thief = await member("thief");
    serveGoogle({ tokenA: purchase({ obfuscatedAccountId: buyer.id }) });

    const bind = await bindGoogle(thief.accessToken, "tokenA");

    expect(bind.status).toBe(409);
    expect(bind.body.error.code).toBe("subscription_in_use");
  });

  it("同一個會員重複綁定同一個 token 冪等", async () => {
    const me = await member();
    serveGoogle({ tokenA: purchase() });
    await bindGoogle(me.accessToken, "tokenA");
    expect((await bindGoogle(me.accessToken, "tokenA")).status).toBe(200);
    const { results } = await env.DB.prepare("SELECT 1 FROM subscriptions").all();
    expect(results).toHaveLength(1);
  });
});

describe("linkedPurchaseToken(升降級、重新訂閱)", () => {
  it("新 token 綁定後舊 token 失效,同一會員不會被一會員一訂閱擋下", async () => {
    const me = await member();
    serveGoogle({ old: purchase(), fresh: purchase({ linkedPurchaseToken: "old", productId: PLAY_YEARLY }) });
    await bindGoogle(me.accessToken, "old");

    const bind = await bindGoogle(me.accessToken, "fresh", PLAY_YEARLY);

    expect(bind.status).toBe(200);
    expect(bind.body.subscription.productId).toBe(PLAY_YEARLY);
    expect((await stored("old"))?.status).toBe("expired");
    expect((await stored("fresh"))?.status).toBe("active");
  });

  it("舊 token 屬於另一個會員時不能綁(409 subscription_in_use)", async () => {
    const owner = await member("owner");
    const other = await member("other");
    serveGoogle({ old: purchase(), fresh: purchase({ linkedPurchaseToken: "old" }) });
    await bindGoogle(owner.accessToken, "old");

    const bind = await bindGoogle(other.accessToken, "fresh");

    expect(bind.status).toBe(409);
    expect(bind.body.error.code).toBe("subscription_in_use");
  });

  it("通知帶來的新 token(先於 app 提交)依舊 token 找到會員並綁上", async () => {
    const me = await member();
    serveGoogle({ old: purchase(), fresh: purchase({ linkedPurchaseToken: "old" }) });
    await bindGoogle(me.accessToken, "old");

    const response = await sendRtdn({ type: 4, token: "fresh" });

    expect(response.status).toBe(200);
    expect((await stored("fresh"))?.member_id).toBe(me.id);
    expect((await stored("old"))?.status).toBe("expired");
    expect(await hasActiveSubscription(env, me.id)).toBe(true);
  });
});

describe("RTDN 的 OIDC 驗證", () => {
  const bad: [string, Parameters<typeof sendRtdn>[1]][] = [
    ["沒有 Bearer token", { auth: null }],
    ["簽章不是 Google 的", { auth: { forged: true } }],
    ["audience 不對", { auth: { audience: "https://evil.example/hook" } }],
    ["email 不是設定的服務帳戶", { auth: { email: "attacker@example.iam.gserviceaccount.com" } }],
    ["email_verified 不是 true", { auth: { emailVerified: false } }],
    ["issuer 不對", { auth: { issuer: "https://evil.example" } }],
    ["已過期", { auth: { expiresIn: "-1m" } }],
  ];
  for (const [name, options] of bad) {
    it(`${name}回 401 且不處理`, async () => {
      const me = await member();
      serveGoogle({ tokenA: purchase() });
      await bindGoogle(me.accessToken, "tokenA");
      identityProviders.googlePlayCalls = [];

      const response = await sendRtdn({ type: 13, token: "tokenA" }, options);

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe("invalid_notification");
      expect(identityProviders.googlePlayCalls).toEqual([]);
    });
  }
});

describe("RTDN 通知處理", () => {
  async function bound(options: Parameters<typeof purchase>[0] = {}) {
    const me = await member();
    const purchases = serveGoogle({ tokenA: purchase(options) });
    await bindGoogle(me.accessToken, "tokenA");
    return { me, purchases };
  }

  it("訊息以 messageId 冪等:重送回 200、不再查證、只記一筆事件", async () => {
    await bound();
    const first = await sendRtdn({ type: 2, token: "tokenA" }, { messageId: "msg-1" });
    const calls = identityProviders.googlePlayCalls.length;
    await env.DB.prepare("UPDATE subscriptions SET expires_at = 1234").run();

    const again = await sendRtdn({ type: 2, token: "tokenA" }, { messageId: "msg-1" });

    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(identityProviders.googlePlayCalls).toHaveLength(calls);
    expect((await stored("tokenA"))?.expires_at).toBe(1234);
    expect((await events()).filter((event) => event.source === "store_notification")).toEqual([
      { source: "store_notification", type: "RENEWED", notification_uuid: "gp:msg-1", external_id: "tokenA" },
    ]);
  });

  it("收到通知後重新查證:續訂更新到期時間", async () => {
    const { purchases } = await bound();
    const renewed = Date.now() + 60 * DAY;
    purchases.tokenA = purchase({ expiryTime: renewed });

    await sendRtdn({ type: 2, token: "tokenA" });

    expect((await stored("tokenA"))?.expires_at).toBe(renewed);
  });

  const transitions: { name: string; type: number; options: Parameters<typeof purchase>[0]; expected: string }[] = [
    { name: "IN_GRACE_PERIOD -> grace", type: 6, options: { subscriptionState: "SUBSCRIPTION_STATE_IN_GRACE_PERIOD", expiryTime: Date.now() - DAY }, expected: "grace" },
    { name: "ON_HOLD -> billing_retry", type: 5, options: { subscriptionState: "SUBSCRIPTION_STATE_ON_HOLD", expiryTime: Date.now() - DAY }, expected: "billing_retry" },
    { name: "EXPIRED -> expired", type: 13, options: { subscriptionState: "SUBSCRIPTION_STATE_EXPIRED", expiryTime: Date.now() - DAY }, expected: "expired" },
    { name: "CANCELED(未到期)仍 active", type: 3, options: { subscriptionState: "SUBSCRIPTION_STATE_CANCELED", autoRenewEnabled: false }, expected: "active" },
    { name: "RECOVERED -> active", type: 1, options: {}, expected: "active" },
  ];
  for (const item of transitions) {
    it(`狀態轉換:${item.name}`, async () => {
      const { purchases } = await bound();
      purchases.tokenA = purchase(item.options);
      const response = await sendRtdn({ type: item.type, token: "tokenA" });
      expect(response.status).toBe(200);
      expect((await stored("tokenA"))?.status).toBe(item.expected);
    });
  }

  it("CANCELED 通知更新 auto_renew", async () => {
    const { purchases } = await bound();
    purchases.tokenA = purchase({ subscriptionState: "SUBSCRIPTION_STATE_CANCELED", autoRenewEnabled: false });
    await sendRtdn({ type: 3, token: "tokenA" });
    expect((await stored("tokenA"))?.auto_renew).toBe(0);
  });

  it("SUBSCRIPTION_REVOKED(12) -> revoked(Google 這時回 EXPIRED,撤銷只能靠通知),Plus 權限立刻失效", async () => {
    const { me, purchases } = await bound();
    purchases.tokenA = purchase({ subscriptionState: "SUBSCRIPTION_STATE_EXPIRED", expiryTime: Date.now() + 10 * DAY });

    await sendRtdn({ type: 12, token: "tokenA" });

    const row = await stored("tokenA");
    expect(row?.status).toBe("revoked");
    expect(row?.revoked_at).not.toBeNull();
    expect(await hasActiveSubscription(env, me.id)).toBe(false);
    expect((await subscriptionOf(me.accessToken)).body.subscription.status).toBe("revoked");
  });

  it("已撤銷的訂閱不會被之後的通知復活", async () => {
    const { me, purchases } = await bound();
    await sendRtdn({ type: 12, token: "tokenA" });
    purchases.tokenA = purchase();

    await sendRtdn({ type: 2, token: "tokenA" });

    expect((await stored("tokenA"))?.status).toBe("revoked");
    expect(await hasActiveSubscription(env, me.id)).toBe(false);
  });

  it("voidedPurchaseNotification(訂閱退款)-> refunded 並撤銷權限", async () => {
    const { me } = await bound();
    await sendRtdn({ voidedToken: "tokenA" });
    expect((await stored("tokenA"))?.status).toBe("refunded");
    expect(await hasActiveSubscription(env, me.id)).toBe(false);
  });

  it("不認得的 token(沒綁過、沒有可歸屬的會員)回 200 略過,不記事件", async () => {
    serveGoogle({ stranger: purchase() });
    const response = await sendRtdn({ type: 4, token: "stranger" });
    expect(response.status).toBe(200);
    expect(await stored("stranger")).toBeNull();
    expect(await events()).toEqual([]);
  });

  it("測試通知、別的 package、一次性商品通知回 200 略過", async () => {
    await bound();
    identityProviders.googlePlayCalls = [];
    expect((await sendRtdn({ test: true })).status).toBe(200);
    expect((await sendRtdn({ type: 13, token: "tokenA" }, { packageName: "com.someone.else" })).status).toBe(200);
    expect((await sendRtdn({ raw: { version: "1.0", packageName: PACKAGE, oneTimeProductNotification: { sku: "x", purchaseToken: "tokenA", notificationType: 1 } } })).status).toBe(200);
    expect(identityProviders.googlePlayCalls).toEqual([]);
    expect((await stored("tokenA"))?.status).toBe("active");
  });

  it("訊息格式壞掉回 200(重送也不會好)", async () => {
    const response = await api("POST", "/v1/google-play/notifications", {
      headers: { authorization: `Bearer ${await pubSubToken()}` },
      body: { message: { data: "!!!not-base64-json", messageId: "m" } },
    });
    expect(response.status).toBe(200);
  });

  it("重新查證失敗(Google 連不上)回 503 讓 Pub/Sub 重送,messageId 不算處理過;恢復後重送成功", async () => {
    const { purchases } = await bound();
    const renewed = Date.now() + 60 * DAY;
    purchases.tokenA = purchase({ expiryTime: renewed });
    const healthy = identityProviders.googlePlayHandler;
    identityProviders.googlePlayHandler = () => ({ status: 503 });

    const failed = await sendRtdn({ type: 2, token: "tokenA" }, { messageId: "msg-retry" });
    expect(failed.status).toBe(503);

    identityProviders.googlePlayHandler = healthy;
    const retried = await sendRtdn({ type: 2, token: "tokenA" }, { messageId: "msg-retry" });
    expect(retried.status).toBe(200);
    expect((await stored("tokenA"))?.expires_at).toBe(renewed);
  });
});
