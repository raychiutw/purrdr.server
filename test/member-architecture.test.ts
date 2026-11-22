import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DAY, submitTransaction } from "./app-store";
import { api, insertPairing, signInWithApple, signInWithGoogle } from "./fakes";

// 新資料結構(#22)上的 API 行為:登入記錄 email 驗證狀態、工作階段、一個會員一個有效訂閱、遷移來的舊裝置。

const RELAY = "abc123@privaterelay.appleid.com";

async function identityRow(subject: string) {
  return env.DB.prepare("SELECT email, email_verified, is_private_relay FROM identities WHERE subject = ?")
    .bind(subject)
    .first<{ email: string | null; email_verified: number; is_private_relay: number }>();
}

describe("登入記錄 email 的驗證狀態", () => {
  it("Google 已驗證的 email 記為已驗證、非私密轉寄", async () => {
    await signInWithGoogle("google-1", { email: "ray@example.com" });
    expect(await identityRow("google-1")).toEqual({ email: "ray@example.com", email_verified: 1, is_private_relay: 0 });
  });

  it("Apple 一般 email 記為已驗證", async () => {
    await signInWithApple("apple-1", { email: "ray@example.com" });
    expect(await identityRow("apple-1")).toEqual({ email: "ray@example.com", email_verified: 1, is_private_relay: 0 });
  });

  it("Apple 私密轉寄 email 標記為轉寄、不算已驗證(不參與自動合併)", async () => {
    await signInWithApple("apple-relay", { email: RELAY });
    expect(await identityRow("apple-relay")).toEqual({ email: RELAY, email_verified: 0, is_private_relay: 1 });
  });

  it("沒有 email 時不算已驗證", async () => {
    await signInWithGoogle("google-no-email");
    expect(await identityRow("google-no-email")).toEqual({ email: null, email_verified: 0, is_private_relay: 0 });
  });

  it("再次登入會更新驗證狀態", async () => {
    await signInWithGoogle("google-2");
    await signInWithGoogle("google-2", { email: "ray@example.com" });
    expect((await identityRow("google-2"))?.email_verified).toBe(1);
  });
});

describe("工作階段(sessions)", () => {
  async function sessionRows() {
    return (await env.DB.prepare("SELECT * FROM sessions").all<Record<string, any>>()).results;
  }

  it("登入建立一個工作階段與它的裝置,資料庫只存更新權杖的雜湊", async () => {
    const signIn = await signInWithApple("apple-1");

    const rows = await sessionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ member_id: signIn.body.member.id, revoked_at: null, previous_refresh_token_hash: null });
    expect(JSON.stringify(rows)).not.toContain(signIn.body.refreshToken);
    const device = await env.DB.prepare("SELECT member_id FROM devices WHERE id = ?").bind(rows[0]!.device_id).first();
    expect(device).toEqual({ member_id: signIn.body.member.id });
  });

  it("換權杖沿用同一個工作階段:新雜湊換掉舊的(舊的記在 previous),舊權杖立即失效", async () => {
    const signIn = await signInWithApple("apple-1");
    const [before] = await sessionRows();

    const refreshed = await api("POST", "/v1/sessions/refresh", { body: { refreshToken: signIn.body.refreshToken } });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.refreshToken).not.toBe(signIn.body.refreshToken);

    const after = await sessionRows();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: before!.id, previous_refresh_token_hash: before!.refresh_token_hash });
    expect(after[0]!.refresh_token_hash).not.toBe(before!.refresh_token_hash);
    expect(after[0]!.rotated_at).toBeGreaterThan(0);

    const reused = await api("POST", "/v1/sessions/refresh", { body: { refreshToken: signIn.body.refreshToken } });
    expect(reused.status).toBe(401);
    expect(reused.body.error.code).toBe("invalid_refresh_token");
  });

  it("登出撤銷工作階段(留下撤銷時間),之後換不到權杖", async () => {
    const signIn = await signInWithApple("apple-1");

    expect((await api("POST", "/v1/sessions/revoke", { body: { refreshToken: signIn.body.refreshToken } })).status).toBe(204);

    const rows = await sessionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.revoked_at).toBeGreaterThan(0);
    expect((await api("POST", "/v1/sessions/refresh", { body: { refreshToken: signIn.body.refreshToken } })).status).toBe(401);
  });

  it("撤銷不存在的權杖也算成功,不影響別人的工作階段", async () => {
    const mine = await signInWithApple("apple-1");
    await signInWithGoogle("google-1");

    expect((await api("POST", "/v1/sessions/revoke", { body: { refreshToken: "never-issued" } })).status).toBe(204);

    expect((await sessionRows()).filter((row) => row.revoked_at === null)).toHaveLength(2);
    expect((await api("POST", "/v1/sessions/refresh", { body: { refreshToken: mine.body.refreshToken } })).status).toBe(200);
  });

  it("到期的工作階段換不到權杖", async () => {
    const signIn = await signInWithApple("apple-1");
    await env.DB.prepare("UPDATE sessions SET expires_at = ?").bind(Date.now() - 1).run();

    expect((await api("POST", "/v1/sessions/refresh", { body: { refreshToken: signIn.body.refreshToken } })).status).toBe(401);
  });
});

describe("一個會員最多一個有效訂閱", () => {
  async function member(subject = "apple-1") {
    const signIn = await signInWithApple(subject);
    return { accessToken: signIn.body.accessToken as string, id: signIn.body.member.id as string };
  }

  async function statuses() {
    return (await env.DB.prepare("SELECT external_id, status FROM subscriptions ORDER BY external_id").all<{ external_id: string; status: string }>()).results;
  }

  it("已有有效訂閱時,提交另一個訂閱回 409 subscription_already_active,原訂閱不變", async () => {
    const me = await member();
    await submitTransaction(me.accessToken, { appAccountToken: me.id, originalTransactionId: "orig-1", transactionId: "orig-1" });

    const second = await submitTransaction(me.accessToken, { appAccountToken: me.id, originalTransactionId: "orig-2", transactionId: "orig-2" });

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("subscription_already_active");
    expect(await statuses()).toEqual([{ external_id: "orig-1", status: "active" }]);
  });

  it("原訂閱已到期(但沒收到到期通知、狀態還記著 active)時,可以提交新訂閱,舊的改記為 expired", async () => {
    const me = await member();
    await submitTransaction(me.accessToken, { appAccountToken: me.id, originalTransactionId: "orig-1", transactionId: "orig-1" });
    await env.DB.prepare("UPDATE subscriptions SET expires_at = ?").bind(Date.now() - DAY).run();

    const second = await submitTransaction(me.accessToken, { appAccountToken: me.id, originalTransactionId: "orig-2", transactionId: "orig-2" });

    expect(second.status).toBe(200);
    expect(await statuses()).toEqual([
      { external_id: "orig-1", status: "expired" },
      { external_id: "orig-2", status: "active" },
    ]);
  });

  it("不同會員各自有自己的有效訂閱", async () => {
    const first = await member("apple-1");
    const second = await member("apple-2");
    expect((await submitTransaction(first.accessToken, { appAccountToken: first.id, originalTransactionId: "orig-1", transactionId: "orig-1" })).status).toBe(200);
    expect((await submitTransaction(second.accessToken, { appAccountToken: second.id, originalTransactionId: "orig-2", transactionId: "orig-2" })).status).toBe(200);
  });

  it("訂閱記下商店識別、環境與狀態快照", async () => {
    const me = await member();
    await submitTransaction(me.accessToken, { appAccountToken: me.id, originalTransactionId: "orig-1", transactionId: "tx-9", environment: "Production" });

    const row = await env.DB.prepare("SELECT member_id, store, external_id, status, environment, current_transaction_id, pending_review FROM subscriptions").first();
    expect(row).toEqual({
      member_id: me.id,
      store: "app_store",
      external_id: "orig-1",
      status: "active",
      environment: "production",
      current_transaction_id: "tx-9",
      pending_review: 0,
    });
  });

  it("退款(帶 revocationDate)的交易狀態記為 revoked,不佔有效訂閱的名額", async () => {
    const me = await member();
    await submitTransaction(me.accessToken, {
      appAccountToken: me.id,
      originalTransactionId: "orig-1",
      transactionId: "orig-1",
      revocationDate: Date.now() - 1000,
    });
    expect(await statuses()).toEqual([{ external_id: "orig-1", status: "revoked" }]);

    expect((await submitTransaction(me.accessToken, { appAccountToken: me.id, originalTransactionId: "orig-2", transactionId: "orig-2" })).status).toBe(200);
  });
});

describe("遷移來的舊裝置(devices.id = token:<device token>)", () => {
  const TOKEN = "ab".repeat(32);
  const HASH = "cd".repeat(32);

  async function memberWithPlus() {
    const signIn = await signInWithApple("apple-1");
    const me = { accessToken: signIn.body.accessToken as string, id: signIn.body.member.id as string };
    await submitTransaction(me.accessToken, { appAccountToken: me.id });
    return me;
  }

  it("清單對外給 legacy-<雜湊>,不洩漏 device token 或內部 id", async () => {
    const me = await memberWithPlus();
    await insertPairing({ keyHash: HASH, memberId: me.id, deviceToken: TOKEN });

    const listed = await api("GET", "/v1/members/me/push-devices", { accessToken: me.accessToken });

    expect(listed.status).toBe(200);
    expect(listed.body.devices).toHaveLength(1);
    expect(listed.body.devices[0].deviceId).toMatch(/^legacy-[0-9a-f]{32}$/);
    expect(JSON.stringify(listed.body)).not.toContain(TOKEN);
    expect(JSON.stringify(listed.body)).not.toContain("token:");
  });

  it("用對外 id 改名,名稱存在 devices,id 不變", async () => {
    const me = await memberWithPlus();
    await insertPairing({ keyHash: HASH, memberId: me.id, deviceToken: TOKEN });
    const [device] = (await api("GET", "/v1/members/me/push-devices", { accessToken: me.accessToken })).body.devices;

    const renamed = await api("PATCH", `/v1/members/me/push-devices/${device.deviceId}`, { accessToken: me.accessToken, body: { name: "書房 iPad" } });

    expect(renamed.status).toBe(200);
    expect(renamed.body.device).toMatchObject({ deviceId: device.deviceId, name: "書房 iPad" });
    const stored = await env.DB.prepare("SELECT name FROM devices WHERE id = ?").bind(`token:${TOKEN}`).first();
    expect(stored).toEqual({ name: "書房 iPad" });
  });

  it("用對外 id 遠端關閉,配對刪除", async () => {
    const me = await memberWithPlus();
    await insertPairing({ keyHash: HASH, memberId: me.id, deviceToken: TOKEN });
    const [device] = (await api("GET", "/v1/members/me/push-devices", { accessToken: me.accessToken })).body.devices;

    expect((await api("DELETE", `/v1/members/me/push-devices/${device.deviceId}`, { accessToken: me.accessToken })).status).toBe(204);

    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM push_pairings").first<{ n: number }>())!.n).toBe(0);
    expect((await api("GET", "/v1/members/me/push-devices", { accessToken: me.accessToken })).body.devices).toEqual([]);
  });
});
