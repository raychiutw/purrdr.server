import type { Provider, VerifiedIdentity } from "./identity";

/// 會員在 API 上的樣子。
export type MemberView = {
  id: string;
  identities: { provider: Provider; email: string | null; linkedAt: string }[];
};

export async function memberView(env: Env, memberId: string): Promise<MemberView> {
  const { results } = await env.DB.prepare(
    "SELECT provider, email, linked_at FROM identities WHERE member_id = ? ORDER BY linked_at, provider",
  )
    .bind(memberId)
    .all<{ provider: Provider; email: string | null; linked_at: number }>();
  return {
    id: memberId,
    identities: results.map((row) => ({ provider: row.provider, email: row.email, linkedAt: new Date(row.linked_at).toISOString() })),
  };
}

/// 這個登入身分屬於哪個會員。
export async function memberIdFor(env: Env, identity: { provider: Provider; subject: string }): Promise<string | null> {
  const row = await env.DB.prepare("SELECT member_id FROM identities WHERE provider = ? AND subject = ?")
    .bind(identity.provider, identity.subject)
    .first<{ member_id: string }>();
  return row?.member_id ?? null;
}

/// 用這個登入身分建立新會員。
export async function createMember(env: Env, identity: VerifiedIdentity, appleRefreshToken: string | null): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO members (id, created_at) VALUES (?, ?)").bind(id, now),
    env.DB.prepare(
      "INSERT INTO identities (provider, subject, member_id, email, apple_refresh_token, linked_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(identity.provider, identity.subject, id, identity.email, appleRefreshToken, now),
  ]);
  return id;
}

/// 會員擁有這些資料時就不是「空的」:連結衝突時不能被自動併入(ADR-0007)。
/// 之後新增的會員資料表若也該擋合併，加進這個清單(推播配對要有訂閱才存在，所以不必列)。
const DATA_BLOCKING_MERGE = ["entitlements", "synced_hosts"] as const;
const NO_BLOCKING_DATA = DATA_BLOCKING_MERGE.map((table) => `NOT EXISTS (SELECT 1 FROM ${table} WHERE member_id = ?)`).join(" AND ");

export async function hasDataBlockingMerge(env: Env, memberId: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT ${NO_BLOCKING_DATA} AS empty`)
    .bind(...DATA_BLOCKING_MERGE.map(() => memberId))
    .first<{ empty: number }>();
  return row?.empty !== 1;
}

type StoredIdentity = { provider: Provider; subject: string; apple_refresh_token: string | null };

export async function identitiesOf(env: Env, memberId: string): Promise<StoredIdentity[]> {
  const { results } = await env.DB.prepare("SELECT provider, subject, apple_refresh_token FROM identities WHERE member_id = ?")
    .bind(memberId)
    .all<StoredIdentity>();
  return results;
}

/// 把登入身分加到會員身上。
export async function addIdentity(env: Env, memberId: string, identity: VerifiedIdentity, appleRefreshToken: string | null): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO identities (provider, subject, member_id, email, apple_refresh_token, linked_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(identity.provider, identity.subject, memberId, identity.email, appleRefreshToken, Date.now())
    .run();
}

/// 把另一個空會員的這個登入身分移過來，並刪掉那個會員(連同它其餘的身分與權杖)。
///
/// 同一個 transaction 再確認一次對方仍是空的;期間對方若剛好有了訂閱或同步資料，回傳 false 且不做任何改變。
export async function absorbIdentity(
  env: Env,
  memberId: string,
  otherMemberId: string,
  identity: VerifiedIdentity,
  appleRefreshToken: string | null,
): Promise<boolean> {
  const otherIsEmpty = DATA_BLOCKING_MERGE.map(() => otherMemberId);
  const [moved] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE identities SET member_id = ?, email = COALESCE(?, email), apple_refresh_token = COALESCE(?, apple_refresh_token), linked_at = ?
       WHERE provider = ? AND subject = ? AND member_id = ? AND ${NO_BLOCKING_DATA}`,
    ).bind(memberId, identity.email, appleRefreshToken, Date.now(), identity.provider, identity.subject, otherMemberId, ...otherIsEmpty),
    env.DB.prepare(
      `DELETE FROM members WHERE id = ? AND ${NO_BLOCKING_DATA}
       AND NOT EXISTS (SELECT 1 FROM identities WHERE provider = ? AND subject = ? AND member_id = ?)`,
    ).bind(otherMemberId, ...otherIsEmpty, identity.provider, identity.subject, otherMemberId),
  ]);
  return (moved?.meta.changes ?? 0) > 0;
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
    "UPDATE identities SET email = COALESCE(?, email), apple_refresh_token = COALESCE(?, apple_refresh_token) WHERE provider = ? AND subject = ?",
  )
    .bind(identity.email, appleRefreshToken, identity.provider, identity.subject)
    .run();
}
