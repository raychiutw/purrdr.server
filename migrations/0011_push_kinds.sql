-- 通知種類清單與配對資料(purrdr.server#39、ADR-0016):
-- push_kinds:通知種類清單,註冊與修改配對時以它為準(不再寫死在程式裡)。之後新增種類只要 INSERT 一列,不必改程式。
--   code 種類代號;name_*／description_* 英文與繁中的名稱與說明;default_on 新配對預設開不開;
--   transports 適用的連線方式(JSON 陣列,https／ssh);min_service_version／min_plugin_version 需要的主機服務／主機外掛最低版本(NULL = 不限);
--   sort_order 顯示順序;disabled 停用(不出現在清單、不能再開,配對裡已存的值不會送)。
-- push_pairings 新增:host_name 電腦名稱、host_icon 系統圖示代號(SF Symbol)、host_icon_color 圖示顏色(皆可空;不存位址、IP 或任何連線資訊),
--   limit_notified_day 這組配對最後一次收到「今日已達上限」通知的 UTC 日期(每組配對各自登記,取代會員共用的 push_daily_usage.limit_notified)。
-- 既有配對補開 daily_limit_reached:以前「今日已達上限」通知不看偏好,每個配對都收得到,升級後行為不變。

CREATE TABLE push_kinds (
  code TEXT PRIMARY KEY,
  name_en TEXT NOT NULL,
  name_zh TEXT NOT NULL,
  description_en TEXT NOT NULL,
  description_zh TEXT NOT NULL,
  default_on INTEGER NOT NULL DEFAULT 0 CHECK (default_on IN (0, 1)),
  transports TEXT NOT NULL DEFAULT '["https","ssh"]',
  min_service_version TEXT,
  min_plugin_version TEXT,
  sort_order INTEGER NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1))
);

INSERT INTO push_kinds (code, name_en, name_zh, description_en, description_zh, default_on, transports, sort_order) VALUES
  ('blocked', 'Needs you', '需要你', 'An agent is waiting for your reply or approval.', 'Agent 在等你回覆或核准。', 1, '["https","ssh"]', 10),
  ('done', 'Finished', '完成', 'An agent finished its work.', 'Agent 完成了工作。', 0, '["https","ssh"]', 20),
  ('stuck', 'May be stuck', '可能卡住', 'An agent has not made progress for a while.', 'Agent 好一陣子沒有進展。', 0, '["https"]', 30),
  ('reminder', 'Still waiting for you', '仍在等你', 'An agent is still waiting after your last notice.', '上次通知後 Agent 仍在等你。', 0, '["https"]', 40),
  ('host_service', 'Host service updates', '主機服務更新', 'A host service update is available, installed or rolled back.', '主機服務有新版、已更新或已退回。', 0, '["https"]', 50),
  ('daily_limit_reached', 'Daily limit reached', '今日已達上限', 'You reached today''s notification limit.', '今天的通知則數已達上限。', 1, '["https","ssh"]', 60);

ALTER TABLE push_pairings ADD COLUMN host_name TEXT;
ALTER TABLE push_pairings ADD COLUMN host_icon TEXT;
ALTER TABLE push_pairings ADD COLUMN host_icon_color TEXT;
ALTER TABLE push_pairings ADD COLUMN limit_notified_day TEXT;

UPDATE push_pairings SET kinds = json_insert(kinds, '$[#]', 'daily_limit_reached') WHERE json_valid(kinds) AND kinds NOT LIKE '%daily_limit_reached%';
