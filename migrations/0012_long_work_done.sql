-- 「長時間工作完成」通知種類(purrdr.server#40、ADR-0016):Agent 工作超過 10 分鐘後完成時送出。
-- 門檻(600 秒)固定寫在後台程式,使用者不能調;預設關。
-- SSH 主機需要主機外掛 0.3.0(才會在「完成」事件帶 workSeconds),HTTPS 主機需要主機服務 0.16.0。

INSERT INTO push_kinds (code, name_en, name_zh, description_en, description_zh, default_on, transports, min_service_version, min_plugin_version, sort_order) VALUES
  ('long_work_done', 'Long task finished', '長時間工作完成', 'An agent finished a task that took more than 10 minutes.', 'Agent 花了超過 10 分鐘的工作完成了。', 0, '["https","ssh"]', '0.16.0', '0.3.0', 25);
