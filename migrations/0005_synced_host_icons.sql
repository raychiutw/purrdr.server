-- 主機圖示跟著主機同步(#243)。NULL = 沒有圖示資料(舊版 app 上傳的主機),app 用預設。
ALTER TABLE synced_hosts ADD COLUMN icon TEXT;
