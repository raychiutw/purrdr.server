-- 主機在線狀態(purrdr.server#43、ADR-0017):主機離線與主機已恢復兩種通知。
--
-- host_presence:每組推播配對(配對密鑰雜湊)一列,只存「最後一次心跳時間」與「目前狀態」,沒有歷史、沒有時間序列。
--   後台目前沒有「主機」識別,一組配對密鑰就是主機服務回報的單位,所以以 key_hash 為主鍵。
--   不存 IP、位址或任何連線資訊。沒有配對開著這兩種通知時不會有資料(心跳回 needed:false 且不寫入)。
--   state:online 在線、sleeping 睡眠中(不判離線)、offline 已判定離線(排程已送過一次離線通知,等 online 心跳再送恢復)。
--   last_seen_at:Unix epoch 毫秒。
--   配對被刪除或會員被刪除時一併清掉(REFERENCES ... ON DELETE CASCADE)。
-- push_kinds 加兩種通知:預設關、只有 https(SSH 主機沒有常駐程序)、需主機服務 0.16.0。

CREATE TABLE host_presence (
  key_hash TEXT PRIMARY KEY REFERENCES push_pairings(key_hash) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('online', 'sleeping', 'offline')),
  last_seen_at INTEGER NOT NULL
);

CREATE INDEX host_presence_state_seen ON host_presence (state, last_seen_at);

INSERT INTO push_kinds (code, name_en, name_zh, description_en, description_zh, default_on, transports, min_service_version, sort_order) VALUES
  ('host_offline', 'Host offline', '主機離線', 'Your computer stopped reporting for 15 minutes (not counting sleep).', '電腦連續 15 分鐘沒有回報(睡眠不算)。', 0, '["https"]', '0.16.0', 70),
  ('host_recovered', 'Host back online', '主機已恢復', 'Your computer is back online after being offline.', '電腦離線後恢復連線。', 0, '["https"]', '0.16.0', 80);
