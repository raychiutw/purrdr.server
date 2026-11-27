-- 推播改每個會員每日上限(purrdr.server#36):不再需要 Purrdr Plus。
--
-- members.daily_push_limit:每個 UTC 日最多送幾則推播;NULL = 預設 100。營運者直接改這個欄位就能調整(例如 1000)。
-- push_daily_usage:每個會員每個 UTC 日一列。sent 只算真的送到 APNs 而且成功的推播(含測試通知;「今日已達上限」通知不算);
-- limit_notified 記今天是否已送過「今日已達上限」通知,同一天只送一次。
-- day 是 UTC 日期(YYYY-MM-DD);舊的日期不會再被讀到,留著不影響行為。
--
-- 新增的會員資料表一律 REFERENCES members(id) ON DELETE CASCADE。

ALTER TABLE members ADD COLUMN daily_push_limit INTEGER CHECK (daily_push_limit IS NULL OR daily_push_limit >= 0);

CREATE TABLE push_daily_usage (
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0,
  limit_notified INTEGER NOT NULL DEFAULT 0 CHECK (limit_notified IN (0, 1)),
  PRIMARY KEY (member_id, day)
);
