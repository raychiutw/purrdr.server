import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { api, appleIdToken, googleIdToken, identityProviders, signInWithApple, signInWithGoogle } from "./fakes";

describe("登入成為會員", () => {
  it("第一次用 Sign in with Apple 登入就成為會員，拿到存取權杖與更新權杖", async () => {
    const signIn = await signInWithApple("apple-user-1", { email: "abc@privaterelay.appleid.com" });

    expect(signIn.status).toBe(200);
    expect(signIn.body.memberCreated).toBe(true);
    expect(signIn.body.accessToken).toEqual(expect.any(String));
    expect(signIn.body.refreshToken).toEqual(expect.any(String));

    const me = await api("GET", "/v1/members/me", { accessToken: signIn.body.accessToken });
    expect(me.status).toBe(200);
    expect(me.body.member.id).toBe(signIn.body.member.id);
    expect(me.body.member.identities).toEqual([
      { provider: "apple", email: "abc@privaterelay.appleid.com", linkedAt: expect.any(String) },
    ]);
    // authorization code 拿去跟 Apple 換 refresh token(刪除會員時要撤銷),client secret 正確。
    expect(identityProviders.appleTokenCalls).toEqual([
      { code: "code-apple-user-1", clientSecretValid: true, clientId: "com.raychiu.purrdr" },
    ]);
  });

  it("用同一個 Apple ID 再次登入，回到同一個會員", async () => {
    const first = await signInWithApple("apple-user-1");
    const second = await signInWithApple("apple-user-1", { authorizationCode: "second-code" });

    expect(second.status).toBe(200);
    expect(second.body.memberCreated).toBe(false);
    expect(second.body.member.id).toBe(first.body.member.id);
  });

  it("用 Google 登入也能成為會員", async () => {
    const signIn = await signInWithGoogle("google-user-1", { email: "cat@gmail.com" });

    expect(signIn.status).toBe(200);
    expect(signIn.body.memberCreated).toBe(true);
    expect(signIn.body.member.identities).toEqual([{ provider: "google", email: "cat@gmail.com", linkedAt: expect.any(String) }]);
    expect(identityProviders.appleTokenCalls).toEqual([]);
  });

  it("Android 的 Google client ID 簽的 token 也接受(API 不綁平台)", async () => {
    const signIn = await signInWithGoogle("google-user-2", { audience: "test-android.apps.googleusercontent.com" });

    expect(signIn.status).toBe(200);
  });

  it.each([
    ["Apple 沒有公布的金鑰簽的(偽造)", () => signInWithApple("x", { forged: true })],
    ["發給別的 app 的 Apple token", () => signInWithApple("x", { audience: "com.example.other" })],
    ["過期的 Apple token", () => signInWithApple("x", { expiresIn: "-1m" })],
    ["不是 Apple 發的 token", () => signInWithApple("x", { issuer: "https://evil.example" })],
    [
      "Apple token 的 nonce 與請求不符(重送別人的 token)",
      async () =>
        api("POST", "/v1/sessions", {
          body: { provider: "apple", idToken: await appleIdToken({ subject: "x", nonce: "a" }), nonce: "b", authorizationCode: "c" },
        }),
    ],
    ["Google 沒有公布的金鑰簽的(偽造)", () => signInWithGoogle("x", { forged: true })],
    ["發給別的 Google client 的 token", () => signInWithGoogle("x", { audience: "someone-else.apps.googleusercontent.com" })],
    [
      "Google token 的 nonce 與請求不符",
      async () =>
        api("POST", "/v1/sessions", {
          body: { provider: "google", idToken: await googleIdToken({ subject: "x", nonce: "a" }), nonce: "b" },
        }),
    ],
  ])("拒絕無效的登入憑證：%s", async (_, signIn) => {
    const response = await signIn();

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("invalid_id_token");
    const members = await env.DB.prepare("SELECT COUNT(*) AS count FROM members").first<{ count: number }>();
    expect(members?.count).toBe(0);
  });

  it("Apple 拒絕 authorization code 時不建立會員", async () => {
    identityProviders.appleTokenStatus = 400;

    const signIn = await signInWithApple("apple-user-1");

    expect(signIn.status).toBe(401);
    expect(signIn.body.error.code).toBe("invalid_id_token");
    expect((await api("GET", "/v1/members/me")).status).toBe(401);
    const members = await env.DB.prepare("SELECT COUNT(*) AS count FROM members").first<{ count: number }>();
    expect(members?.count).toBe(0);
  });

  it("Sign in with Apple 一定要帶 authorization code(之後刪除會員才能撤銷)", async () => {
    const response = await api("POST", "/v1/sessions", {
      body: { provider: "apple", idToken: await appleIdToken({ subject: "x" }), nonce: "nonce-1" },
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("invalid_request");
  });
});

describe("權杖", () => {
  it("沒有或亂填存取權杖時，會員 API 回 401", async () => {
    expect((await api("GET", "/v1/members/me")).status).toBe(401);
    const garbage = await api("GET", "/v1/members/me", { accessToken: "not-a-token" });
    expect(garbage.status).toBe(401);
    expect(garbage.body.error.code).toBe("invalid_access_token");
  });

  it("用更新權杖換新權杖;舊的更新權杖立即失效", async () => {
    const signIn = await signInWithGoogle("google-user-1");

    const refreshed = await api("POST", "/v1/sessions/refresh", { body: { refreshToken: signIn.body.refreshToken } });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.refreshToken).not.toBe(signIn.body.refreshToken);
    expect(refreshed.body.member.id).toBe(signIn.body.member.id);
    expect((await api("GET", "/v1/members/me", { accessToken: refreshed.body.accessToken })).status).toBe(200);

    const reused = await api("POST", "/v1/sessions/refresh", { body: { refreshToken: signIn.body.refreshToken } });
    expect(reused.status).toBe(401);
    expect(reused.body.error.code).toBe("invalid_refresh_token");
  });

  it("登出後更新權杖失效", async () => {
    const signIn = await signInWithGoogle("google-user-1");

    const signOut = await api("POST", "/v1/sessions/revoke", { body: { refreshToken: signIn.body.refreshToken } });
    expect(signOut.status).toBe(204);

    const refreshed = await api("POST", "/v1/sessions/refresh", { body: { refreshToken: signIn.body.refreshToken } });
    expect(refreshed.status).toBe(401);
  });
});
