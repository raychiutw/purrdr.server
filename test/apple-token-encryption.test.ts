import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { api, identityProviders, signInWithApple } from "./fakes";

/// Sign in with Apple 的 refresh token 以 AES-GCM 加密存放(#3);只在撤銷時解密。

async function storedAppleToken(subject: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT apple_refresh_token FROM identities WHERE provider = 'apple' AND subject = ?")
    .bind(subject)
    .first<{ apple_refresh_token: string | null }>();
  return row?.apple_refresh_token ?? null;
}

describe("Apple refresh token 加密存放", () => {
  it("資料庫不存明文，刪除會員時仍以原本的權杖向 Apple 撤銷", async () => {
    const signIn = await signInWithApple("apple-user-1");

    const stored = await storedAppleToken("apple-user-1");
    expect(stored).not.toBeNull();
    expect(stored).not.toContain("apple-refresh-for-code-apple-user-1");

    const deletion = await api("DELETE", "/v1/members/me", { accessToken: signIn.body.accessToken });
    expect(deletion.status).toBe(204);
    expect(identityProviders.appleRevokeCalls.map((call) => call.token)).toEqual(["apple-refresh-for-code-apple-user-1"]);
  });

  it("解不開的權杖視同沒有：刪除會員照常完成，不呼叫 Apple", async () => {
    const signIn = await signInWithApple("apple-user-1");
    await env.DB.prepare("UPDATE identities SET apple_refresh_token = 'apple-refresh-plaintext-or-garbage' WHERE subject = 'apple-user-1'").run();

    const deletion = await api("DELETE", "/v1/members/me", { accessToken: signIn.body.accessToken });

    expect(deletion.status).toBe(204);
    expect(identityProviders.appleRevokeCalls).toEqual([]);
  });
});
