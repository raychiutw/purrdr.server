import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { api, appleIdToken, googleIdToken, identityProviders, insertPairing, signInWithApple, signInWithGoogle } from "./fakes";

const MERGE = "/v1/members/me/identities/merge";
const LINK = "/v1/members/me/identities";
const DAY = 86_400_000;

async function googleCredential(subject: string) {
  return { provider: "google", idToken: await googleIdToken({ subject, nonce: "n" }), nonce: "n" };
}

async function appleCredential(subject: string) {
  return { provider: "apple", idToken: await appleIdToken({ subject, nonce: "n" }), nonce: "n", authorizationCode: `link-${subject}` };
}

async function count(table: string, where = "1 = 1"): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).first<{ count: number }>();
  return row?.count ?? 0;
}

async function giveSubscription(memberId: string, options: { expiresAt?: number; status?: string; id?: string } = {}) {
  const now = Date.now();
  const id = options.id ?? memberId;
  await env.DB.prepare(
    `INSERT INTO subscriptions (id, member_id, store, external_id, product_id, status, expires_at, environment, updated_at,
       current_transaction_id, purchased_at, transaction_signed_at)
     VALUES (?, ?, 'app_store', ?, 'com.raychiu.purrdr.plus.monthly', ?, ?, 'sandbox', ?, '1', ?, ?)`,
  )
    .bind(`sub-${id}`, memberId, `original-${id}`, options.status ?? "active", options.expiresAt ?? now + DAY, now, now, now)
    .run();
}

async function giveHost(memberId: string, hostId: string, name: string, modifiedAt: number) {
  await env.DB.prepare(
    `INSERT INTO synced_hosts (member_id, host_id, name, address, port, username, connection_method, modified_at, updated_at)
     VALUES (?, ?, ?, 'addr', 22, 'ray', 'tailscale_ssh', ?, ?)`,
  )
    .bind(memberId, hostId, name, modifiedAt, modifiedAt)
    .run();
}

describe("登入時已驗證 email 相同:自動合併", () => {
  it("Google 登入的已驗證 email 與既有 Apple 會員相同(不分大小寫)→ 歸到既有會員並新增身分", async () => {
    const apple = await signInWithApple("apple-user-1", { email: "Ray@Example.com" });

    const google = await signInWithGoogle("google-user-1", { email: "ray@example.com" });

    expect(google.status).toBe(200);
    expect(google.body.memberCreated).toBe(false);
    expect(google.body.autoLinked).toBe(true);
    expect(google.body.member.id).toBe(apple.body.member.id);
    expect(google.body.member.identities.map((identity: { provider: string }) => identity.provider)).toEqual(["apple", "google"]);
    expect(await count("members")).toBe(1);
    // 之後用 Google 再登入:直接回到同一個會員,不再是「自動合併」。
    const again = await signInWithGoogle("google-user-1", { email: "ray@example.com" });
    expect(again.body.member.id).toBe(apple.body.member.id);
    expect(again.body.autoLinked).toBe(false);
  });

  it("自動合併進來的 Apple 身分也跟 Apple 換 refresh token(刪除會員時要撤銷)", async () => {
    const google = await signInWithGoogle("google-user-1", { email: "ray@example.com" });

    const apple = await signInWithApple("apple-user-1", { email: "ray@example.com" });

    expect(apple.body.member.id).toBe(google.body.member.id);
    expect(identityProviders.appleTokenCalls.map((call) => call.code)).toEqual(["code-apple-user-1"]);
    await api("DELETE", "/v1/members/me", { accessToken: apple.body.accessToken });
    expect(identityProviders.appleRevokeCalls.map((call) => call.token)).toEqual(["apple-refresh-for-code-apple-user-1"]);
  });

  it("Apple 私密轉寄 email 不自動合併", async () => {
    const google = await signInWithGoogle("google-user-1", { email: "ray@example.com" });

    const apple = await signInWithApple("apple-user-1", { email: "xyz123@privaterelay.appleid.com" });

    expect(apple.body.memberCreated).toBe(true);
    expect(apple.body.autoLinked).toBe(false);
    expect(apple.body.member.id).not.toBe(google.body.member.id);
    expect(await count("members")).toBe(2);
  });

  it("私密轉寄的 Apple 身分即使 email 相同也不是合併對象", async () => {
    const relay = "xyz123@privaterelay.appleid.com";
    const apple = await signInWithApple("apple-user-1", { email: relay });

    const google = await signInWithGoogle("google-user-1", { email: relay });

    expect(google.body.memberCreated).toBe(true);
    expect(google.body.member.id).not.toBe(apple.body.member.id);
  });

  it("token 的 email 沒驗證時不自動合併", async () => {
    const apple = await signInWithApple("apple-user-1", { email: "ray@example.com" });

    const google = await signInWithGoogle("google-user-1", { email: "ray@example.com", emailVerified: false });

    expect(google.body.memberCreated).toBe(true);
    expect(google.body.member.id).not.toBe(apple.body.member.id);
  });

  it("既有會員那個身分的 email 沒驗證時不是合併對象", async () => {
    const google = await signInWithGoogle("google-user-1", { email: "ray@example.com", emailVerified: false });

    const apple = await signInWithApple("apple-user-1", { email: "ray@example.com" });

    expect(apple.body.memberCreated).toBe(true);
    expect(apple.body.member.id).not.toBe(google.body.member.id);
  });

  it("既有會員已有同一提供者的另一個 subject 時不自動合併", async () => {
    const first = await signInWithApple("apple-user-1", { email: "ray@example.com" });

    const second = await signInWithApple("apple-user-2", { email: "ray@example.com" });

    expect(second.body.memberCreated).toBe(true);
    expect(second.body.member.id).not.toBe(first.body.member.id);
    expect(await count("members")).toBe(2);
  });

  it("有不只一個會員符合時不自動合併(不猜)", async () => {
    const one = await signInWithApple("apple-user-1", { email: "ray@example.com" });
    const two = await signInWithApple("apple-user-2", { email: "ray@example.com" });

    const google = await signInWithGoogle("google-user-1", { email: "ray@example.com" });

    expect(google.body.memberCreated).toBe(true);
    expect([one.body.member.id, two.body.member.id]).not.toContain(google.body.member.id);
  });
});

describe("新增登入方式:身分屬於另一個會員時回傳合併摘要", () => {
  it("回 409 與兩個會員的摘要(提供者、遮蔽 email、有效訂閱、主機數),不直接合併", async () => {
    const me = await signInWithApple("apple-user-1", { email: "mine@example.com" });
    const other = await signInWithGoogle("google-user-1", { email: "theirs@gmail.com" });
    await giveSubscription(other.body.member.id);
    await giveHost(other.body.member.id, "h1", "Mac", 1);
    await giveHost(other.body.member.id, "h2", "Pi", 1);

    const link = await api("POST", LINK, { accessToken: me.body.accessToken, body: await googleCredential("google-user-1") });

    expect(link.status).toBe(409);
    expect(link.body.error.code).toBe("merge_required");
    expect(link.body.error.details).toEqual({
      canMerge: true,
      current: { identities: [{ provider: "apple", email: "m***@example.com" }], hasActiveSubscription: false, hostCount: 0 },
      other: { identities: [{ provider: "google", email: "t***@gmail.com" }], hasActiveSubscription: true, hostCount: 2 },
    });
    expect(JSON.stringify(link.body)).not.toContain("theirs@gmail.com");
    expect(await count("members")).toBe(2);
  });

  it("兩邊都有有效訂閱時 canMerge 是 false", async () => {
    const me = await signInWithApple("apple-user-1");
    const other = await signInWithGoogle("google-user-1");
    await giveSubscription(me.body.member.id);
    await giveSubscription(other.body.member.id);

    const link = await api("POST", LINK, { accessToken: me.body.accessToken, body: await googleCredential("google-user-1") });

    expect(link.status).toBe(409);
    expect(link.body.error.details.canMerge).toBe(false);
  });

  it("已過期的訂閱不算有效訂閱,主機刪除紀錄不算主機數", async () => {
    const me = await signInWithApple("apple-user-1");
    const other = await signInWithGoogle("google-user-1");
    await giveSubscription(other.body.member.id, { status: "expired", expiresAt: Date.now() - DAY });
    await giveHost(other.body.member.id, "h1", "Mac", 1);
    await env.DB.prepare("UPDATE synced_hosts SET deleted_at = 5 WHERE host_id = 'h1'").run();

    const link = await api("POST", LINK, { accessToken: me.body.accessToken, body: await googleCredential("google-user-1") });

    expect(link.body.error.details.other).toMatchObject({ hasActiveSubscription: false, hostCount: 0 });
  });
});

describe("確認合併 POST /v1/members/me/identities/merge", () => {
  it("兩邊都有有效訂閱時拒絕(409 subscription_conflict),兩邊都不變", async () => {
    const me = await signInWithApple("apple-user-1");
    const other = await signInWithGoogle("google-user-1");
    await giveSubscription(me.body.member.id);
    await giveSubscription(other.body.member.id);

    const merge = await api("POST", MERGE, { accessToken: me.body.accessToken, body: await googleCredential("google-user-1") });

    expect(merge.status).toBe(409);
    expect(merge.body.error.code).toBe("subscription_conflict");
    expect(await count("members")).toBe(2);
    expect(await count("subscriptions", `member_id = '${me.body.member.id}'`)).toBe(1);
    expect(await count("subscriptions", `member_id = '${other.body.member.id}'`)).toBe(1);
    expect((await api("GET", "/v1/members/me", { accessToken: other.body.accessToken })).status).toBe(200);
  });

  it("只有對方有訂閱:合併到對方(有資料那邊),我的登入仍可用", async () => {
    const me = await signInWithApple("apple-user-1");
    const other = await signInWithGoogle("google-user-1");
    await giveSubscription(other.body.member.id);

    const merge = await api("POST", MERGE, { accessToken: me.body.accessToken, body: await googleCredential("google-user-1") });

    expect(merge.status).toBe(200);
    expect(merge.body.member.id).toBe(other.body.member.id);
    expect(merge.body.mergedMemberId).toBe(me.body.member.id);
    expect(merge.body.member.identities.map((identity: { provider: string }) => identity.provider).sort()).toEqual(["apple", "google"]);
    expect(await count("members")).toBe(1);
    expect(await count("subscriptions", `member_id = '${other.body.member.id}'`)).toBe(1);
    // 原本的存取權杖屬於被刪的會員;回應附新的存取權杖,更新權杖歸到留下的會員。
    expect((await api("GET", "/v1/members/me", { accessToken: me.body.accessToken })).status).toBe(401);
    const fresh = await api("GET", "/v1/members/me", { accessToken: merge.body.accessToken });
    expect(fresh.body.member.id).toBe(other.body.member.id);
    const refreshed = await api("POST", "/v1/sessions/refresh", { body: { refreshToken: me.body.refreshToken } });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.member.id).toBe(other.body.member.id);
    expect((await api("POST", "/v1/sessions/refresh", { body: { refreshToken: other.body.refreshToken } })).status).toBe(200);
  });

  it("只有我有主機同步資料:合併到我", async () => {
    const me = await signInWithApple("apple-user-1");
    const other = await signInWithGoogle("google-user-1");
    await giveHost(me.body.member.id, "h1", "Mac", 1);

    const merge = await api("POST", MERGE, { accessToken: me.body.accessToken, body: await googleCredential("google-user-1") });

    expect(merge.status).toBe(200);
    expect(merge.body.member.id).toBe(me.body.member.id);
    expect(merge.body.mergedMemberId).toBe(other.body.member.id);
    expect((await api("GET", "/v1/members/me", { accessToken: merge.body.accessToken })).body.member.id).toBe(me.body.member.id);
    expect((await api("GET", "/v1/members/me", { accessToken: me.body.accessToken })).status).toBe(200);
    expect((await api("GET", "/v1/members/me", { accessToken: other.body.accessToken })).status).toBe(401);
  });

  it("對方只有過期訂閱、我有主機:都算有資料,維持我這邊", async () => {
    const me = await signInWithApple("apple-user-1");
    const other = await signInWithGoogle("google-user-1");
    await giveSubscription(other.body.member.id, { status: "expired", expiresAt: Date.now() - DAY });
    await giveHost(me.body.member.id, "h1", "Mac", 1);

    const merge = await api("POST", MERGE, { accessToken: me.body.accessToken, body: await googleCredential("google-user-1") });

    expect(merge.body.member.id).toBe(me.body.member.id);
    expect(await count("subscriptions", `member_id = '${me.body.member.id}'`)).toBe(1);
  });

  it("兩邊都沒有資料:合併到目前的會員", async () => {
    const me = await signInWithApple("apple-user-1");
    const other = await signInWithGoogle("google-user-1");

    const merge = await api("POST", MERGE, { accessToken: me.body.accessToken, body: await googleCredential("google-user-1") });

    expect(merge.status).toBe(200);
    expect(merge.body.member.id).toBe(me.body.member.id);
    expect(merge.body.mergedMemberId).toBe(other.body.member.id);
  });

  it("搬走 identities、subscriptions、synced_hosts、devices、push_pairings、sessions,同 host_id 取 modified_at 最新", async () => {
    const me = await signInWithApple("apple-user-1");
    const other = await signInWithGoogle("google-user-1");
    const mine = me.body.member.id;
    const theirs = other.body.member.id;
    // 對方有有效訂閱,所以留下對方;我這邊的資料全部搬過去。
    await giveSubscription(theirs);
    await giveSubscription(mine, { status: "expired", expiresAt: Date.now() - DAY, id: "old" });
    await giveHost(mine, "same-newer-mine", "mine wins", 200);
    await giveHost(theirs, "same-newer-mine", "theirs loses", 100);
    await giveHost(mine, "same-newer-theirs", "mine loses", 100);
    await giveHost(theirs, "same-newer-theirs", "theirs wins", 200);
    await giveHost(mine, "only-mine", "only mine", 1);
    await giveHost(theirs, "only-theirs", "only theirs", 1);
    await insertPairing({ keyHash: "a".repeat(64), memberId: mine, deviceToken: "token-mine", deviceId: "device-mine" });
    await insertPairing({ keyHash: "b".repeat(64), memberId: theirs, deviceToken: "token-theirs", deviceId: "device-theirs" });

    const merge = await api("POST", MERGE, { accessToken: me.body.accessToken, body: await googleCredential("google-user-1") });

    expect(merge.status).toBe(200);
    const hosts = await env.DB.prepare("SELECT member_id, host_id, name FROM synced_hosts ORDER BY host_id").all<{ member_id: string; host_id: string; name: string }>();
    expect(hosts.results).toEqual([
      { member_id: theirs, host_id: "only-mine", name: "only mine" },
      { member_id: theirs, host_id: "only-theirs", name: "only theirs" },
      { member_id: theirs, host_id: "same-newer-mine", name: "mine wins" },
      { member_id: theirs, host_id: "same-newer-theirs", name: "theirs wins" },
    ]);
    expect(await count("subscriptions", `member_id = '${theirs}'`)).toBe(2);
    expect(await count("identities", `member_id = '${theirs}'`)).toBe(2);
    expect(await count("push_pairings", `member_id = '${theirs}'`)).toBe(2);
    expect(await count("devices", `member_id = '${theirs}' AND id IN ('device-mine', 'device-theirs')`)).toBe(2);
    expect(await count("sessions", `member_id = '${theirs}' AND revoked_at IS NULL`)).toBe(2);
    for (const table of ["identities", "subscriptions", "synced_hosts", "devices", "push_pairings", "sessions"]) {
      expect(await count(table, `member_id = '${mine}'`), table).toBe(0);
    }
    expect(await count("members")).toBe(1);
  });

  it("到期但狀態還是 active 的舊列不會擋合併(合併前先依時間修正)", async () => {
    const me = await signInWithApple("apple-user-1");
    const other = await signInWithGoogle("google-user-1");
    await giveSubscription(me.body.member.id, { status: "active", expiresAt: Date.now() - DAY });
    await giveSubscription(other.body.member.id);

    const merge = await api("POST", MERGE, { accessToken: me.body.accessToken, body: await googleCredential("google-user-1") });

    expect(merge.status).toBe(200);
    expect(await count("subscriptions", `member_id = '${other.body.member.id}'`)).toBe(2);
  });

  it("兩邊有同一提供者的身分時,留下那邊的保留,被併那邊的丟掉", async () => {
    const me = await signInWithGoogle("google-mine");
    const other = await signInWithApple("apple-theirs");
    await api("POST", LINK, { accessToken: other.body.accessToken, body: await googleCredential("google-theirs") });
    await giveSubscription(other.body.member.id);

    // 我(Google 會員)要綁 Apple「apple-theirs」:對方也有 Google,留下對方,所以我的 google-mine 被丟掉。
    const merge = await api("POST", MERGE, { accessToken: me.body.accessToken, body: await appleCredential("apple-theirs") });

    expect(merge.status).toBe(200);
    expect(merge.body.member.id).toBe(other.body.member.id);
    const rows = await env.DB.prepare("SELECT provider, subject FROM identities ORDER BY provider").all();
    expect(rows.results).toEqual([
      { provider: "apple", subject: "apple-theirs" },
      { provider: "google", subject: "google-theirs" },
    ]);
  });

  it("被丟掉的 Apple 身分會撤銷 refresh token(盡力而為,撤銷失敗不擋合併)", async () => {
    const me = await signInWithApple("apple-mine");
    const other = await signInWithGoogle("google-theirs");
    await api("POST", LINK, { accessToken: other.body.accessToken, body: await appleCredential("apple-theirs") });
    await giveSubscription(other.body.member.id);
    identityProviders.appleRevokeStatus = 503;

    const merge = await api("POST", MERGE, { accessToken: me.body.accessToken, body: await googleCredential("google-theirs") });

    expect(merge.status).toBe(200);
    expect(identityProviders.appleRevokeCalls.map((call) => call.token)).toEqual(["apple-refresh-for-code-apple-mine"]);
    expect(await count("identities", "subject = 'apple-mine'")).toBe(0);
    expect(await count("members")).toBe(1);
  });

  it("身分沒有屬於任何會員時回 409 no_merge_needed", async () => {
    const me = await signInWithApple("apple-user-1");

    const merge = await api("POST", MERGE, { accessToken: me.body.accessToken, body: await googleCredential("nobody") });

    expect(merge.status).toBe(409);
    expect(merge.body.error.code).toBe("no_merge_needed");
  });

  it("身分本來就是自己的時回 409 no_merge_needed", async () => {
    const me = await signInWithApple("apple-user-1");
    await api("POST", LINK, { accessToken: me.body.accessToken, body: await googleCredential("google-user-1") });

    const merge = await api("POST", MERGE, { accessToken: me.body.accessToken, body: await googleCredential("google-user-1") });

    expect(merge.status).toBe(409);
    expect(merge.body.error.code).toBe("no_merge_needed");
  });

  it("要先登入;憑證無效時不動資料", async () => {
    const me = await signInWithApple("apple-user-1");
    await signInWithGoogle("google-user-1");

    expect((await api("POST", MERGE, { body: await googleCredential("google-user-1") })).status).toBe(401);
    const forged = await api("POST", MERGE, {
      accessToken: me.body.accessToken,
      body: { provider: "google", idToken: await googleIdToken({ subject: "google-user-1", nonce: "n", forged: true }), nonce: "n" },
    });
    expect(forged.status).toBe(401);
    expect(await count("members")).toBe(2);
  });
});
