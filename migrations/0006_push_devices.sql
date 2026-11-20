-- 通知裝置(purrdr.server#5):會員看得到哪些裝置會收到通知，可以遠端關閉整支裝置或改名。
-- 同一支裝置在多台主機各有一組配對，以 app 產生、存在 Keychain 的 device_id 歸成一台裝置。
-- 舊列 device_id 為 NULL(舊版 app 註冊的):以 device token 歸類，app 顯示為「未命名裝置」。

ALTER TABLE push_pairings ADD COLUMN device_id TEXT;

CREATE INDEX push_pairings_member_device ON push_pairings (member_id, device_id);

-- 裝置名稱與型號，一支裝置一列(改名只改這裡)。配對都撤銷後保留，下次開通知沿用名稱。
CREATE TABLE push_devices (
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  -- NULL = 未命名裝置。
  name TEXT,
  -- iPhone／iPad;NULL = 不知道。
  model TEXT,
  PRIMARY KEY (member_id, device_id)
);

-- 從清單遠端關閉的配對：主機外掛之後再送推播回 410 pairing_revoked(而非 404),外掛據此清掉本機配對目錄。
-- 同一組密鑰重新註冊時移除。
CREATE TABLE revoked_push_pairings (
  key_hash TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  revoked_at INTEGER NOT NULL
);
