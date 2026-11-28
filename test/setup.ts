import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach } from "vitest";
import { identityProviders } from "./fakes";

// 每個測試都從空的資料庫開始，並把對外連線換成假的 Apple／Google(不連網路)。
beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  identityProviders.install();
});

afterEach(async () => {
  identityProviders.uninstall();
  // 依 foreign key 的相反順序清空(d1_migrations 保留，下一個測試不必重跑 migration)。
  for (const table of ["push_daily_usage", "host_presence", "subscription_events", "subscription_transfers", "subscriptions", "sessions", "identities", "synced_hosts", "host_service_push_events", "push_pairings", "devices", "revoked_push_pairings", "members"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  // push_kinds 是 migration 播種的種類清單,不清空;只還原測試可能改過的欄位與新增的列。
  await env.DB.batch([
    env.DB.prepare("DELETE FROM push_kinds WHERE code NOT IN ('blocked', 'done', 'stuck', 'reminder', 'host_service', 'daily_limit_reached', 'host_offline', 'host_recovered')"),
    env.DB.prepare(
      `UPDATE push_kinds SET disabled = 0, min_service_version = CASE WHEN code IN ('host_offline', 'host_recovered') THEN '0.16.0' ELSE NULL END,min_plugin_version = NULL,
         sort_order = CASE code WHEN 'blocked' THEN 10 WHEN 'done' THEN 20 WHEN 'stuck' THEN 30 WHEN 'reminder' THEN 40 WHEN 'host_service' THEN 50 WHEN 'daily_limit_reached' THEN 60 WHEN 'host_offline' THEN 70 ELSE 80 END`,
    ),
  ]);
});
