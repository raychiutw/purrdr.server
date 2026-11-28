-- 「佇列暫停」推播(purrdr.server#41、purrdr.ios#704):主機偵測到 Agent 佇列暫停時送 `status: "queue_paused"`。
-- push_kinds 加一列 queue_paused:預設開、只有 https、需主機服務 0.16.0。
-- queue_paused_events:去重紀錄,以 (配對, pane) 為鍵,5 分鐘內同一個 pane 不重送(主機端承諾同一次暫停只送一次,
--   這裡只擋重試與重複請求;恢復後再暫停通常相隔超過窗口,會再送)。只在 APNs 收下後保留;配對或會員刪除時一併刪除。時間是 Unix epoch 毫秒。
-- 沒有既有配對補開:這個種類要主機服務 0.16.0 才會送,由 app 在使用者的配對上開。

INSERT INTO push_kinds (code, name_en, name_zh, description_en, description_zh, default_on, transports, min_service_version, sort_order) VALUES
  ('queue_paused', 'Queue paused', '佇列暫停', 'An agent''s message queue was paused.', 'Agent 的訊息佇列暫停了。', 1, '["https"]', '0.16.0', 70);

CREATE TABLE queue_paused_events (
  key_hash TEXT NOT NULL REFERENCES push_pairings(key_hash) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  pane TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (key_hash, pane)
);
