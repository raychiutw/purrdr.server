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
  for (const table of ["refresh_tokens", "identities", "entitlements", "synced_hosts", "members"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});
