-- 主機同步支援 HTTPS 主機(#63、ADR-0010):多一種連線方式 https 與它的主機服務位址。
-- 裝置權杖永不上傳，所以這裡沒有權杖欄位。SQLite 不能改 CHECK,所以重建資料表(沒有別的資料表參照它)。

CREATE TABLE synced_hosts_new (
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  host_id TEXT NOT NULL,
  name TEXT,
  address TEXT,
  port INTEGER,
  username TEXT,
  connection_method TEXT CHECK (connection_method IN ('tailscale_ssh', 'openssh', 'https')),
  host_key_fingerprint TEXT,
  -- HTTPS 主機的主機服務位址(例如 https://studio.tail1234.ts.net);SSH 主機是 NULL。
  host_service_address TEXT,
  modified_at INTEGER NOT NULL,
  deleted_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (member_id, host_id)
);

INSERT INTO synced_hosts_new (member_id, host_id, name, address, port, username, connection_method, host_key_fingerprint,
  modified_at, deleted_at, updated_at)
SELECT member_id, host_id, name, address, port, username, connection_method, host_key_fingerprint,
  modified_at, deleted_at, updated_at
FROM synced_hosts;

DROP TABLE synced_hosts;

ALTER TABLE synced_hosts_new RENAME TO synced_hosts;
