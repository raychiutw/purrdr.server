-- 推播配對(#29、ADR-0004):一台主機與一支裝置之間的推播授權，以配對密鑰識別。
-- app 產生 32 bytes 的配對密鑰，只把它的 SHA-256 雜湊交給後台;密鑰本身只在 app 與主機上。
-- 主機外掛送推播時帶密鑰，後台算雜湊找到這一列，確認會員有有效訂閱後轉給 APNs。
-- 時間都是 Unix epoch 毫秒。

CREATE TABLE push_pairings (
  -- 配對密鑰 32 bytes 的 SHA-256(小寫 hex)。
  key_hash TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  -- 目前只有 APNs;Android 之後加 fcm。
  platform TEXT NOT NULL CHECK (platform IN ('apns')),
  device_token TEXT NOT NULL,
  -- APNs 環境：App Store／TestFlight 是 production,Xcode 直接安裝的 Debug build 是 sandbox。
  environment TEXT NOT NULL CHECK (environment IN ('production', 'sandbox')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- 每組密鑰的速率限制(固定視窗)。
  rate_window_started_at INTEGER NOT NULL DEFAULT 0,
  rate_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX push_pairings_member ON push_pairings (member_id);
