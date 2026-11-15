-- 會員擁有的資料。連結登入方式時的合併規則(ADR-0007)要看「對方會員有沒有訂閱或同步資料」。
-- 後台還沒上線前，可以直接改寫這個 migration,不必另開 ALTER。

-- 訂閱權限(#28):權限記在會員身上，記錄來源商店。一列是一個訂閱(App Store 的 original transaction),
-- 只保留最新一筆交易的狀態;交易與續訂資訊各自依 Apple 簽章時間判斷新舊，晚到的舊通知不會蓋掉新狀態。
-- 時間都是 Unix epoch 毫秒(與 App Store 相同)。
CREATE TABLE entitlements (
  store TEXT NOT NULL CHECK (store IN ('app_store', 'google_play')),
  -- App Store:originalTransactionId。
  original_transaction_id TEXT NOT NULL,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  -- Production／Sandbox。
  environment TEXT NOT NULL,
  product_id TEXT NOT NULL,
  -- 目前採用的那筆交易。
  transaction_id TEXT NOT NULL,
  purchased_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  -- 退款或撤銷(Family Sharing 移除等)的時間;有值就沒有權限。
  revoked_at INTEGER,
  transaction_signed_at INTEGER NOT NULL,
  -- 續訂資訊(App Store Server Notifications 才有):是否自動續訂、帳單寬限期到期時間。
  will_auto_renew INTEGER,
  grace_period_expires_at INTEGER,
  renewal_signed_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (store, original_transaction_id)
);

CREATE INDEX entitlements_member ON entitlements (member_id);

-- 主機同步(#30、ADR-0007):會員各裝置共用的主機清單。一列是一台主機(id 由 app 產生的 UUID)。
-- 只存主機名稱、位址(含埠)、使用者名稱、連線方式、host key 指紋;私鑰、密碼、登入方式、herdr 設定都不上傳。
-- 以單一主機為單位最後修改者勝(比 modified_at,app 端修改的時間);刪除留紀錄(deleted_at,欄位清空),
-- 同一個 id 之後的上傳一律忽略，所以已刪除的主機不會被還沒同步到刪除的裝置傳回來。時間都是 Unix epoch 毫秒。
CREATE TABLE synced_hosts (
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  host_id TEXT NOT NULL,
  name TEXT,
  address TEXT,
  port INTEGER,
  username TEXT,
  connection_method TEXT CHECK (connection_method IN ('tailscale_ssh', 'openssh')),
  host_key_fingerprint TEXT,
  modified_at INTEGER NOT NULL,
  deleted_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (member_id, host_id)
);
