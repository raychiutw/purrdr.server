import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { api, googleIdToken, insertPairing, signInWithApple, signInWithGoogle } from "./fakes";

const DEVICE_A = "aaaaaaaa-1111-4111-8111-bbbbbbbbbbbb";
const MERGE = "/v1/members/me/identities/merge";
const LINK = "/v1/members/me/identities";
const DAY = 86_400_000;

async function signIn(subject: string, extra: Record<string, unknown> = {}, email?: string) {
  const nonce = "nonce-1";
  return api("POST", "/v1/sessions", {
    body: { provider: "google", idToken: await googleIdToken({ subject, nonce, ...(email ? { email } : {}) }), nonce, ...extra },
  });
}

async function count(table: string, where = "1 = 1"): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).first<{ count: number }>();
  return row?.count ?? 0;
}

async function giveSubscription(memberId: string, status: string, expiresAt = Date.now() + DAY) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO subscriptions (id, member_id, store, external_id, product_id, status, expires_at, environment, updated_at,
       current_transaction_id, purchased_at, transaction_signed_at)
     VALUES (?, ?, 'app_store', ?, 'com.raychiu.purrdr.plus.monthly', ?, ?, 'sandbox', ?, '1', ?, ?)`,
  )
    .bind(`sub-${memberId}`, memberId, `original-${memberId}`, status, expiresAt, now, now, now)
    .run();
}

describe("審查修正", () => {
  it("1. 登入的 deviceId 一律轉小寫,大小寫不同的同一支裝置只有一列", async () => {
    await signIn("g-1", { deviceId: DEVICE_A.toUpperCase() });
    await signIn("g-1", { deviceId: DEVICE_A });

    expect(await count("devices")).toBe(1);
    expect(await count("devices", `id = '${DEVICE_A}'`)).toBe(1);
  });

  it("2. 確認合併:目前會員已有被驗證的提供者 → 409 provider_already_linked,不動資料", async () => {
    const me = await signInWithGoogle("google-mine");
    await signInWithApple("apple-theirs");
    const other = await signInWithGoogle("google-theirs");
    expect(other.status).toBe(200);

    const merge = await api("POST", MERGE, {
      accessToken: me.body.accessToken,
      body: { provider: "google", idToken: await googleIdToken({ subject: "google-theirs", nonce: "n" }), nonce: "n" },
    });

    expect(merge.status).toBe(409);
    expect(merge.body.error.code).toBe("provider_already_linked");
    expect(await count("members")).toBe(3);
  });

  it("3. 別人帶使用中裝置的 deviceId 登入:不改歸屬、不撤銷原工作階段,自己另建裝置列照常登入", async () => {
    const a = await signIn("g-a", { deviceId: DEVICE_A });
    const b = await signIn("g-b", { deviceId: DEVICE_A });

    expect(b.status).toBe(200);
    expect(await env.DB.prepare("SELECT member_id FROM devices WHERE id = ?").bind(DEVICE_A).first()).toEqual({ member_id: a.body.member.id });
    expect((await api("POST", "/v1/sessions/refresh", { body: { refreshToken: a.body.refreshToken } })).status).toBe(200);
    expect((await api("POST", "/v1/sessions/refresh", { body: { refreshToken: b.body.refreshToken } })).status).toBe(200);
    expect(await count("devices")).toBe(2);
  });

  it("3. 原會員已登出(工作階段已撤銷)時,同一支手機換會員登入沿用裝置列", async () => {
    const a = await signIn("g-a", { deviceId: DEVICE_A });
    await api("POST", "/v1/sessions/revoke", { body: { refreshToken: a.body.refreshToken } });
    const b = await signIn("g-b", { deviceId: DEVICE_A });

    expect(await env.DB.prepare("SELECT member_id FROM devices WHERE id = ?").bind(DEVICE_A).first()).toEqual({ member_id: b.body.member.id });
    expect(await count("devices")).toBe(1);
  });

  it("4. 裝置換會員時撤銷原會員在該裝置的推播配對", async () => {
    const a = await signIn("g-a", { deviceId: DEVICE_A });
    await insertPairing({ keyHash: "key-a", memberId: a.body.member.id, deviceToken: "tok", deviceId: DEVICE_A });
    await api("POST", "/v1/sessions/revoke", { body: { refreshToken: a.body.refreshToken } });
    await signIn("g-b", { deviceId: DEVICE_A });

    expect(await count("push_pairings")).toBe(0);
    expect(await count("revoked_push_pairings", `key_hash = 'key-a' AND member_id = '${a.body.member.id}'`)).toBe(1);
  });

  it("5. token 沒帶 email 的再次登入不把 email_verified 洗成 0", async () => {
    await signIn("g-1", {}, "ray@example.com");
    expect(await count("identities", "email_verified = 1")).toBe(1);

    await signIn("g-1");

    expect(await count("identities", "email_verified = 1")).toBe(1);
  });

  it("6. 沒帶 deviceId 的佔位裝置在工作階段登出後刪除;platform 可選、不合法 400", async () => {
    const s = await signIn("g-1");
    expect(await count("devices")).toBe(1);
    await api("POST", "/v1/sessions/revoke", { body: { refreshToken: s.body.refreshToken } });
    expect(await count("devices")).toBe(0);

    const android = await signIn("g-1", { platform: "android" });
    expect(android.status).toBe(200);
    expect(await count("devices", "platform = 'android'")).toBe(1);
    expect((await signIn("g-1", { platform: "windows" })).status).toBe(400);
  });

  it("6. 有推播配對的裝置不會被刪", async () => {
    const a = await signIn("g-a", { deviceId: DEVICE_A });
    await insertPairing({ keyHash: "key-a", memberId: a.body.member.id, deviceToken: "tok", deviceId: DEVICE_A });
    await api("POST", "/v1/sessions/revoke", { body: { refreshToken: a.body.refreshToken } });

    expect(await count("devices", `id = '${DEVICE_A}'`)).toBe(1);
  });

  it("7. 路徑壞 escape 回 400 invalid_request", async () => {
    const a = await signIn("g-a", { deviceId: DEVICE_A });

    for (const path of ["/v1/members/me/sessions/%E0%A4%A", "/v1/members/me/push-devices/%E0%A4%A", "/v1/members/me/push-pairings/%E0%A4%A"]) {
      const response = await api("DELETE", path, { accessToken: a.body.accessToken });
      expect(response.status, path).toBe(400);
      expect(response.body.error.code).toBe("invalid_request");
    }
  });

  it("8. 合併摘要的 canMerge 用名額判斷:兩邊都是 billing_retry 也不能合併", async () => {
    const me = await signInWithApple("apple-user-1");
    const other = await signInWithGoogle("google-user-1");
    // 帳單重試期:已過期、沒有 Plus 權限,但名額還在(holdsLiveSlot)。
    await giveSubscription(me.body.member.id, "billing_retry", Date.now() - DAY);
    await giveSubscription(other.body.member.id, "billing_retry", Date.now() - DAY);

    const link = await api("POST", LINK, {
      accessToken: me.body.accessToken,
      body: { provider: "google", idToken: await googleIdToken({ subject: "google-user-1", nonce: "n" }), nonce: "n" },
    });

    expect(link.status).toBe(409);
    expect(link.body.error.details.canMerge).toBe(false);
  });
});
