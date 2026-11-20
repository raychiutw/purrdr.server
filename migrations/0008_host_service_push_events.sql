-- 主機服務事件推播的去重紀錄(purrdr.server#8、#11):同一組密鑰、同一個 event 與 version 24 小時內只送一次。
-- 只在 APNs 收下後保留;配對刪除或會員刪除時一併刪除。時間是 Unix epoch 毫秒。

CREATE TABLE host_service_push_events (
  key_hash TEXT NOT NULL REFERENCES push_pairings(key_hash) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  -- 沒帶版本時是空字串(讓主鍵能比對)。
  version TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (key_hash, event, version)
);
