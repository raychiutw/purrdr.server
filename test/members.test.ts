import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { api, appleIdToken, googleIdToken, identityProviders, signInWithApple, signInWithGoogle } from "./fakes";

async function linkGoogle(accessToken: string, subject: string) {
  return api("POST", "/v1/members/me/identities", {
    accessToken,
    body: { provider: "google", idToken: await googleIdToken({ subject, nonce: "n" }), nonce: "n" },
  });
}

async function linkApple(accessToken: string, subject: string) {
  return api("POST", "/v1/members/me/identities", {
    accessToken,
    body: { provider: "apple", idToken: await appleIdToken({ subject, nonce: "n" }), nonce: "n", authorizationCode: `link-${subject}` },
  });
}

async function count(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>();
  return row?.count ?? 0;
}

/// 讓會員有訂閱權限(#28 才會有正式的寫入路徑)。
async function giveSubscription(memberId: string) {
  await env.DB.prepare("INSERT INTO entitlements (member_id, store, product_id, expires_at, updated_at) VALUES (?, 'app_store', 'plus.monthly', ?, ?)")
    .bind(memberId, Date.now() + 86_400_000, Date.now())
    .run();
}

/// 讓會員有主機同步資料(#30 才會有正式的寫入路徑)。
async function giveSyncedHost(memberId: string) {
  await env.DB.prepare("INSERT INTO synced_hosts (member_id, host_id, payload, updated_at) VALUES (?, 'host-1', '{}', ?)")
    .bind(memberId, Date.now())
    .run();
}

describe("連結登入方式", () => {
  it("Apple 會員連結 Google 後，用 Google 登入回到同一個會員", async () => {
    const apple = await signInWithApple("apple-user-1");

    const link = await linkGoogle(apple.body.accessToken, "google-user-1");
    expect(link.status).toBe(200);
    expect(link.body.mergedMemberId).toBeNull();
    expect(link.body.member.identities.map((identity: { provider: string }) => identity.provider)).toEqual(["apple", "google"]);

    const google = await signInWithGoogle("google-user-1");
    expect(google.body.memberCreated).toBe(false);
    expect(google.body.member.id).toBe(apple.body.member.id);
  });

  it("Google 會員連結 Apple 時也跟 Apple 換 refresh token", async () => {
    const google = await signInWithGoogle("google-user-1");

    const link = await linkApple(google.body.accessToken, "apple-user-1");

    expect(link.status).toBe(200);
    expect(identityProviders.appleTokenCalls.map((call) => call.code)).toEqual(["link-apple-user-1"]);
    const apple = await signInWithApple("apple-user-1");
    expect(apple.body.member.id).toBe(google.body.member.id);
  });

  it("已經有同一種登入方式時拒絕(每種最多一個)", async () => {
    const apple = await signInWithApple("apple-user-1");

    const link = await linkApple(apple.body.accessToken, "apple-user-2");

    expect(link.status).toBe(409);
    expect(link.body.error.code).toBe("provider_already_linked");
  });

  it("要連結的身分屬於另一個空的會員時，自動併入並刪除那個會員", async () => {
    const apple = await signInWithApple("apple-user-1");
    const otherGoogle = await signInWithGoogle("google-user-1");

    const link = await linkGoogle(apple.body.accessToken, "google-user-1");

    expect(link.status).toBe(200);
    expect(link.body.mergedMemberId).toBe(otherGoogle.body.member.id);
    expect(link.body.member.identities).toHaveLength(2);
    expect(await count("members")).toBe(1);
    // 被併掉的會員的權杖一起失效。
    expect((await api("GET", "/v1/members/me", { accessToken: otherGoogle.body.accessToken })).status).toBe(401);
    const google = await signInWithGoogle("google-user-1");
    expect(google.body.member.id).toBe(apple.body.member.id);
  });

  it("被併入的空會員另有一個 Apple 身分時，那個身分撤銷後一起刪掉(一個會員只能有一個 Apple)", async () => {
    const mine = await signInWithApple("apple-user-1");
    const other = await signInWithApple("apple-user-2");
    await linkGoogle(other.body.accessToken, "google-user-2");

    const link = await linkGoogle(mine.body.accessToken, "google-user-2");

    expect(link.status).toBe(200);
    expect(link.body.mergedMemberId).toBe(other.body.member.id);
    expect(identityProviders.appleRevokeCalls).toEqual([
      { token: "apple-refresh-for-code-apple-user-2", tokenTypeHint: "refresh_token", clientSecretValid: true },
    ]);
    const again = await signInWithApple("apple-user-2");
    expect(again.body.memberCreated).toBe(true);
  });

  it.each([
    ["有訂閱", giveSubscription],
    ["有主機同步資料", giveSyncedHost],
  ])("要連結的身分屬於另一個%s的會員時拒絕，兩邊都不變", async (_, giveData) => {
    const apple = await signInWithApple("apple-user-1");
    const otherGoogle = await signInWithGoogle("google-user-1");
    await giveData(otherGoogle.body.member.id);

    const link = await linkGoogle(apple.body.accessToken, "google-user-1");

    expect(link.status).toBe(409);
    expect(link.body.error.code).toBe("identity_in_use");
    expect(await count("members")).toBe(2);
    const google = await signInWithGoogle("google-user-1");
    expect(google.body.member.id).toBe(otherGoogle.body.member.id);
  });

  it("連結自己已經有的身分不做任何事", async () => {
    const apple = await signInWithApple("apple-user-1");
    await linkGoogle(apple.body.accessToken, "google-user-1");

    const again = await linkGoogle(apple.body.accessToken, "google-user-1");

    expect(again.status).toBe(200);
    expect(again.body.mergedMemberId).toBeNull();
    expect(again.body.member.identities).toHaveLength(2);
  });

  it("連結要先登入", async () => {
    const link = await api("POST", "/v1/members/me/identities", {
      body: { provider: "google", idToken: await googleIdToken({ subject: "g", nonce: "n" }), nonce: "n" },
    });

    expect(link.status).toBe(401);
  });
});

describe("解除連結", () => {
  it("解除 Google 後只剩 Apple,用 Google 登入會變成新會員", async () => {
    const apple = await signInWithApple("apple-user-1");
    await linkGoogle(apple.body.accessToken, "google-user-1");

    const unlink = await api("DELETE", "/v1/members/me/identities/google", { accessToken: apple.body.accessToken });

    expect(unlink.status).toBe(200);
    expect(unlink.body.member.identities.map((identity: { provider: string }) => identity.provider)).toEqual(["apple"]);
    const google = await signInWithGoogle("google-user-1");
    expect(google.body.memberCreated).toBe(true);
  });

  it("解除 Apple 時撤銷它的 Sign in with Apple 權杖", async () => {
    const apple = await signInWithApple("apple-user-1");
    await linkGoogle(apple.body.accessToken, "google-user-1");

    const unlink = await api("DELETE", "/v1/members/me/identities/apple", { accessToken: apple.body.accessToken });

    expect(unlink.status).toBe(200);
    expect(identityProviders.appleRevokeCalls.map((call) => call.token)).toEqual(["apple-refresh-for-code-apple-user-1"]);
  });

  it("至少保留一種登入方式", async () => {
    const apple = await signInWithApple("apple-user-1");

    const unlink = await api("DELETE", "/v1/members/me/identities/apple", { accessToken: apple.body.accessToken });

    expect(unlink.status).toBe(409);
    expect(unlink.body.error.code).toBe("last_identity");
    expect(identityProviders.appleRevokeCalls).toEqual([]);
  });

  it("解除沒有連結的登入方式回 404", async () => {
    const apple = await signInWithApple("apple-user-1");

    const unlink = await api("DELETE", "/v1/members/me/identities/google", { accessToken: apple.body.accessToken });

    expect(unlink.status).toBe(404);
    expect(unlink.body.error.code).toBe("identity_not_linked");
  });
});

describe("刪除會員", () => {
  it("撤銷 Sign in with Apple 權杖並刪除會員的所有資料", async () => {
    const apple = await signInWithApple("apple-user-1");
    await linkGoogle(apple.body.accessToken, "google-user-1");
    const memberId = apple.body.member.id;
    await giveSubscription(memberId);
    await giveSyncedHost(memberId);

    const deletion = await api("DELETE", "/v1/members/me", { accessToken: apple.body.accessToken });

    expect(deletion.status).toBe(204);
    expect(identityProviders.appleRevokeCalls).toEqual([
      { token: "apple-refresh-for-code-apple-user-1", tokenTypeHint: "refresh_token", clientSecretValid: true },
    ]);
    for (const table of ["members", "identities", "refresh_tokens", "entitlements", "synced_hosts"]) {
      expect(await count(table), table).toBe(0);
    }
    expect((await api("GET", "/v1/members/me", { accessToken: apple.body.accessToken })).status).toBe(401);
    expect((await api("POST", "/v1/sessions/refresh", { body: { refreshToken: apple.body.refreshToken } })).status).toBe(401);
  });

  it("只刪自己，不動其他會員", async () => {
    const mine = await signInWithGoogle("google-user-1");
    const other = await signInWithGoogle("google-user-2");

    await api("DELETE", "/v1/members/me", { accessToken: mine.body.accessToken });

    expect((await api("GET", "/v1/members/me", { accessToken: other.body.accessToken })).status).toBe(200);
  });

  it("Apple 撤銷失敗時不刪任何資料，讓使用者重試", async () => {
    const apple = await signInWithApple("apple-user-1");
    identityProviders.appleRevokeStatus = 503;

    const deletion = await api("DELETE", "/v1/members/me", { accessToken: apple.body.accessToken });

    expect(deletion.status).toBe(502);
    expect(deletion.body.error.code).toBe("apple_revoke_failed");
    expect((await api("GET", "/v1/members/me", { accessToken: apple.body.accessToken })).status).toBe(200);
  });

  it("Apple 回應權杖已無效(400)也算撤銷完成", async () => {
    const apple = await signInWithApple("apple-user-1");
    identityProviders.appleRevokeStatus = 400;

    const deletion = await api("DELETE", "/v1/members/me", { accessToken: apple.body.accessToken });

    expect(deletion.status).toBe(204);
    expect(await count("members")).toBe(0);
  });
});
