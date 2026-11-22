import { createRemoteJWKSet, errors, jwtVerify } from "jose";
import {
  acknowledgePurchase,
  getSubscriptionPurchase,
  GooglePlayApiError,
  GooglePlayApiUnavailable,
  type SubscriptionPurchase,
} from "./google-play-api";
import { ApiError } from "./http";
import {
  memberExists,
  notificationSeen,
  ONE_LIVE_SUBSCRIPTION,
  ownerDetails,
  recordStoreEvent,
  subscriptionView,
  type StoredStatus,
  type SubscriptionView,
} from "./subscriptions";

/// Google Play 串接(#26):與 App Store 並列的第二個訂閱來源。
///
/// 兩條寫入路徑:Android app 提交 purchase token(綁定)、Real-time developer notifications(RTDN,Pub/Sub push)。
/// 兩者都不信任請求內容本身,一律拿 purchase token 向 Google Play Developer API(purchases.subscriptionsv2.get)查證,
/// 以 Google 回的狀態為準。`subscriptions.external_id` 是 purchase token(Google 保證全域唯一)。

const DAY = 86_400_000;
const EVENT_PREFIX = "gp:";

/// RTDN `notificationType` 的名稱(只用在事件紀錄)。
const NOTIFICATION_TYPES: Record<number, string> = {
  1: "RECOVERED",
  2: "RENEWED",
  3: "CANCELED",
  4: "PURCHASED",
  5: "ON_HOLD",
  6: "IN_GRACE_PERIOD",
  7: "RESTARTED",
  9: "DEFERRED",
  10: "PAUSED",
  11: "PAUSE_SCHEDULE_CHANGED",
  12: "REVOKED",
  13: "EXPIRED",
  17: "ITEMS_CHANGED",
  18: "CANCELLATION_SCHEDULED",
  19: "PRICE_CHANGE_UPDATED",
  20: "PENDING_PURCHASE_CANCELED",
  21: "PLAN_TRANSITION_UPDATED",
  22: "PRICE_STEP_UP_CONSENT_UPDATED",
};
const REVOKED_NOTIFICATION = 12;

function plusProductIds(env: Env): Set<string> {
  return new Set((env.GOOGLE_PLAY_PRODUCT_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean));
}

function invalidPurchase(reason: string): ApiError {
  return new ApiError(400, "invalid_purchase", `The Google Play purchase couldn't be verified: ${reason}`);
}

// MARK: - 狀態對應

type Applied = { status: StoredStatus; expiresAt: number; graceExpiresAt: number | null };

/// Google 的 `subscriptionState` 對應到我們存的狀態(依 Google 的存取規則):
/// ACTIVE 與 CANCELED(已取消、存取到 expiryTime 為止)在 expiryTime 之前有權限;IN_GRACE_PERIOD 是 grace;
/// ON_HOLD 是 billing_retry(沒有權限、名額還在);其餘(EXPIRED、PAUSED、PENDING、PENDING_PURCHASE_CANCELED…)沒有權限。
/// 沒有權限的狀態把到期時間壓到現在以前,免得之後依時間推算又變成有效。
/// **撤銷沒有獨立的 subscriptionState**(撤銷後 Google 回 EXPIRED),只能靠通知,由呼叫端以 `override` 指定。
function appliedState(purchase: SubscriptionPurchase, now: number, override: "revoked" | "refunded" | null): Applied {
  const expiry = purchase.expiryTime;
  if (override !== null) {
    return { status: override, expiresAt: Math.min(expiry, now), graceExpiresAt: null };
  }
  switch (purchase.subscriptionState) {
    case "SUBSCRIPTION_STATE_ACTIVE":
    case "SUBSCRIPTION_STATE_CANCELED":
      return expiry > now ? { status: "active", expiresAt: expiry, graceExpiresAt: null } : { status: "expired", expiresAt: expiry, graceExpiresAt: null };
    case "SUBSCRIPTION_STATE_IN_GRACE_PERIOD":
      // Google 沒有回寬限期結束時間;expiryTime 還沒到就以它為準,否則先給一天,寬限期結束時 Google 會通知(ON_HOLD 或 EXPIRED)。
      return { status: "grace", expiresAt: expiry, graceExpiresAt: expiry > now ? expiry : now + DAY };
    case "SUBSCRIPTION_STATE_ON_HOLD":
      return { status: "billing_retry", expiresAt: Math.min(expiry, now), graceExpiresAt: null };
    default:
      return { status: "expired", expiresAt: Math.min(expiry, now), graceExpiresAt: null };
  }
}

// MARK: - 資料庫

async function ownerOf(env: Env, purchaseToken: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT member_id FROM subscriptions WHERE store = 'google_play' AND external_id = ?")
    .bind(purchaseToken)
    .first<{ member_id: string }>();
  return row?.member_id ?? null;
}

/// 寫入查證後的訂閱。已撤銷(`revoked_at` 有值)的訂閱不會被覆寫:Google 撤銷後查回來是 EXPIRED,不能把它救活。
///
/// 寫入前先把這個會員已經到期的有效列改成 expired(沒收到到期通知的舊列不該佔著名額),
/// 再讓 `linkedPurchaseToken` 指的舊 token 失效(升降級、重新訂閱:舊的失效、新的接手,同一會員不被一會員一訂閱擋下)。
async function applyPurchase(env: Env, memberId: string, purchaseToken: string, purchase: SubscriptionPurchase, override: "revoked" | "refunded" | null = null): Promise<Applied> {
  const now = Date.now();
  const applied = appliedState(purchase, now, override);
  try {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE subscriptions SET status = 'expired', updated_at = ?1
         WHERE member_id = ?2 AND status IN ('active', 'grace', 'billing_retry') AND revoked_at IS NULL
           AND expires_at <= ?1 AND COALESCE(grace_expires_at, 0) <= ?1
           AND NOT (store = 'google_play' AND external_id = ?3)`,
      ).bind(now, memberId, purchaseToken),
      env.DB.prepare(
        `UPDATE subscriptions SET status = 'expired', expires_at = MIN(expires_at, ?1), grace_expires_at = NULL, updated_at = ?1
         WHERE store = 'google_play' AND external_id = ?2 AND revoked_at IS NULL`,
      ).bind(now, purchase.linkedPurchaseToken ?? ""),
      env.DB.prepare(
        `INSERT INTO subscriptions (id, member_id, store, external_id, product_id, status, expires_at, auto_renew, environment, updated_at,
           current_transaction_id, purchased_at, revoked_at, grace_expires_at)
         VALUES (?1, ?2, 'google_play', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT (store, external_id) DO UPDATE SET
           product_id = excluded.product_id, status = excluded.status, expires_at = excluded.expires_at, auto_renew = excluded.auto_renew,
           environment = excluded.environment, updated_at = excluded.updated_at, current_transaction_id = excluded.current_transaction_id,
           purchased_at = excluded.purchased_at, revoked_at = excluded.revoked_at, grace_expires_at = excluded.grace_expires_at
         WHERE subscriptions.revoked_at IS NULL`,
      ).bind(
        crypto.randomUUID(),
        memberId,
        purchaseToken,
        purchase.productId,
        applied.status,
        applied.expiresAt,
        purchase.autoRenewEnabled === null ? null : purchase.autoRenewEnabled ? 1 : 0,
        purchase.testPurchase ? "sandbox" : "production",
        now,
        purchase.latestOrderId,
        purchase.startTime,
        override === null ? null : now,
        applied.graceExpiresAt,
      ),
    ]);
  } catch (error) {
    if (error instanceof Error && ONE_LIVE_SUBSCRIPTION.test(error.message)) {
      throw new ApiError(409, "subscription_already_active", "This member already has an active subscription.");
    }
    throw error;
  }
  return applied;
}

/// 新購買要在 3 天內 acknowledge,否則 Google 自動退款並撤銷。有權限的狀態才送;失敗不擋流程,記 `acknowledge_failed`,
/// 下一次查證(通知或重新提交)看到還沒 acknowledge 會再送。這個函式不丟例外。
async function acknowledgeIfNeeded(env: Env, purchaseToken: string, purchase: SubscriptionPurchase, applied: Applied): Promise<void> {
  if (purchase.acknowledged || (applied.status !== "active" && applied.status !== "grace")) {
    return;
  }
  try {
    await acknowledgePurchase(env, purchase.productId, purchaseToken);
  } catch (error) {
    if (error instanceof GooglePlayApiError || error instanceof GooglePlayApiUnavailable) {
      await recordStoreEvent(env, "google_play", purchaseToken, "store_api", "acknowledge_failed");
      return;
    }
    throw error;
  }
  await recordStoreEvent(env, "google_play", purchaseToken, "store_api", "acknowledged");
}

// MARK: - 綁定

/// POST /v1/members/me/subscription/google-play:Android app 購買後提交 purchase token 與商品 ID。
///
/// 向 Google 查證(Google 查不到回 400 `invalid_purchase`、連不上回 502 `store_unavailable`,這條路徑只有 Google 能證明購買,所以不放行)。
/// 歸屬:已登記的 token 只屬於原會員;`linkedPurchaseToken` 的舊 token 屬於另一個會員、或購買時帶的 `obfuscatedAccountId`
/// 是另一個現有會員,也不能領走(409 `subscription_in_use`)。不實作 Google 的訂閱轉移。
export async function submitGooglePlayPurchase(env: Env, memberId: string, purchaseToken: string, productId: string): Promise<SubscriptionView | null> {
  const products = plusProductIds(env);
  if (!products.has(productId)) {
    throw invalidPurchase("product");
  }
  const purchase = await lookup(env, purchaseToken, "bind");
  if (purchase === null) {
    throw invalidPurchase("unknown purchase token");
  }
  if (purchase.productId !== productId || !products.has(purchase.productId)) {
    throw invalidPurchase("product");
  }
  const owner = (await ownerOf(env, purchaseToken)) ?? (purchase.linkedPurchaseToken === null ? null : await ownerOf(env, purchase.linkedPurchaseToken));
  const claimedBy =
    owner ??
    (purchase.obfuscatedAccountId !== null && purchase.obfuscatedAccountId.toLowerCase() !== memberId && (await memberExists(env, purchase.obfuscatedAccountId.toLowerCase()))
      ? purchase.obfuscatedAccountId.toLowerCase()
      : null);
  if (claimedBy !== null && claimedBy !== memberId) {
    throw new ApiError(409, "subscription_in_use", "This Google Play subscription belongs to another Purrdr member.", {}, await ownerDetails(env, claimedBy, memberId));
  }
  const applied = await applyPurchase(env, memberId, purchaseToken, purchase);
  await recordStoreEvent(env, "google_play", purchaseToken, "client", "purchase_submitted");
  await acknowledgeIfNeeded(env, purchaseToken, purchase, applied);
  return subscriptionView(env, memberId);
}

/// 向 Google 查證;暫時問不到時綁定回 502、通知回 503(讓 Pub/Sub 重送)。
async function lookup(env: Env, purchaseToken: string, mode: "bind" | "notification"): Promise<SubscriptionPurchase | null> {
  try {
    return await getSubscriptionPurchase(env, purchaseToken);
  } catch (error) {
    if (error instanceof GooglePlayApiUnavailable) {
      throw mode === "bind"
        ? new ApiError(502, "store_unavailable", "Couldn't reach Google Play.")
        : new ApiError(503, "store_unavailable", "Couldn't reach Google Play.");
    }
    throw error;
  }
}

// MARK: - Real-time developer notifications

const pubSubKeys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

function invalidNotification(reason: string): ApiError {
  return new ApiError(401, "invalid_notification", `The Google Play notification couldn't be verified: ${reason}`);
}

/// 驗 Pub/Sub push 的 OIDC Bearer token:Google 簽章(公布的 JWKS)、iss、aud(`GOOGLE_PLAY_PUBSUB_AUDIENCE`)、exp,
/// 且 `email` 是設定的服務帳戶(`GOOGLE_PLAY_PUBSUB_SERVICE_ACCOUNT_EMAIL`)並 `email_verified` 是 true。沒設定一律拒絕。
async function verifyPubSubRequest(env: Env, request: Request): Promise<void> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice("bearer ".length).trim() : "";
  const audience = env.GOOGLE_PLAY_PUBSUB_AUDIENCE;
  const email = env.GOOGLE_PLAY_PUBSUB_SERVICE_ACCOUNT_EMAIL;
  if (token === "" || !audience || audience === "REPLACE_ME" || !email || email === "REPLACE_ME") {
    throw invalidNotification("credentials");
  }
  try {
    const { payload } = await jwtVerify(token, pubSubKeys, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience,
      algorithms: ["RS256"],
    });
    if (payload.email !== email || payload.email_verified !== true) {
      throw invalidNotification("service account");
    }
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    if (error instanceof errors.JOSEError) {
      throw invalidNotification("token");
    }
    throw new ApiError(503, "store_unavailable", "Couldn't reach Google to verify the notification.");
  }
}

type DeveloperNotification = {
  packageName?: unknown;
  subscriptionNotification?: { notificationType?: unknown; purchaseToken?: unknown };
  voidedPurchaseNotification?: { purchaseToken?: unknown; productType?: unknown };
};

/// 解 Pub/Sub push 的 `message.data`(base64 的 DeveloperNotification JSON)。格式壞掉回 null(重送也不會好,回 200 略過)。
function decodeMessage(body: any): { messageId: string; notification: DeveloperNotification } | null {
  const message = body?.message;
  if (typeof message?.messageId !== "string" || typeof message?.data !== "string") {
    return null;
  }
  try {
    const bytes = Uint8Array.from(atob(message.data), (char) => char.charCodeAt(0));
    const notification = JSON.parse(new TextDecoder().decode(bytes));
    return typeof notification === "object" && notification !== null ? { messageId: message.messageId, notification } : null;
  } catch {
    return null;
  }
}

/// POST /v1/google-play/notifications:Pub/Sub push 的 RTDN。
///
/// 驗 OIDC token 後,以 `messageId` 冪等(重送直接回 200)。通知只代表「狀態變了」,所以一律重新向 Google 查證再更新:
/// 狀態對應同綁定;`SUBSCRIPTION_REVOKED`(12)記成 revoked、`voidedPurchaseNotification`(訂閱退款或 chargeback)記成 refunded,立刻撤銷權限。
/// 不認得的 token(沒綁過、`linkedPurchaseToken` 也找不到會員)、測試通知、別的 package、一次性商品通知、格式壞掉的訊息都回 200 略過。
/// Google 暫時查不到回 503,Pub/Sub 會重送(messageId 在成功處理後才記)。
export async function handleGooglePlayNotification(env: Env, request: Request): Promise<void> {
  await verifyPubSubRequest(env, request);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return;
  }
  const decoded = decodeMessage(body);
  if (decoded === null) {
    return;
  }
  const { messageId, notification } = decoded;
  const eventId = `${EVENT_PREFIX}${messageId}`;
  if (await notificationSeen(env, eventId)) {
    return;
  }
  if (notification.packageName !== env.GOOGLE_PLAY_PACKAGE_NAME) {
    return;
  }

  let purchaseToken: string;
  let type: string;
  let override: "revoked" | "refunded" | null = null;
  const sub = notification.subscriptionNotification;
  const voided = notification.voidedPurchaseNotification;
  if (sub && typeof sub.purchaseToken === "string" && typeof sub.notificationType === "number") {
    purchaseToken = sub.purchaseToken;
    type = NOTIFICATION_TYPES[sub.notificationType] ?? `TYPE_${sub.notificationType}`;
    override = sub.notificationType === REVOKED_NOTIFICATION ? "revoked" : null;
  } else if (voided && typeof voided.purchaseToken === "string" && voided.productType === 1) {
    purchaseToken = voided.purchaseToken;
    type = "VOIDED";
    override = "refunded";
  } else {
    return;
  }

  const purchase = await lookup(env, purchaseToken, "notification");
  let owner = await ownerOf(env, purchaseToken);
  if (owner === null && purchase !== null && purchase.linkedPurchaseToken !== null) {
    owner = await ownerOf(env, purchase.linkedPurchaseToken);
  }
  if (owner === null) {
    return;
  }
  if (purchase === null) {
    // Google 已查不到(超過過期後 60 天):撤銷與退款仍要生效,其餘沒有新資訊。
    if (override !== null) {
      await env.DB.prepare(
        `UPDATE subscriptions SET status = ?1, revoked_at = ?2, expires_at = MIN(expires_at, ?2), grace_expires_at = NULL, updated_at = ?2
         WHERE store = 'google_play' AND external_id = ?3 AND revoked_at IS NULL`,
      )
        .bind(override, Date.now(), purchaseToken)
        .run();
    }
    await recordStoreEvent(env, "google_play", purchaseToken, "store_notification", type, eventId);
    return;
  }
  if (!plusProductIds(env).has(purchase.productId)) {
    return;
  }
  let applied: Applied;
  try {
    applied = await applyPurchase(env, owner, purchaseToken, purchase, override);
  } catch (error) {
    if (error instanceof ApiError && error.code === "subscription_already_active") {
      // 會員另有佔名額的訂閱(例如已改訂 App Store):保留依時間推算的快照,通知不重送也不會成功。
      return;
    }
    throw error;
  }
  await recordStoreEvent(env, "google_play", purchaseToken, "store_notification", type, eventId);
  await acknowledgeIfNeeded(env, purchaseToken, purchase, applied);
}
