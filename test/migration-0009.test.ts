import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

// 0009 會員架構重做的遷移(#22):先建出 0001~0008 的舊資料庫、塞一份快照資料,再套用 0009,
// 驗證合併、待處理標記、外鍵與資料搬移。

const DAY = 86_400_000;
const T0 = Date.now();
const LEGACY = (name: string) => name < "0009";
const RELAY = "abc123@privaterelay.appleid.com";

/// 依 foreign key 的相反順序丟掉所有資料表(D1 不能關掉 foreign key),含 d1_migrations,讓 migration 從頭套用。
async function dropEverything() {
  const tables = [
    "host_presence", "push_daily_usage", "push_kinds", "host_service_push_events", "subscription_events", "subscription_transfers", "sessions", "push_pairings", "subscriptions",
    "devices", "revoked_push_pairings", "push_devices", "refresh_tokens", "entitlements", "synced_hosts", "identities", "members",
    "d1_migrations",
  ];
  await env.DB.batch(tables.map((name) => env.DB.prepare(`DROP TABLE IF EXISTS ${name}`)));
}

async function applyLegacySchema() {
  await dropEverything();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.filter((migration) => LEGACY(migration.name)));
}

async function applyNewMigrations() {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
}

function run(sql: string, ...values: unknown[]) {
  return env.DB.prepare(sql).bind(...values);
}

function legacyMember(id: string, createdAt: number) {
  return run("INSERT INTO members (id, created_at) VALUES (?, ?)", id, createdAt);
}

function legacyIdentity(memberId: string, provider: "apple" | "google", subject: string, email: string | null, appleRefreshToken: string | null = null) {
  return run(
    "INSERT INTO identities (provider, subject, member_id, email, apple_refresh_token, linked_at) VALUES (?, ?, ?, ?, ?, ?)",
    provider,
    subject,
    memberId,
    email,
    appleRefreshToken,
    T0 - 10 * DAY,
  );
}

function legacyEntitlement(
  memberId: string,
  originalTransactionId: string,
  expiresAt: number,
  extra: { revokedAt?: number; graceUntil?: number; environment?: string; willAutoRenew?: number } = {},
) {
  return run(
    `INSERT INTO entitlements (store, original_transaction_id, member_id, environment, product_id, transaction_id, purchased_at, expires_at,
       revoked_at, transaction_signed_at, will_auto_renew, grace_period_expires_at, renewal_signed_at, updated_at)
     VALUES ('app_store', ?, ?, ?, 'com.raychiu.purrdr.plus.monthly', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    originalTransactionId,
    memberId,
    extra.environment ?? "Production",
    `tx-${originalTransactionId}`,
    T0 - 20 * DAY,
    expiresAt,
    extra.revokedAt ?? null,
    T0 - 5 * DAY,
    extra.willAutoRenew ?? null,
    extra.graceUntil ?? null,
    extra.graceUntil === undefined ? null : T0 - 4 * DAY,
    T0 - 3 * DAY,
  );
}

function legacyHost(memberId: string, hostId: string, name: string, modifiedAt: number) {
  return run(
    `INSERT INTO synced_hosts (member_id, host_id, name, address, port, username, connection_method, modified_at, updated_at)
     VALUES (?, ?, ?, 'host.example', 22, 'ray', 'openssh', ?, ?)`,
    memberId,
    hostId,
    name,
    modifiedAt,
    modifiedAt,
  );
}

function legacyPairing(memberId: string, keyHash: string, deviceToken: string, deviceId: string | null, updatedAt: number, kinds = '["blocked"]') {
  return run(
    `INSERT INTO push_pairings (key_hash, member_id, platform, device_token, environment, created_at, updated_at, device_id, kinds)
     VALUES (?, ?, 'apns', ?, 'production', ?, ?, ?, ?)`,
    keyHash,
    memberId,
    deviceToken,
    updatedAt - DAY,
    updatedAt,
    deviceId,
    kinds,
  );
}

/// 快照:舊版會員資料庫裡各種會被遷移碰到的情況。
async function seedSnapshot() {
  await env.DB.batch([
    // m1+m2:Apple 與 Google 用同一個 email(大小寫不同),兩邊都有有效訂閱 → 合併,保留到期較晚者(E2)。
    legacyMember("m1", T0 - 100 * DAY),
    legacyIdentity("m1", "apple", "apple-1", "ray@example.com", "sealed-apple-token"),
    legacyEntitlement("m1", "E1", T0 + 30 * DAY),
    legacyMember("m2", T0 - 90 * DAY),
    legacyIdentity("m2", "google", "google-2", "Ray@Example.com"),
    legacyEntitlement("m2", "E2", T0 + 60 * DAY, { willAutoRenew: 1 }),
    run("INSERT INTO refresh_tokens (token_hash, member_id, expires_at, created_at) VALUES ('rt-m1', 'm1', ?, ?)", T0 + DAY, T0),
    run("INSERT INTO refresh_tokens (token_hash, member_id, expires_at, created_at) VALUES ('rt-m2', 'm2', ?, ?)", T0 + DAY, T0),

    // m3、m4:email 都是 Apple 私密轉寄,不參與合併。
    legacyMember("m3", T0 - 80 * DAY),
    legacyIdentity("m3", "apple", "apple-3", RELAY),
    legacyMember("m4", T0 - 70 * DAY),
    legacyIdentity("m4", "google", "google-4", RELAY),

    // m5+m6:同 email、沒有訂閱,各有主機與推播資料 → 合併成較早建立的 m5。
    legacyMember("m5", T0 - 60 * DAY),
    legacyIdentity("m5", "apple", "apple-5", "solo@example.com"),
    legacyMember("m6", T0 - 50 * DAY),
    legacyIdentity("m6", "google", "google-6", "solo@example.com"),
    legacyHost("m5", "host-1", "舊名稱", T0 - 2 * DAY),
    legacyHost("m6", "host-1", "新名稱", T0 - DAY),
    legacyHost("m6", "host-2", "只有 m6 有", T0 - DAY),
    legacyPairing("m5", "key-5a", "token-5", "dev-5", T0 - DAY, '["blocked","done"]'),
    legacyPairing("m5", "key-5b", "token-5-new", "dev-5", T0 - 1000),
    legacyPairing("m6", "key-6", "token-6", null, T0 - 2000),
    run("INSERT INTO push_devices (member_id, device_id, name, model) VALUES ('m5', 'dev-5', 'Ray 的 iPhone', 'iPhone')"),
    run("INSERT INTO push_devices (member_id, device_id, name, model) VALUES ('m5', 'dev-idle', '沒有配對的 iPad', 'iPad')"),
    run("INSERT INTO host_service_push_events (key_hash, member_id, event, version, sent_at) VALUES ('key-5a', 'm5', 'host_service_updated', '1.2.3', ?)", T0),
    run("INSERT INTO revoked_push_pairings (key_hash, member_id, revoked_at) VALUES ('key-revoked', 'm6', ?)", T0),

    // m7+m8:同 email,只有 m8 有效 → 合併成 m8(有有效訂閱者優先),過期的 E7 仍保留為 expired。
    legacyMember("m7", T0 - 40 * DAY),
    legacyIdentity("m7", "apple", "apple-7", "x@example.com"),
    legacyEntitlement("m7", "E7", T0 - 10 * DAY),
    legacyMember("m8", T0 - 30 * DAY),
    legacyIdentity("m8", "google", "google-8", "x@example.com"),
    legacyEntitlement("m8", "E8", T0 + 10 * DAY, { environment: "Sandbox" }),

    // m9:帳單寬限期中(grace);m10:已退款;m11:沒有 email 的 Google。
    legacyMember("m9", T0 - 20 * DAY),
    legacyIdentity("m9", "apple", "apple-9", null),
    legacyEntitlement("m9", "E9", T0 - DAY, { graceUntil: T0 + 5 * DAY }),
    legacyMember("m10", T0 - 15 * DAY),
    legacyIdentity("m10", "google", "google-10", "refund@example.com"),
    legacyEntitlement("m10", "E10", T0 + 20 * DAY, { revokedAt: T0 - DAY }),
    legacyMember("m11", T0 - 10 * DAY),
    legacyIdentity("m11", "google", "google-11", null),
  ]);
}

async function all<T>(sql: string, ...values: unknown[]): Promise<T[]> {
  const { results } = await env.DB.prepare(sql).bind(...values).all<T>();
  return results;
}

async function count(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>();
  return row?.count ?? 0;
}

describe("0009 遷移:舊資料快照", () => {
  beforeEach(async () => {
    await applyLegacySchema();
    await seedSnapshot();
    await applyNewMigrations();
  });

  it("已驗證 email 相同的會員合併,登入方式都保留", async () => {
    const members = (await all<{ id: string }>("SELECT id FROM members ORDER BY id")).map((row) => row.id);
    // m1+m2 → m1(都有有效訂閱,較早建立);m5+m6 → m5;m7+m8 → m8(有有效訂閱者優先)。
    expect(members).toEqual(["m1", "m10", "m11", "m3", "m4", "m5", "m8", "m9"]);

    const identities = await all<{ member_id: string; provider: string; subject: string }>(
      "SELECT member_id, provider, subject FROM identities ORDER BY subject",
    );
    expect(identities).toEqual([
      { member_id: "m1", provider: "apple", subject: "apple-1" },
      { member_id: "m3", provider: "apple", subject: "apple-3" },
      { member_id: "m5", provider: "apple", subject: "apple-5" },
      { member_id: "m8", provider: "apple", subject: "apple-7" },
      { member_id: "m9", provider: "apple", subject: "apple-9" },
      { member_id: "m10", provider: "google", subject: "google-10" },
      { member_id: "m11", provider: "google", subject: "google-11" },
      { member_id: "m1", provider: "google", subject: "google-2" },
      { member_id: "m4", provider: "google", subject: "google-4" },
      { member_id: "m5", provider: "google", subject: "google-6" },
      { member_id: "m8", provider: "google", subject: "google-8" },
    ]);
  });

  it("Apple 私密轉寄 email 不合併,並標記 is_private_relay、email_verified", async () => {
    const rows = await all<{ subject: string; email_verified: number; is_private_relay: number }>(
      "SELECT subject, email_verified, is_private_relay FROM identities WHERE subject IN ('apple-3', 'google-4', 'apple-1', 'google-11') ORDER BY subject",
    );
    expect(rows).toEqual([
      { subject: "apple-1", email_verified: 1, is_private_relay: 0 },
      { subject: "apple-3", email_verified: 0, is_private_relay: 1 },
      { subject: "google-11", email_verified: 0, is_private_relay: 0 },
      // 私密轉寄只針對 Apple;Google 的 email 一律視為已驗證(見 migration 的判定說明)。
      { subject: "google-4", email_verified: 1, is_private_relay: 0 },
    ]);
  });

  it("Apple refresh token 隨身分保留(刪除會員時撤銷用)", async () => {
    const row = await env.DB.prepare("SELECT apple_refresh_token FROM identities WHERE subject = 'apple-1'").first<{ apple_refresh_token: string }>();
    expect(row?.apple_refresh_token).toBe("sealed-apple-token");
  });

  it("兩邊都有有效訂閱:保留到期較晚者,另一筆標待處理(兩筆都歸合併後的會員)", async () => {
    const rows = await all<{ external_id: string; member_id: string; status: string; pending_review: number }>(
      "SELECT external_id, member_id, status, pending_review FROM subscriptions WHERE external_id IN ('E1', 'E2') ORDER BY external_id",
    );
    expect(rows).toEqual([
      { external_id: "E1", member_id: "m1", status: "active", pending_review: 1 },
      { external_id: "E2", member_id: "m1", status: "active", pending_review: 0 },
    ]);
  });

  it("只有一邊有效:不標待處理;過期的保留為 expired,歸有效訂閱者所在的會員", async () => {
    const rows = await all<{ external_id: string; member_id: string; status: string; pending_review: number; environment: string }>(
      "SELECT external_id, member_id, status, pending_review, environment FROM subscriptions WHERE external_id IN ('E7', 'E8') ORDER BY external_id",
    );
    expect(rows).toEqual([
      { external_id: "E7", member_id: "m8", status: "expired", pending_review: 0, environment: "production" },
      { external_id: "E8", member_id: "m8", status: "active", pending_review: 0, environment: "sandbox" },
    ]);
  });

  it("狀態依遷移當下推算:寬限期 → grace、退款 → revoked,續訂與簽章時間欄位保留", async () => {
    const rows = await all<Record<string, unknown>>(
      `SELECT external_id, status, auto_renew, revoked_at, grace_expires_at, current_transaction_id, transaction_signed_at
       FROM subscriptions WHERE external_id IN ('E2', 'E9', 'E10') ORDER BY external_id`,
    );
    expect(rows.map((row) => [row.external_id, row.status])).toEqual([
      ["E10", "revoked"],
      ["E2", "active"],
      ["E9", "grace"],
    ]);
    expect(rows.find((row) => row.external_id === "E2")).toMatchObject({ auto_renew: 1, current_transaction_id: "tx-E2" });
    expect(rows.find((row) => row.external_id === "E9")?.grace_expires_at).toBeGreaterThan(T0);
    expect(rows.find((row) => row.external_id === "E10")?.revoked_at).toBe(T0 - DAY);
  });

  it("推播:裝置與配對搬到新結構,歸合併後的會員,偏好保留", async () => {
    const devices = await all<{ id: string; member_id: string; name: string | null; model: string | null; push_token: string | null; push_environment: string | null; platform: string }>(
      "SELECT id, member_id, name, model, push_token, push_environment, platform FROM devices ORDER BY id",
    );
    expect(devices).toEqual([
      { id: "dev-5", member_id: "m5", name: "Ray 的 iPhone", model: "iPhone", push_token: "token-5-new", push_environment: "production", platform: "ios" },
      { id: "dev-idle", member_id: "m5", name: "沒有配對的 iPad", model: "iPad", push_token: null, push_environment: null, platform: "ios" },
      // 舊版 app 沒有 device_id:以 device token 歸類。
      { id: "token:token-6", member_id: "m5", name: null, model: null, push_token: "token-6", push_environment: "production", platform: "ios" },
    ]);

    const pairings = await all<{ key_hash: string; member_id: string; device_id: string; kinds: string; muted: string }>(
      "SELECT key_hash, member_id, device_id, kinds, muted FROM push_pairings ORDER BY key_hash",
    );
    expect(pairings).toEqual([
      // 偏好原樣保留;0011(#39)替既有配對補開 daily_limit_reached,升級後仍收得到上限通知。
      { key_hash: "key-5a", member_id: "m5", device_id: "dev-5", kinds: '["blocked","done","daily_limit_reached"]', muted: "[]" },
      { key_hash: "key-5b", member_id: "m5", device_id: "dev-5", kinds: '["blocked","daily_limit_reached"]', muted: "[]" },
      { key_hash: "key-6", member_id: "m5", device_id: "token:token-6", kinds: '["blocked","daily_limit_reached"]', muted: "[]" },
    ]);
  });

  it("主機服務推播去重紀錄與撤銷紀錄跟著搬", async () => {
    expect(await all("SELECT key_hash, member_id, event, version FROM host_service_push_events")).toEqual([
      { key_hash: "key-5a", member_id: "m5", event: "host_service_updated", version: "1.2.3" },
    ]);
    expect(await all("SELECT key_hash, member_id FROM revoked_push_pairings")).toEqual([{ key_hash: "key-revoked", member_id: "m5" }]);
  });

  it("主機同步:合併後同一台主機取最後修改者,其餘都保留", async () => {
    const hosts = await all<{ member_id: string; host_id: string; name: string }>(
      "SELECT member_id, host_id, name FROM synced_hosts ORDER BY host_id",
    );
    expect(hosts).toEqual([
      { member_id: "m5", host_id: "host-1", name: "新名稱" },
      { member_id: "m5", host_id: "host-2", name: "只有 m6 有" },
    ]);
  });

  it("舊的更新權杖全部作廢:沒有任何工作階段,舊資料表已移除", async () => {
    expect(await count("sessions")).toBe(0);
    const tables = (await all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")).map((row) => row.name);
    for (const gone of ["refresh_tokens", "entitlements", "push_devices", "legacy_identities", "legacy_push_pairings"]) {
      expect(tables, gone).not.toContain(gone);
    }
    for (const table of ["members", "identities", "subscriptions", "subscription_events", "subscription_transfers", "devices", "sessions", "push_pairings", "synced_hosts"]) {
      expect(tables, table).toContain(table);
    }
  });

  it("外鍵全部正確、沒有遷移用的暫存表殘留", async () => {
    expect(await all("PRAGMA foreign_key_check")).toEqual([]);
    const tables = (await all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")).map((row) => row.name);
    expect(tables.filter((name) => name.startsWith("_mig") || name.startsWith("legacy_"))).toEqual([]);
  });

  it("重複套用不會改變資料(migration 以 d1_migrations 記錄,只跑一次)", async () => {
    const before = {
      members: await all("SELECT * FROM members ORDER BY id"),
      subscriptions: await all("SELECT * FROM subscriptions ORDER BY external_id"),
      devices: await all("SELECT * FROM devices ORDER BY id"),
    };
    await applyNewMigrations();
    await applyNewMigrations();
    expect({
      members: await all("SELECT * FROM members ORDER BY id"),
      subscriptions: await all("SELECT * FROM subscriptions ORDER BY external_id"),
      devices: await all("SELECT * FROM devices ORDER BY id"),
    }).toEqual(before);
  });

  it("遷移後每個會員最多一個有效且未待處理的訂閱", async () => {
    const rows = await all<{ member_id: string; n: number }>(
      `SELECT member_id, COUNT(*) AS n FROM subscriptions
       WHERE status IN ('active', 'grace', 'billing_retry') AND pending_review = 0 GROUP BY member_id HAVING n > 1`,
    );
    expect(rows).toEqual([]);
  });
});

describe("0009 遷移:空資料庫", () => {
  it("沒有舊資料也能套用", async () => {
    await applyLegacySchema();
    await applyNewMigrations();
    expect(await count("members")).toBe(0);
    expect(await all("PRAGMA foreign_key_check")).toEqual([]);
  });
});
