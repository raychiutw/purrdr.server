import {
  SignedDataError,
  verifySignedData,
  type NotificationPayload,
  type RenewalInfoPayload,
  type TransactionPayload,
} from "./app-store";
import { ApiError } from "./http";

/// 訂閱權限(Purrdr Plus,ADR-0007):權限記在會員身上，記錄來源商店。
///
/// 兩條寫入路徑：app 提交 StoreKit 2 交易(購買、恢復購買、兌換 Offer Code 後)、
/// App Store Server Notifications v2(續訂、到期、退款、撤銷…)。兩者都只信任 Apple 簽章的 JWS。

/// Purrdr Plus 的商品(與 app 的 `PlusProduct`、StoreKit 設定檔相同)。
export const PLUS_PRODUCT_IDS: ReadonlySet<string> = new Set(["com.raychiu.purrdr.plus.monthly", "com.raychiu.purrdr.plus.yearly"]);

/// App Review 與 TestFlight 用 Sandbox,所以正式後台兩種都收(Apple 建議的做法)。
/// StoreKit 設定檔(Xcode)簽的交易不是 Apple 憑證鏈，本來就驗不過。
const ACCEPTED_ENVIRONMENTS: ReadonlySet<string> = new Set(["Production", "Sandbox"]);

export type SubscriptionStatus = "active" | "in_grace_period" | "expired" | "revoked";

export type SubscriptionView = {
  status: SubscriptionStatus;
  store: "app_store" | "google_play";
  productId: string;
  expiresAt: string;
  gracePeriodExpiresAt: string | null;
  /** 還不知道(只收過 app 提交、還沒收過續訂資訊)時是 null。 */
  willAutoRenew: boolean | null;
};

type Row = {
  store: "app_store" | "google_play";
  member_id: string;
  product_id: string;
  current_transaction_id: string | null;
  purchased_at: number | null;
  expires_at: number;
  revoked_at: number | null;
  auto_renew: number | null;
  grace_expires_at: number | null;
};

function statusOf(row: Row, now: number): SubscriptionStatus {
  if (row.revoked_at !== null) {
    return "revoked";
  }
  if (row.expires_at > now) {
    return "active";
  }
  if (row.grace_expires_at !== null && row.grace_expires_at > now) {
    return "in_grace_period";
  }
  return "expired";
}

const isActive = (status: SubscriptionStatus) => status === "active" || status === "in_grace_period";

async function rowsOf(env: Env, memberId: string): Promise<Row[]> {
  const { results } = await env.DB.prepare("SELECT * FROM subscriptions WHERE member_id = ?").bind(memberId).all<Row>();
  return results;
}

/// 會員目前的訂閱：有效的優先，其次是最晚到期的;從來沒有訂閱過是 null。
export async function subscriptionView(env: Env, memberId: string, now = Date.now()): Promise<SubscriptionView | null> {
  const rows = (await rowsOf(env, memberId))
    .map((row) => ({ row, status: statusOf(row, now) }))
    .sort((a, b) => Number(isActive(b.status)) - Number(isActive(a.status)) || b.row.expires_at - a.row.expires_at);
  const best = rows[0];
  if (!best) {
    return null;
  }
  return {
    status: best.status,
    store: best.row.store,
    productId: best.row.product_id,
    expiresAt: new Date(best.row.expires_at).toISOString(),
    gracePeriodExpiresAt: best.row.grace_expires_at === null ? null : new Date(best.row.grace_expires_at).toISOString(),
    willAutoRenew: best.row.auto_renew === null ? null : best.row.auto_renew === 1,
  };
}

/// 給推播(#29)與主機同步(#30):會員現在有沒有 Purrdr Plus 權限(含帳單寬限期)。
export async function hasActiveSubscription(env: Env, memberId: string, now = Date.now()): Promise<boolean> {
  return (await rowsOf(env, memberId)).some((row) => isActive(statusOf(row, now)));
}

/// 沒有有效訂閱時丟 403 `subscription_required`。
export async function requireActiveSubscription(env: Env, memberId: string, now = Date.now()): Promise<void> {
  if (!(await hasActiveSubscription(env, memberId, now))) {
    throw new ApiError(403, "subscription_required", "This needs an active Purrdr Plus subscription.");
  }
}

// MARK: - 交易

function invalidTransaction(reason: string): ApiError {
  return new ApiError(400, "invalid_transaction", `The App Store transaction couldn't be verified: ${reason}`);
}

async function verifiedTransaction(env: Env, jws: string): Promise<TransactionPayload> {
  let transaction: TransactionPayload;
  try {
    transaction = await verifySignedData<TransactionPayload>(env, jws);
  } catch (error) {
    if (error instanceof SignedDataError) {
      throw invalidTransaction(error.message);
    }
    throw error;
  }
  if (transaction.bundleId !== env.APPLE_CLIENT_ID) {
    throw invalidTransaction("bundle id");
  }
  if (!ACCEPTED_ENVIRONMENTS.has(transaction.environment)) {
    throw invalidTransaction("environment");
  }
  if (transaction.type !== "Auto-Renewable Subscription" || !PLUS_PRODUCT_IDS.has(transaction.productId)) {
    throw invalidTransaction("product");
  }
  if (
    typeof transaction.originalTransactionId !== "string" ||
    typeof transaction.transactionId !== "string" ||
    typeof transaction.purchaseDate !== "number" ||
    typeof transaction.expiresDate !== "number" ||
    typeof transaction.signedDate !== "number"
  ) {
    throw invalidTransaction("fields");
  }
  return transaction;
}

async function ownerOf(env: Env, originalTransactionId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT member_id FROM subscriptions WHERE store = 'app_store' AND external_id = ?")
    .bind(originalTransactionId)
    .first<{ member_id: string }>();
  return row?.member_id ?? null;
}

async function memberExists(env: Env, memberId: string): Promise<boolean> {
  return (await env.DB.prepare("SELECT 1 AS found FROM members WHERE id = ?").bind(memberId).first()) !== null;
}

/// 一個會員同時最多一個有效訂閱(subscriptions 的部分唯一索引)。
const ONE_LIVE_SUBSCRIPTION = /UNIQUE constraint failed: subscriptions\.member_id/;

/// 寫入交易：較晚購買的交易(續訂、升降級)取代舊的;同一筆交易只接受簽章時間不早於現有的(退款、撤銷、撤銷被取消)。
/// 晚到的舊交易不會蓋掉新狀態。
///
/// `status` 是寫入當下依到期時間推算的快照(讀取一律重新推算);沒收到到期通知的舊列會一直佔著「有效訂閱」的名額,
/// 所以寫入前先把這個會員已經到期(含寬限)的有效列改成 expired。
async function applyTransaction(env: Env, memberId: string, transaction: TransactionPayload): Promise<void> {
  const now = Date.now();
  // verifiedTransaction 已確認 expiresDate 是數字。
  const expiresAt = transaction.expiresDate ?? 0;
  const status = transaction.revocationDate != null ? "revoked" : expiresAt > now ? "active" : "expired";
  try {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE subscriptions SET status = 'expired', updated_at = ?1
         WHERE member_id = ?2 AND status IN ('active', 'grace', 'billing_retry') AND revoked_at IS NULL
           AND expires_at <= ?1 AND COALESCE(grace_expires_at, 0) <= ?1
           AND NOT (store = 'app_store' AND external_id = ?3)`,
      ).bind(now, memberId, transaction.originalTransactionId),
      env.DB.prepare(
        `INSERT INTO subscriptions (id, member_id, store, external_id, product_id, status, expires_at, environment, updated_at,
           current_transaction_id, purchased_at, revoked_at, transaction_signed_at)
         VALUES (?1, ?2, 'app_store', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT (store, external_id) DO UPDATE SET
           environment = excluded.environment, product_id = excluded.product_id, current_transaction_id = excluded.current_transaction_id,
           purchased_at = excluded.purchased_at, expires_at = excluded.expires_at, revoked_at = excluded.revoked_at,
           transaction_signed_at = excluded.transaction_signed_at, updated_at = excluded.updated_at,
           status = CASE
             WHEN excluded.revoked_at IS NOT NULL THEN 'revoked'
             WHEN excluded.expires_at > ?8 THEN 'active'
             WHEN COALESCE(subscriptions.grace_expires_at, 0) > ?8 THEN 'grace'
             ELSE 'expired'
           END
         WHERE excluded.purchased_at > subscriptions.purchased_at
            OR (excluded.current_transaction_id = subscriptions.current_transaction_id
                AND excluded.transaction_signed_at >= subscriptions.transaction_signed_at)`,
      ).bind(
        crypto.randomUUID(),
        memberId,
        transaction.originalTransactionId,
        transaction.productId,
        status,
        expiresAt,
        transaction.environment === "Sandbox" ? "sandbox" : "production",
        now,
        transaction.transactionId,
        transaction.purchaseDate,
        transaction.revocationDate ?? null,
        transaction.signedDate,
      ),
    ]);
  } catch (error) {
    if (error instanceof Error && ONE_LIVE_SUBSCRIPTION.test(error.message)) {
      throw new ApiError(409, "subscription_already_active", "This member already has an active subscription.");
    }
    throw error;
  }
}

/// POST /v1/members/me/subscription/app-store:app 在購買、恢復購買、兌換 Offer Code 與收到交易更新時提交。
///
/// 歸屬：已登記的訂閱只屬於原會員;新訂閱的 `appAccountToken`(購買時帶入的會員 ID)若是另一個仍存在的會員，
/// 也不能被別人領走。沒有 `appAccountToken`(在 App Store 兌換 Offer Code 等)或原會員已刪除時，歸提交的會員。
export async function submitAppStoreTransaction(env: Env, memberId: string, signedTransaction: string): Promise<SubscriptionView | null> {
  const transaction = await verifiedTransaction(env, signedTransaction);
  const owner = await ownerOf(env, transaction.originalTransactionId);
  const token = transaction.appAccountToken?.toLowerCase();
  if (
    (owner !== null && owner !== memberId) ||
    (owner === null && token !== undefined && token !== memberId && (await memberExists(env, token)))
  ) {
    throw new ApiError(409, "subscription_in_use", "This App Store subscription belongs to another Purrdr member.");
  }
  await applyTransaction(env, memberId, transaction);
  return subscriptionView(env, memberId);
}

// MARK: - App Store Server Notifications v2

function invalidNotification(reason: string): ApiError {
  return new ApiError(400, "invalid_notification", `The App Store notification couldn't be verified: ${reason}`);
}

/// POST /v1/app-store/notifications:驗證後依通知裡的交易與續訂資訊更新權限。
///
/// 不依通知類型個別處理：續訂(DID_RENEW)帶新的到期時間、到期(EXPIRED)的到期時間已過、
/// 退款(REFUND)與撤銷(REVOKE)帶 `revocationDate`、撤銷被取消(REFUND_REVERSED)不帶，寫入交易就得到正確狀態。
/// 不認得的訂閱(沒有登記、`appAccountToken` 也不是現有會員)略過。
export async function handleAppStoreNotification(env: Env, signedPayload: string): Promise<void> {
  let notification: NotificationPayload;
  try {
    notification = await verifySignedData<NotificationPayload>(env, signedPayload);
  } catch (error) {
    if (error instanceof SignedDataError) {
      throw invalidNotification(error.message);
    }
    throw error;
  }
  const data = notification.data;
  if (!data?.signedTransactionInfo) {
    return;
  } // TEST、摘要類通知沒有交易。
  if (data.bundleId !== env.APPLE_CLIENT_ID) {
    throw invalidNotification("bundle id");
  }
  if (!data.environment || !ACCEPTED_ENVIRONMENTS.has(data.environment)) {
    throw invalidNotification("environment");
  }
  if (data.environment === "Production" && String(data.appAppleId) !== env.APP_STORE_APP_APPLE_ID) {
    throw invalidNotification("app Apple ID");
  }

  let transaction: TransactionPayload;
  try {
    transaction = await verifiedTransaction(env, data.signedTransactionInfo);
  } catch (error) {
    if (error instanceof ApiError) {
      throw invalidNotification(error.message);
    }
    throw error;
  }
  let owner = await ownerOf(env, transaction.originalTransactionId);
  const token = transaction.appAccountToken?.toLowerCase();
  if (owner === null && token !== undefined && (await memberExists(env, token))) {
    owner = token;
  }
  if (owner === null) {
    return;
  }

  await applyTransaction(env, owner, transaction);
  if (data.signedRenewalInfo) {
    await applyRenewalInfo(env, data.signedRenewalInfo, transaction.originalTransactionId);
  }
}

async function applyRenewalInfo(env: Env, jws: string, originalTransactionId: string): Promise<void> {
  let info: RenewalInfoPayload;
  try {
    info = await verifySignedData<RenewalInfoPayload>(env, jws);
  } catch (error) {
    if (error instanceof SignedDataError) {
      throw invalidNotification(error.message);
    }
    throw error;
  }
  if (info.originalTransactionId !== originalTransactionId || typeof info.signedDate !== "number") {
    throw invalidNotification("renewal info");
  }
  await env.DB.prepare(
    `UPDATE subscriptions SET auto_renew = ?1, grace_expires_at = ?2, renewal_signed_at = ?3, updated_at = ?4,
       status = CASE
         WHEN revoked_at IS NOT NULL THEN 'revoked'
         WHEN expires_at > ?4 THEN 'active'
         WHEN COALESCE(?2, 0) > ?4 THEN 'grace'
         ELSE 'expired'
       END
     WHERE store = 'app_store' AND external_id = ?5 AND (renewal_signed_at IS NULL OR renewal_signed_at <= ?3)`,
  )
    .bind(
      info.autoRenewStatus === undefined ? null : info.autoRenewStatus === 1 ? 1 : 0,
      info.gracePeriodExpiresDate ?? null,
      info.signedDate,
      Date.now(),
      originalTransactionId,
    )
    .run();
}
