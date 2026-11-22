import { revokeAppleToken } from "./apple";
import { ApiError } from "./http";
import type { Provider, VerifiedIdentity } from "./identity";
import { maskEmail } from "./mask-email";
import { hasDataBlockingMerge, identitiesOf, sealedAppleToken } from "./members";
import { hasActiveSubscription } from "./subscriptions";

/// 合併確認要給使用者看的單邊摘要(不含完整 email 與會員 ID)。
export type MergeSideSummary = {
  identities: { provider: Provider; email: string | null }[];
  hasActiveSubscription: boolean;
  /** 沒被刪除的同步主機數。 */
  hostCount: number;
};

export type MergeSummary = {
  /** 兩邊都有有效訂閱時是 false:確認合併會被拒絕(409 `subscription_conflict`)。 */
  canMerge: boolean;
  current: MergeSideSummary;
  other: MergeSideSummary;
};

async function sideSummary(env: Env, memberId: string): Promise<MergeSideSummary> {
  const { results } = await env.DB.prepare("SELECT provider, email FROM identities WHERE member_id = ? ORDER BY linked_at, provider")
    .bind(memberId)
    .all<{ provider: Provider; email: string | null }>();
  const hosts = await env.DB.prepare("SELECT COUNT(*) AS count FROM synced_hosts WHERE member_id = ? AND deleted_at IS NULL")
    .bind(memberId)
    .first<{ count: number }>();
  return {
    identities: results.map((row) => ({ provider: row.provider, email: maskEmail(row.email) })),
    hasActiveSubscription: await hasActiveSubscription(env, memberId),
    hostCount: hosts?.count ?? 0,
  };
}

export async function mergeSummary(env: Env, currentMemberId: string, otherMemberId: string): Promise<MergeSummary> {
  const current = await sideSummary(env, currentMemberId);
  const other = await sideSummary(env, otherMemberId);
  return { canMerge: !(current.hasActiveSubscription && other.hasActiveSubscription), current, other };
}

function subscriptionConflict(): ApiError {
  return new ApiError(409, "subscription_conflict", "Both members have an active subscription. Only one can be kept; cancel one first.");
}

/// 資料多的那邊要留下來:有效訂閱 > 有訂閱或同步資料(含過期、刪除紀錄) > 空會員。同等時留目前登入的會員。
async function dataRank(env: Env, memberId: string): Promise<number> {
  if (await hasActiveSubscription(env, memberId)) {
    return 2;
  }
  return (await hasDataBlockingMerge(env, memberId)) ? 1 : 0;
}

const ONE_LIVE_SUBSCRIPTION = /UNIQUE constraint failed: subscriptions\.member_id/;
const LIVE_STATUSES = "('active', 'grace', 'billing_retry')";

/// 確認合併:把 `otherMemberId`(擁有 `identity` 的會員)與目前登入的會員併成一個,回傳留下的會員與被刪的會員。
///
/// - 兩邊都有有效訂閱 → 409 `subscription_conflict`,什麼都不動。
/// - 留下資料多的那邊(見 `dataRank`),同等時留目前登入的會員;被併的會員刪除。
/// - 單一 D1 batch(同一個 transaction)搬 identities、subscriptions、synced_hosts(同 host_id 取 modified_at 最新,同時間留下那邊的)、devices、push_pairings、sessions(連同撤銷紀錄與主機服務事件去重)的歸屬,最後刪除被併的會員。
/// - 兩邊有同一提供者的身分時(每種最多一個),留下那邊的保留,被併那邊的丟掉,其中的 Apple refresh token 在 batch 成功後
///   撤銷(盡力而為,失敗不擋合併)。
export async function mergeMembers(
  env: Env,
  currentMemberId: string,
  otherMemberId: string,
  identity: VerifiedIdentity,
  exchangeAppleRefreshToken: () => Promise<string | null>,
): Promise<{ survivorId: string; mergedMemberId: string }> {
  const [currentRank, otherRank] = [await dataRank(env, currentMemberId), await dataRank(env, otherMemberId)];
  if (currentRank === 2 && otherRank === 2) {
    throw subscriptionConflict();
  }
  const survivorId = otherRank > currentRank ? otherMemberId : currentMemberId;
  const mergedMemberId = survivorId === currentMemberId ? otherMemberId : currentMemberId;

  const survivorProviders = new Set((await identitiesOf(env, survivorId)).map((existing) => existing.provider));
  const dropped = (await identitiesOf(env, mergedMemberId)).filter((existing) => survivorProviders.has(existing.provider));

  const appleRefreshToken = await exchangeAppleRefreshToken();
  const sealed = await sealedAppleToken(env, identity, appleRefreshToken);
  const now = Date.now();
  const S = survivorId;
  const L = mergedMemberId;
  try {
    await env.DB.batch([
      // 到期(含寬限)但狀態還是有效的舊列先改成 expired,避免佔著「每個會員一個有效訂閱」的名額擋住搬移。
      env.DB.prepare(
        `UPDATE subscriptions SET status = 'expired', updated_at = ?1
         WHERE member_id IN (?2, ?3) AND status IN ${LIVE_STATUSES} AND revoked_at IS NULL
           AND expires_at <= ?1 AND COALESCE(grace_expires_at, 0) <= ?1`,
      ).bind(now, S, L),
      env.DB.prepare("DELETE FROM identities WHERE member_id = ? AND provider IN (SELECT provider FROM identities WHERE member_id = ?)").bind(L, S),
      env.DB.prepare("UPDATE identities SET member_id = ? WHERE member_id = ?").bind(S, L),
      env.DB.prepare(
        `UPDATE identities SET email = COALESCE(?, email), email_verified = ?, is_private_relay = ?,
           apple_refresh_token = COALESCE(?, apple_refresh_token) WHERE provider = ? AND subject = ?`,
      ).bind(identity.email, identity.emailVerified ? 1 : 0, identity.isPrivateRelay ? 1 : 0, sealed, identity.provider, identity.subject),
      env.DB.prepare("UPDATE subscriptions SET member_id = ? WHERE member_id = ?").bind(S, L),
      // 同一台主機兩邊都有:先刪掉較舊(或一樣新)的 L 那份,再刪掉被 L 較新的那份蓋過的 S 那份,最後把剩下的搬過來。
      env.DB.prepare(
        `DELETE FROM synced_hosts WHERE member_id = ?1 AND EXISTS (
           SELECT 1 FROM synced_hosts AS kept WHERE kept.member_id = ?2 AND kept.host_id = synced_hosts.host_id
             AND kept.modified_at >= synced_hosts.modified_at)`,
      ).bind(L, S),
      env.DB.prepare("DELETE FROM synced_hosts WHERE member_id = ?1 AND host_id IN (SELECT host_id FROM synced_hosts WHERE member_id = ?2)").bind(S, L),
      env.DB.prepare("UPDATE synced_hosts SET member_id = ? WHERE member_id = ?").bind(S, L),
      env.DB.prepare("UPDATE devices SET member_id = ? WHERE member_id = ?").bind(S, L),
      env.DB.prepare("UPDATE push_pairings SET member_id = ? WHERE member_id = ?").bind(S, L),
      env.DB.prepare("UPDATE revoked_push_pairings SET member_id = ? WHERE member_id = ?").bind(S, L),
      env.DB.prepare("UPDATE host_service_push_events SET member_id = ? WHERE member_id = ?").bind(S, L),
      env.DB.prepare("UPDATE sessions SET member_id = ? WHERE member_id = ?").bind(S, L),
      env.DB.prepare("DELETE FROM members WHERE id = ?").bind(L),
    ]);
  } catch (error) {
    // 兩邊同時有有效訂閱(例如檢查之後才剛寫入):部分唯一索引擋下,batch 整個 rollback。
    if (error instanceof Error && ONE_LIVE_SUBSCRIPTION.test(error.message)) {
      throw subscriptionConflict();
    }
    throw error;
  }
  for (const other of dropped) {
    if (other.apple_refresh_token) {
      await revokeAppleToken(env, other.apple_refresh_token);
    }
  }
  return { survivorId, mergedMemberId };
}
