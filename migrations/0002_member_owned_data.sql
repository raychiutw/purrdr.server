-- 連結登入方式時的合併規則(ADR-0007)要看「對方會員有沒有訂閱或同步資料」,所以先建這兩張表的最小骨架。
-- 欄位由 #28(訂閱權限)與 #30(主機同步)決定：後台還沒上線前，可以直接改寫這個 migration,不必另開 ALTER。

-- 訂閱權限(#28):權限記在會員身上，記錄來源商店。
CREATE TABLE entitlements (
  member_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  store TEXT NOT NULL CHECK (store IN ('app_store', 'google_play')),
  product_id TEXT NOT NULL,
  expires_at INTEGER,
  updated_at INTEGER NOT NULL
);

-- 主機同步(#30):以單一主機為單位、最後寫入者勝，刪除留紀錄(deleted_at)。
CREATE TABLE synced_hosts (
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  host_id TEXT NOT NULL,
  payload TEXT,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  PRIMARY KEY (member_id, host_id)
);
