import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// 新資料結構(#22,規格 raychiutw/purrdr.ios#402「後台資料結構(正規化)」)的限制:
// 直接對 D1 寫入,看資料庫自己擋不擋(不經過 API)。

const NOW = 1_800_000_000_000;

async function member(id: string) {
  await env.DB.prepare("INSERT INTO members (id, created_at) VALUES (?, ?)").bind(id, NOW).run();
}

async function subscription(memberId: string, externalId: string, status: string, extra: { pending?: number; store?: string } = {}) {
  await env.DB.prepare(
    `INSERT INTO subscriptions (id, member_id, store, external_id, product_id, status, expires_at, environment, updated_at, pending_review)
     VALUES (?, ?, ?, ?, 'com.raychiu.purrdr.plus.monthly', ?, ?, 'sandbox', ?, ?)`,
  )
    .bind(`sub-${memberId}-${externalId}`, memberId, extra.store ?? "app_store", externalId, status, NOW + 86_400_000, NOW, extra.pending ?? 0)
    .run();
}

async function device(id: string, memberId: string | null) {
  await env.DB.prepare("INSERT INTO devices (id, member_id, platform, created_at, last_seen_at) VALUES (?, ?, 'ios', ?, ?)")
    .bind(id, memberId, NOW, NOW)
    .run();
}

async function session(id: string, memberId: string, deviceId: string, hash: string, revokedAt: number | null = null) {
  await env.DB.prepare(
    `INSERT INTO sessions (id, member_id, device_id, refresh_token_hash, expires_at, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, memberId, deviceId, hash, NOW + 86_400_000, NOW, revokedAt)
    .run();
}

async function count(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>();
  return row?.count ?? 0;
}

describe("subscriptions:一個會員最多一個有效訂閱", () => {
  it("同一會員第二個 active 訂閱被拒", async () => {
    await member("m1");
    await subscription("m1", "orig-1", "active");
    await expect(subscription("m1", "orig-2", "active")).rejects.toThrow(/UNIQUE/i);
  });

  it.each([
    ["active", "grace"],
    ["grace", "billing_retry"],
    ["billing_retry", "active"],
  ])("有效狀態之間互相排斥(%s 與 %s)", async (first, second) => {
    await member("m1");
    await subscription("m1", "orig-1", first);
    await expect(subscription("m1", "orig-2", second)).rejects.toThrow(/UNIQUE/i);
  });

  it.each(["expired", "revoked", "refunded"])("已結束的訂閱(%s)不佔名額,可以再有一個有效訂閱", async (ended) => {
    await member("m1");
    await subscription("m1", "orig-old", ended);
    await subscription("m1", "orig-old-2", ended);
    await subscription("m1", "orig-new", "active");
    expect(await count("subscriptions")).toBe(3);
  });

  it("不同會員各自可以有一個有效訂閱", async () => {
    await member("m1");
    await member("m2");
    await subscription("m1", "orig-1", "active");
    await subscription("m2", "orig-2", "active");
    expect(await count("subscriptions")).toBe(2);
  });

  it("標為待處理(遷移合併留下的第二筆)不佔名額,但仍保留真實狀態", async () => {
    await member("m1");
    await subscription("m1", "orig-keep", "active");
    await subscription("m1", "orig-pending", "active", { pending: 1 });
    const row = await env.DB.prepare("SELECT status, pending_review FROM subscriptions WHERE external_id = 'orig-pending'").first<{
      status: string;
      pending_review: number;
    }>();
    expect(row).toEqual({ status: "active", pending_review: 1 });
  });

  it("同一個商店識別不能屬於兩個會員", async () => {
    await member("m1");
    await member("m2");
    await subscription("m1", "orig-1", "expired");
    await expect(subscription("m2", "orig-1", "expired")).rejects.toThrow(/UNIQUE/i);
  });

  it("同一個識別在不同商店不衝突", async () => {
    await member("m1");
    await member("m2");
    await subscription("m1", "same-id", "expired", { store: "app_store" });
    await subscription("m2", "same-id", "expired", { store: "google_play" });
    expect(await count("subscriptions")).toBe(2);
  });

  it("status 與 store 只收規格列的值", async () => {
    await member("m1");
    await expect(subscription("m1", "orig-1", "paused")).rejects.toThrow(/CHECK/i);
    await expect(subscription("m1", "orig-2", "expired", { store: "amazon" })).rejects.toThrow(/CHECK/i);
  });
});

describe("identities", () => {
  it("同一提供者同一 subject 只能屬於一個會員", async () => {
    await member("m1");
    await member("m2");
    const insert = (id: string, memberId: string) =>
      env.DB.prepare("INSERT INTO identities (id, member_id, provider, subject, linked_at) VALUES (?, ?, 'apple', 'subject-1', ?)")
        .bind(id, memberId, NOW)
        .run();
    await insert("i1", "m1");
    await expect(insert("i2", "m2")).rejects.toThrow(/UNIQUE/i);
  });

  it("email_verified 與 is_private_relay 預設是 0", async () => {
    await member("m1");
    await env.DB.prepare("INSERT INTO identities (id, member_id, provider, subject, linked_at) VALUES ('i1', 'm1', 'google', 'g1', ?)").bind(NOW).run();
    const row = await env.DB.prepare("SELECT email_verified, is_private_relay FROM identities WHERE id = 'i1'").first();
    expect(row).toEqual({ email_verified: 0, is_private_relay: 0 });
  });
});

describe("sessions:每個裝置最多一個未撤銷的工作階段", () => {
  it("同一裝置第二個未撤銷工作階段被拒", async () => {
    await member("m1");
    await device("d1", "m1");
    await session("s1", "m1", "d1", "hash-1");
    await expect(session("s2", "m1", "d1", "hash-2")).rejects.toThrow(/UNIQUE/i);
  });

  it("舊的已撤銷後,同一裝置可以再有新的", async () => {
    await member("m1");
    await device("d1", "m1");
    await session("s1", "m1", "d1", "hash-1", NOW);
    await session("s2", "m1", "d1", "hash-2");
    expect(await count("sessions")).toBe(2);
  });

  it("不同裝置各有一個", async () => {
    await member("m1");
    await device("d1", "m1");
    await device("d2", "m1");
    await session("s1", "m1", "d1", "hash-1");
    await session("s2", "m1", "d2", "hash-2");
    expect(await count("sessions")).toBe(2);
  });

  it("更新權杖雜湊不重複", async () => {
    await member("m1");
    await device("d1", "m1");
    await device("d2", "m1");
    await session("s1", "m1", "d1", "same-hash");
    await expect(session("s2", "m1", "d2", "same-hash")).rejects.toThrow(/UNIQUE/i);
  });
});

describe("刪除會員:ON DELETE CASCADE 清掉它的一切", () => {
  it("九張表(synced_hosts 沿用既有)與衍生資料全部清空", async () => {
    await member("m1");
    await member("m2");
    await env.DB.prepare("INSERT INTO identities (id, member_id, provider, subject, linked_at) VALUES ('i1', 'm1', 'apple', 'a1', ?)").bind(NOW).run();
    await subscription("m1", "orig-1", "active");
    await env.DB.prepare(
      "INSERT INTO subscription_events (id, subscription_id, source, type, notification_uuid, received_at) VALUES ('e1', 'sub-m1-orig-1', 'store_notification', 'DID_RENEW', 'uuid-1', ?)",
    )
      .bind(NOW)
      .run();
    await env.DB.prepare(
      "INSERT INTO subscription_transfers (id, subscription_id, from_member, to_member, transferred_at) VALUES ('t1', 'sub-m1-orig-1', 'm2', 'm1', ?)",
    )
      .bind(NOW)
      .run();
    await device("d1", "m1");
    await session("s1", "m1", "d1", "hash-1");
    await env.DB.prepare(
      "INSERT INTO push_pairings (id, member_id, device_id, key_hash, created_at, updated_at) VALUES ('p1', 'm1', 'd1', 'key-1', ?, ?)",
    )
      .bind(NOW, NOW)
      .run();
    await env.DB.prepare(
      "INSERT INTO synced_hosts (member_id, host_id, modified_at, updated_at) VALUES ('m1', 'h1', ?, ?)",
    )
      .bind(NOW, NOW)
      .run();

    await env.DB.prepare("DELETE FROM members WHERE id = 'm1'").run();

    for (const table of ["identities", "subscriptions", "subscription_events", "subscription_transfers", "devices", "sessions", "push_pairings", "synced_hosts"]) {
      expect(await count(table), table).toBe(0);
    }
    expect(await count("members")).toBe(1);
  });
});

describe("subscription_events:通知 UUID 冪等", () => {
  it("同一個通知 UUID 不能記兩次", async () => {
    await member("m1");
    await subscription("m1", "orig-1", "active");
    const insert = (id: string, uuid: string | null) =>
      env.DB.prepare(
        "INSERT INTO subscription_events (id, subscription_id, source, type, notification_uuid, received_at) VALUES (?, 'sub-m1-orig-1', 'store_notification', 'DID_RENEW', ?, ?)",
      )
        .bind(id, uuid, NOW)
        .run();
    await insert("e1", "uuid-1");
    await expect(insert("e2", "uuid-1")).rejects.toThrow(/UNIQUE/i);
    // 沒有通知 UUID 的事件(client、store_api)可以有很多筆。
    await insert("e3", null);
    await insert("e4", null);
    expect(await count("subscription_events")).toBe(3);
  });
});
