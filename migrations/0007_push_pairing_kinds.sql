-- 推播種類偏好(purrdr.server#8、#10):每組配對要收哪些種類，JSON 字串陣列，值為 blocked、done、host_service。
-- 舊列與沒帶 kinds 的註冊只收「需要你」,舊版 app 行為不變。

ALTER TABLE push_pairings ADD COLUMN kinds TEXT NOT NULL DEFAULT '["blocked"]';
