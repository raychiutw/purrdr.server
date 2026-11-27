import type { Provider, VerifiedIdentity } from "./identity";
import { pushUsageView, type PushUsage } from "./push";
import { decryptAppleToken, encryptAppleToken } from "./token-encryption";

/// 寫入前加密 Apple refresh token(沒有就是 null,讓 COALESCE 保留舊值)。
export async function sealedAppleToken(env: Env, identity: VerifiedIdentity, appleRefreshToken: string | null): Promise<string | null> {
  return appleRefreshToken === null ? null : encryptAppleToken(env, identity.subject, appleRefreshToken);
}

/// 會員在 API 上的樣子。
export type MemberView = {
  id: string;
  identities: { provider: Provider; email: string | null; linkedAt: string }[];
  /** 今日推播用量(#36):每日上限、已送則數、下次歸零時間(UTC)。 */
  pushUsage: PushUsage;
};

export async function memberView(env: Env, memberId: string): Promise<MemberView> {
  const pushUsage = await pushUsageView(env, memberId);
  const { results } = await env.DB.prepare(
    "SELECT provider, email, linked_at FROM identities WHERE member_id = ? ORDER BY linked_at, provider",
  )
    .bind(memberId)
    .all<{ provider: Provider; email: string | null; linked_at: number }>();
  return {
    id: memberId,
    identities: results.map((row) => ({ provider: row.provider, email: row.email, linkedAt: new Date(row.linked_at).toISOString() })),
    pushUsage,
  };
}

/// 這個登入身分屬於哪個會員。
export async function memberIdFor(env: Env, identity: { provider: Provider; subject: string }): Promise<string | null> {
  const row = await env.DB.prepare("SELECT member_id FROM identities WHERE provider = ? AND subject = ?")
    .bind(identity.provider, identity.subject)
    .first<{ member_id: string }>();
  return row?.member_id ?? null;
}

function insertIdentityStatement(env: Env, memberId: string, identity: VerifiedIdentity, sealedToken: string | null, now: number): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO identities (id, member_id, provider, subject, email, email_verified, is_private_relay, apple_refresh_token, linked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    memberId,
    identity.provider,
    identity.subject,
    identity.email,
    identity.emailVerified ? 1 : 0,
    identity.isPrivateRelay ? 1 : 0,
    sealedToken,
    now,
  );
}

/// 用這個登入身分建立新會員。
export async function createMember(env: Env, identity: VerifiedIdentity, appleRefreshToken: string | null): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO members (id, created_at) VALUES (?, ?)").bind(id, now),
    insertIdentityStatement(env, id, identity, await sealedAppleToken(env, identity, appleRefreshToken), now),
  ]);
  return id;
}

/// 會員擁有這些資料時就不是「空的」:合併時優先留下有資料的那邊(merge.ts)。
/// 之後新增的會員資料表若也該算有資料，加進這個清單(推播配對要有訂閱才存在，所以不必列)。
const DATA_BLOCKING_MERGE = ["subscriptions", "synced_hosts"] as const;
const NO_BLOCKING_DATA = DATA_BLOCKING_MERGE.map((table) => `NOT EXISTS (SELECT 1 FROM ${table} WHERE member_id = ?)`).join(" AND ");

export async function hasDataBlockingMerge(env: Env, memberId: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT ${NO_BLOCKING_DATA} AS empty`)
    .bind(...DATA_BLOCKING_MERGE.map(() => memberId))
    .first<{ empty: number }>();
  return row?.empty !== 1;
}

/// 登入的 email 已驗證且非私密轉寄時,找出可以自動歸入的既有會員(另一個會員的某個身分有相同的已驗證 email,不分大小寫)。
///
/// 不自動合併的情形:email 沒驗證、私密轉寄、沒有 email;符合的會員不只一個(不猜);
/// 符合的會員已有同一提供者的身分(每種最多一個,沿用 `provider_already_linked` 的精神)。
export async function autoMergeTarget(env: Env, identity: VerifiedIdentity): Promise<string | null> {
  if (!identity.emailVerified || identity.isPrivateRelay || !identity.email) {
    return null;
  }
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT member_id FROM identities
     WHERE email_verified = 1 AND is_private_relay = 0 AND lower(email) = lower(?)`,
  )
    .bind(identity.email)
    .all<{ member_id: string }>();
  const target = results.length === 1 ? results[0]?.member_id : undefined;
  if (!target) {
    return null;
  }
  const sameProvider = await env.DB.prepare("SELECT 1 FROM identities WHERE member_id = ? AND provider = ?")
    .bind(target, identity.provider)
    .first();
  return sameProvider ? null : target;
}

/// `apple_refresh_token` 已解密;解不開視同沒有。
type StoredIdentity = { provider: Provider; subject: string; apple_refresh_token: string | null };

export async function identitiesOf(env: Env, memberId: string): Promise<StoredIdentity[]> {
  const { results } = await env.DB.prepare("SELECT provider, subject, apple_refresh_token FROM identities WHERE member_id = ?")
    .bind(memberId)
    .all<StoredIdentity>();
  return Promise.all(
    results.map(async (row) => ({
      ...row,
      apple_refresh_token: row.apple_refresh_token === null ? null : await decryptAppleToken(env, row.subject, row.apple_refresh_token),
    })),
  );
}

/// 把登入身分加到會員身上。
export async function addIdentity(env: Env, memberId: string, identity: VerifiedIdentity, appleRefreshToken: string | null): Promise<void> {
  await insertIdentityStatement(env, memberId, identity, await sealedAppleToken(env, identity, appleRefreshToken), Date.now()).run();
}

export async function removeIdentity(env: Env, memberId: string, provider: Provider): Promise<void> {
  await env.DB.prepare("DELETE FROM identities WHERE member_id = ? AND provider = ?").bind(memberId, provider).run();
}

/// 刪除會員：foreign key 的 ON DELETE CASCADE 會一併刪掉身分、權杖、訂閱權限、同步資料等。
export async function deleteMember(env: Env, memberId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM members WHERE id = ?").bind(memberId).run();
}

/// 既有身分再次登入：更新 email 與(有的話)新的 Apple refresh token。
export async function refreshIdentity(env: Env, identity: VerifiedIdentity, appleRefreshToken: string | null): Promise<void> {
  await env.DB.prepare(
    // token 沒帶 email 時,email 與其驗證狀態都維持原樣。
    `UPDATE identities SET email = COALESCE(?1, email),
       email_verified = CASE WHEN ?1 IS NULL THEN email_verified ELSE ?2 END,
       is_private_relay = CASE WHEN ?1 IS NULL THEN is_private_relay ELSE ?3 END,
       apple_refresh_token = COALESCE(?4, apple_refresh_token) WHERE provider = ?5 AND subject = ?6`,
  )
    .bind(
      identity.email,
      identity.emailVerified ? 1 : 0,
      identity.isPrivateRelay ? 1 : 0,
      await sealedAppleToken(env, identity, appleRefreshToken),
      identity.provider,
      identity.subject,
    )
    .run();
}
