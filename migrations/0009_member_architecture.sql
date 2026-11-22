-- 會員架構重做(purrdr.server#22,規格 raychiutw/purrdr.ios#402「後台資料結構(正規化)」)。
--
-- 一個會員、多種登入方式、一會員一個有效訂閱、每支裝置一個工作階段。這個 migration 同時做兩件事:
--   1. 建出新的資料表(identities、subscriptions、subscription_events、subscription_transfers、devices、sessions、push_pairings)。
--      members 沿用、只加 deleted_at;synced_hosts 本來就符合規格(內容欄位 + modified_at 當版本 + deleted_at),原封不動。
--   2. 一次性遷移舊資料:已驗證 email 相同的會員合併(登入方式都保留);兩邊都有有效訂閱時保留到期較晚者,另一筆標
--      pending_review = 1(待處理,帳號頁提示);舊的更新權杖全部作廢(使用者重新登入一次)。
--
-- 「已驗證」的判定(舊資料沒有 email_verified):Apple 非私密轉寄與 Google 的 email 視為已驗證;Apple 私密轉寄
-- (@privaterelay.appleid.com)不參與合併。新登入之後一律記下 token 裡真正的 email_verified。
--
-- 冪等與回滾:wrangler 以 d1_migrations 記錄套用過的 migration,同一個 migration 只會跑一次,重複執行 `migrations apply`
-- 不會再動資料。這個 migration 不能整段重跑(舊資料表已改名、搬完就刪),回滾靠 D1 Time Travel,見 README「0009 遷移」。
--
-- 時間一律 Unix epoch 毫秒。新增的會員資料表一律 REFERENCES members(id) ON DELETE CASCADE。

-- ───── 1. 暫存舊資料 ─────

-- 主機服務事件參照 push_pairings(key_hash);先收起來、刪掉,新 push_pairings 建好後再放回去。
CREATE TABLE _mig_events AS SELECT * FROM host_service_push_events;
DROP TABLE host_service_push_events;

ALTER TABLE identities RENAME TO legacy_identities;
ALTER TABLE entitlements RENAME TO legacy_entitlements;
ALTER TABLE push_pairings RENAME TO legacy_push_pairings;
ALTER TABLE push_devices RENAME TO legacy_push_devices;
-- 舊的更新權杖不搬(全部作廢),直接丟掉。
DROP TABLE refresh_tokens;
-- 舊索引跟著改名後的資料表,但名稱會跟新索引衝突,先刪。
DROP INDEX entitlements_member;
DROP INDEX push_pairings_member;
DROP INDEX push_pairings_member_device;

ALTER TABLE members ADD COLUMN deleted_at INTEGER;

-- ───── 2. 新資料結構 ─────

CREATE TABLE identities (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('apple', 'google')),
  subject TEXT NOT NULL,
  -- ID token 的 email;Apple 可能是 private relay,也可能沒有。
  email TEXT,
  -- token 的 email_verified。自動合併只看已驗證且不是私密轉寄的 email。
  email_verified INTEGER NOT NULL DEFAULT 0 CHECK (email_verified IN (0, 1)),
  is_private_relay INTEGER NOT NULL DEFAULT 0 CHECK (is_private_relay IN (0, 1)),
  -- Sign in with Apple 以 authorization code 換來的 refresh token(加密),刪除會員時用來撤銷(Apple 規定)。
  apple_refresh_token TEXT,
  linked_at INTEGER NOT NULL,
  -- 同一提供者同一 subject 只能屬於一個會員。
  UNIQUE (provider, subject)
);

-- 訂閱:一列是一個商店端的訂閱(App Store 的 original transaction ID、Google Play 的 purchase token)。
-- 規格之外多的欄位(current_transaction_id、purchased_at、revoked_at、*_signed_at、grace_expires_at)是 App Store
-- 的簽章時間與寬限期,晚到的舊通知靠簽章時間判斷新舊。
CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  store TEXT NOT NULL CHECK (store IN ('app_store', 'google_play')),
  external_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'grace', 'billing_retry', 'expired', 'revoked', 'refunded')),
  expires_at INTEGER NOT NULL,
  -- NULL = 還沒收過續訂資訊。
  auto_renew INTEGER CHECK (auto_renew IN (0, 1)),
  environment TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')),
  updated_at INTEGER NOT NULL,
  current_transaction_id TEXT,
  purchased_at INTEGER,
  revoked_at INTEGER,
  transaction_signed_at INTEGER,
  grace_expires_at INTEGER,
  renewal_signed_at INTEGER,
  -- 遷移合併時兩邊都有有效訂閱,到期較早的那筆標 1:保留它的真實狀態,但不佔「每個會員一個有效訂閱」的名額。
  pending_review INTEGER NOT NULL DEFAULT 0 CHECK (pending_review IN (0, 1)),
  -- 同一個商店識別只能屬於一個會員。
  UNIQUE (store, external_id)
);

-- 每個會員最多一個有效(active、grace、billing_retry)且未待處理的訂閱。
CREATE UNIQUE INDEX subscriptions_one_live_per_member ON subscriptions (member_id)
  WHERE status IN ('active', 'grace', 'billing_retry') AND pending_review = 0;
CREATE INDEX subscriptions_member ON subscriptions (member_id);

-- 訂閱事件:稽核與冪等。通知 UUID 唯一(沒有通知 UUID 的事件可以多筆)。
CREATE TABLE subscription_events (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('store_notification', 'store_api', 'client')),
  type TEXT NOT NULL,
  notification_uuid TEXT UNIQUE,
  received_at INTEGER NOT NULL
);
CREATE INDEX subscription_events_subscription ON subscription_events (subscription_id);

CREATE TABLE subscription_transfers (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  from_member TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  to_member TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  transferred_at INTEGER NOT NULL
);

-- 裝置:一支實體裝置一列(id 是 app 產生、存在 Keychain 的 device_id)。member_id 是目前登入的會員(可空)。
-- 推播權杖在這裡(同一支裝置的所有配對共用)。
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  member_id TEXT REFERENCES members(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  -- NULL = 未命名裝置。
  name TEXT,
  -- iPhone／iPad;NULL = 不知道。
  model TEXT,
  push_token TEXT,
  -- APNs 環境:App Store／TestFlight 是 production,Xcode 直接安裝的 Debug build 是 sandbox。
  push_environment TEXT CHECK (push_environment IN ('production', 'sandbox')),
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX devices_member ON devices (member_id);

-- 工作階段:每支裝置一個。更新權杖只存 SHA-256 雜湊;previous_*、rotated_at、grace_until 給輪替寬限用(purrdr.server#23)。
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  refresh_token_hash TEXT NOT NULL UNIQUE,
  previous_refresh_token_hash TEXT,
  rotated_at INTEGER,
  grace_until INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
-- 每個裝置最多一個未撤銷的工作階段。
CREATE UNIQUE INDEX sessions_one_live_per_device ON sessions (device_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_member ON sessions (member_id);

-- 推播配對:一台主機與一支裝置之間的推播授權,以配對密鑰雜湊識別(ADR-0004)。
-- 推播權杖與環境移到 devices;muted 是靜音清單(JSON 陣列,預設空)。
CREATE TABLE push_pairings (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  -- 配對密鑰 32 bytes 的 SHA-256(小寫 hex)。
  key_hash TEXT NOT NULL UNIQUE,
  -- 每組配對要收哪些種類,JSON 字串陣列。
  kinds TEXT NOT NULL DEFAULT '["blocked"]',
  muted TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- 每組密鑰的速率限制(固定視窗)。
  rate_window_started_at INTEGER NOT NULL DEFAULT 0,
  rate_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX push_pairings_member ON push_pairings (member_id);
CREATE INDEX push_pairings_device ON push_pairings (device_id);

-- 主機服務事件推播的去重紀錄(與 0008 相同,只是參照新的 push_pairings)。
CREATE TABLE host_service_push_events (
  key_hash TEXT NOT NULL REFERENCES push_pairings(key_hash) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  version TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (key_hash, event, version)
);

-- ───── 3. 決定哪些會員合併 ─────

-- 遷移當下的時間(推算訂閱狀態用,整支腳本同一個值)。
CREATE TABLE _mig_now AS SELECT CAST(strftime('%s', 'now') AS INTEGER) * 1000 AS t;

-- 可以拿來自動合併的 email:Google 的,或 Apple 但不是私密轉寄的。
CREATE TABLE _mig_key AS
SELECT member_id, lower(trim(email)) AS key
FROM legacy_identities
WHERE email IS NOT NULL AND trim(email) <> ''
  AND (provider = 'google' OR lower(email) NOT LIKE '%@privaterelay.appleid.com');

-- 以「共用同一個 email」連成群組,群組代表取最小的會員 ID;傳遞三輪(A~B、B~C 這種鏈也併成一群)。
CREATE TABLE _mig_map0 AS SELECT id AS member_id, id AS canon FROM members;
CREATE TABLE _mig_map1 AS
SELECT m.member_id, COALESCE((
  SELECT MIN(m2.canon) FROM _mig_key a JOIN _mig_key b ON b.key = a.key JOIN _mig_map0 m2 ON m2.member_id = b.member_id
  WHERE a.member_id = m.member_id), m.canon) AS canon
FROM _mig_map0 m;
CREATE TABLE _mig_map2 AS
SELECT m.member_id, COALESCE((
  SELECT MIN(m2.canon) FROM _mig_key a JOIN _mig_key b ON b.key = a.key JOIN _mig_map1 m2 ON m2.member_id = b.member_id
  WHERE a.member_id = m.member_id), m.canon) AS canon
FROM _mig_map1 m;
CREATE TABLE _mig_map3 AS
SELECT m.member_id, COALESCE((
  SELECT MIN(m2.canon) FROM _mig_key a JOIN _mig_key b ON b.key = a.key JOIN _mig_map2 m2 ON m2.member_id = b.member_id
  WHERE a.member_id = m.member_id), m.canon) AS canon
FROM _mig_map2 m;

-- 每群留下哪個會員:有有效訂閱者優先,其次最早建立,再來 ID 小的。
CREATE TABLE _mig_to AS
SELECT member_id, FIRST_VALUE(member_id) OVER (PARTITION BY canon ORDER BY has_live DESC, created_at, member_id) AS survivor
FROM (
  SELECT g.member_id, g.canon, m.created_at,
    EXISTS (
      SELECT 1 FROM legacy_entitlements e, _mig_now n
      WHERE e.member_id = g.member_id AND e.revoked_at IS NULL
        AND (e.expires_at > n.t OR COALESCE(e.grace_period_expires_at, 0) > n.t)
    ) AS has_live
  FROM _mig_map3 g JOIN members m ON m.id = g.member_id
);

-- ───── 4. 搬資料 ─────

INSERT INTO identities (id, member_id, provider, subject, email, email_verified, is_private_relay, apple_refresh_token, linked_at)
SELECT lower(hex(randomblob(16))), t.survivor, i.provider, i.subject, i.email,
  CASE WHEN i.email IS NOT NULL AND trim(i.email) <> '' AND (i.provider = 'google' OR lower(i.email) NOT LIKE '%@privaterelay.appleid.com') THEN 1 ELSE 0 END,
  CASE WHEN i.provider = 'apple' AND lower(COALESCE(i.email, '')) LIKE '%@privaterelay.appleid.com' THEN 1 ELSE 0 END,
  i.apple_refresh_token, i.linked_at
FROM legacy_identities i JOIN _mig_to t ON t.member_id = i.member_id;

-- 訂閱:狀態依遷移當下推算;同一個合併後的會員有多個有效訂閱時,到期(含寬限)最晚者保留,其餘標待處理。
INSERT INTO subscriptions (id, member_id, store, external_id, product_id, status, expires_at, auto_renew, environment, updated_at,
  current_transaction_id, purchased_at, revoked_at, transaction_signed_at, grace_expires_at, renewal_signed_at, pending_review)
SELECT lower(hex(randomblob(16))), survivor, store, original_transaction_id, product_id, status, expires_at, will_auto_renew,
  CASE environment WHEN 'Sandbox' THEN 'sandbox' ELSE 'production' END, updated_at,
  transaction_id, purchased_at, revoked_at, transaction_signed_at, grace_period_expires_at, renewal_signed_at,
  CASE WHEN status IN ('active', 'grace') AND rn > 1 THEN 1 ELSE 0 END
FROM (
  SELECT s.*, ROW_NUMBER() OVER (
    PARTITION BY survivor, status IN ('active', 'grace')
    ORDER BY MAX(expires_at, COALESCE(grace_period_expires_at, 0)) DESC, original_transaction_id
  ) AS rn
  FROM (
    SELECT e.*, t.survivor,
      CASE
        WHEN e.revoked_at IS NOT NULL THEN 'revoked'
        WHEN e.expires_at > n.t THEN 'active'
        WHEN COALESCE(e.grace_period_expires_at, 0) > n.t THEN 'grace'
        ELSE 'expired'
      END AS status
    FROM legacy_entitlements e JOIN _mig_to t ON t.member_id = e.member_id, _mig_now n
  ) s
);

-- 裝置:每個 device_id(舊版沒有的以 device token 歸類)一列,取最新一組配對的權杖與環境;
-- 名稱與型號取該配對原會員存的。
INSERT INTO devices (id, member_id, platform, name, model, push_token, push_environment, created_at, last_seen_at)
SELECT eff, survivor, 'ios',
  (SELECT d.name FROM legacy_push_devices d WHERE d.device_id = r.eff AND d.member_id = r.member_id),
  (SELECT d.model FROM legacy_push_devices d WHERE d.device_id = r.eff AND d.member_id = r.member_id),
  device_token, environment, first_created_at, updated_at
FROM (
  SELECT p.*, COALESCE(p.device_id, 'token:' || p.device_token) AS eff, t.survivor,
    MIN(p.created_at) OVER (PARTITION BY COALESCE(p.device_id, 'token:' || p.device_token)) AS first_created_at,
    ROW_NUMBER() OVER (PARTITION BY COALESCE(p.device_id, 'token:' || p.device_token) ORDER BY p.updated_at DESC, p.key_hash) AS rn
  FROM legacy_push_pairings p JOIN _mig_to t ON t.member_id = p.member_id
) r
WHERE rn = 1;

-- 存了名稱、但配對都撤銷了的裝置(下次開通知沿用名稱)。
INSERT INTO devices (id, member_id, platform, name, model, push_token, push_environment, created_at, last_seen_at)
SELECT d.device_id, t.survivor, 'ios', d.name, d.model, NULL, NULL, n.t, n.t
FROM legacy_push_devices d JOIN _mig_to t ON t.member_id = d.member_id, _mig_now n
WHERE NOT EXISTS (SELECT 1 FROM devices x WHERE x.id = d.device_id)
  AND d.member_id = (SELECT MIN(y.member_id) FROM legacy_push_devices y WHERE y.device_id = d.device_id);

INSERT INTO push_pairings (id, member_id, device_id, key_hash, kinds, muted, created_at, updated_at, rate_window_started_at, rate_count)
SELECT lower(hex(randomblob(16))), t.survivor, COALESCE(p.device_id, 'token:' || p.device_token), p.key_hash, p.kinds, '[]',
  p.created_at, p.updated_at, p.rate_window_started_at, p.rate_count
FROM legacy_push_pairings p JOIN _mig_to t ON t.member_id = p.member_id;

INSERT INTO host_service_push_events (key_hash, member_id, event, version, sent_at)
SELECT e.key_hash, t.survivor, e.event, e.version, e.sent_at
FROM _mig_events e JOIN _mig_to t ON t.member_id = e.member_id
WHERE EXISTS (SELECT 1 FROM push_pairings p WHERE p.key_hash = e.key_hash);

UPDATE revoked_push_pairings SET member_id = (SELECT survivor FROM _mig_to WHERE member_id = revoked_push_pairings.member_id);

-- 主機同步:合併後同一個 host_id 取最後修改者(modified_at 相同取會員 ID 小的),其餘主機全部保留。
CREATE TABLE _mig_host_losers AS
SELECT h.member_id, h.host_id
FROM synced_hosts h JOIN _mig_to ht ON ht.member_id = h.member_id
WHERE EXISTS (
  SELECT 1 FROM synced_hosts o JOIN _mig_to ot ON ot.member_id = o.member_id
  WHERE o.host_id = h.host_id AND ot.survivor = ht.survivor AND o.member_id <> h.member_id
    AND (o.modified_at > h.modified_at OR (o.modified_at = h.modified_at AND o.member_id < h.member_id))
);
DELETE FROM synced_hosts WHERE EXISTS (
  SELECT 1 FROM _mig_host_losers l WHERE l.member_id = synced_hosts.member_id AND l.host_id = synced_hosts.host_id
);
UPDATE synced_hosts SET member_id = (SELECT survivor FROM _mig_to WHERE member_id = synced_hosts.member_id)
WHERE member_id <> (SELECT survivor FROM _mig_to WHERE member_id = synced_hosts.member_id);

-- ───── 5. 收尾 ─────

DROP TABLE legacy_identities;
DROP TABLE legacy_entitlements;
DROP TABLE legacy_push_pairings;
DROP TABLE legacy_push_devices;

-- 被合併掉的會員(它的一切都已搬走)。
DELETE FROM members WHERE id IN (SELECT member_id FROM _mig_to WHERE member_id <> survivor);

DROP TABLE _mig_events;
DROP TABLE _mig_now;
DROP TABLE _mig_key;
DROP TABLE _mig_map0;
DROP TABLE _mig_map1;
DROP TABLE _mig_map2;
DROP TABLE _mig_map3;
DROP TABLE _mig_to;
DROP TABLE _mig_host_losers;

CREATE INDEX identities_member ON identities (member_id);
