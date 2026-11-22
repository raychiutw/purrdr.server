import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { api, appleIdToken, googleIdToken, signInWithApple, signInWithGoogle } from "./fakes";

// 只登入模式(#408):POST /v1/sessions 帶 `createMember: false`,查無會員時回 404 member_not_found、不建立任何資料。

async function counts() {
  const row = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM members) AS members, (SELECT COUNT(*) FROM identities) AS identities,
            (SELECT COUNT(*) FROM devices) AS devices, (SELECT COUNT(*) FROM sessions) AS sessions`,
  ).first<Record<string, number>>();
  return row!;
}

async function signIn(provider: "apple" | "google", subject: string, extra: Record<string, unknown> = {}, options: { email?: string } = {}) {
  const nonce = "nonce-1";
  const idToken =
    provider === "apple" ? await appleIdToken({ subject, nonce, ...options }) : await googleIdToken({ subject, nonce, ...options });
  return api("POST", "/v1/sessions", {
    body: { provider, idToken, nonce, ...(provider === "apple" ? { authorizationCode: `code-${subject}` } : {}), ...extra },
  });
}

describe("只登入(createMember: false)", () => {
  it.each(["apple", "google"] as const)("%s:查無會員回 404 member_not_found,不建立會員、身分、裝置或工作階段", async (provider) => {
    const before = await counts();

    const response = await signIn(provider, `${provider}-new`, { createMember: false, deviceId: "aaaaaaaa-1111-4111-8111-bbbbbbbbbbbb" });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("member_not_found");
    expect(await counts()).toEqual(before);
  });

  it("已有會員:照常登入,回權杖,memberCreated 為 false", async () => {
    await signInWithApple("apple-1");

    const response = await signIn("apple", "apple-1", { createMember: false });

    expect(response.status).toBe(200);
    expect(response.body.memberCreated).toBe(false);
    expect(response.body.accessToken).toEqual(expect.any(String));
  });

  it("新身分的已驗證 email 與既有會員相同:歸到那個會員(自動合併),不算查無會員", async () => {
    await signInWithGoogle("google-1", { email: "ray@example.com" });

    const response = await signIn("apple", "apple-2", { createMember: false }, { email: "ray@example.com" });

    expect(response.status).toBe(200);
    expect(response.body.autoLinked).toBe(true);
    expect(response.body.memberCreated).toBe(false);
  });

  it("帶 true 或省略維持現況:新建會員", async () => {
    const explicit = await signIn("google", "google-explicit", { createMember: true });
    const omitted = await signIn("google", "google-omitted");

    expect(explicit.body.memberCreated).toBe(true);
    expect(omitted.body.memberCreated).toBe(true);
  });

  it("createMember 不是布林回 400 invalid_request,不建立任何資料", async () => {
    const before = await counts();
    for (const value of ["false", 0, null, "no"]) {
      const response = await signIn("google", "google-bad", { createMember: value });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("invalid_request");
    }
    expect(await counts()).toEqual(before);
  });
});
