-- 方案用量通知(purrdr.server#42、purrdr.ios#704):
-- push_kinds 新增 usage_alert(預設開)。清單每列只有一組 transports 與最低版本,所以用最寬鬆的 https＋ssh:
-- Claude 的 ssh 需要主機外掛 0.3.0、https 需要主機服務 0.16.0;Codex 只有 https(寫在說明文字)。
-- usage_alert_events:用量通知的去重紀錄,鍵為 (會員, agent, 週期重置時間, 門檻),每個週期每個門檻只送一次;
--   以會員為單位(同一會員多組配對只送一次),APNs 沒收下時釋放登記。resets_at 是 Unix 秒。既有配對的 kinds 不動。

INSERT INTO push_kinds (code, name_en, name_zh, description_en, description_zh, default_on, transports, min_service_version, min_plugin_version, sort_order) VALUES
  ('usage_alert', 'Plan usage running low', '方案用量快用完', 'Your Claude or Codex plan usage reached 80% or 95% (Codex works over HTTPS only).', 'Claude 或 Codex 方案用量達 80% 或 95%(Codex 只支援 HTTPS 連線)。', 1, '["https","ssh"]', '0.16.0', '0.3.0', 70);

CREATE TABLE usage_alert_events (
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  agent TEXT NOT NULL,
  resets_at INTEGER NOT NULL,
  threshold INTEGER NOT NULL,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (member_id, agent, resets_at, threshold)
);
