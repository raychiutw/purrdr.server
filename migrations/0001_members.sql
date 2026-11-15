-- 會員與登入身分(#27)。
-- 時間一律存 Unix epoch 毫秒。D1 預設開啟 foreign key,刪除會員時以 ON DELETE CASCADE 清掉它的一切。
-- 之後的票新增「屬於會員」的資料表時，一律 REFERENCES members(id) ON DELETE CASCADE,刪除會員才不會漏。

CREATE TABLE members (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

-- 一個會員最多每種登入方式各一個(Apple、Google);同一個登入身分只屬於一個會員。
CREATE TABLE identities (
  provider TEXT NOT NULL CHECK (provider IN ('apple', 'google')),
  subject TEXT NOT NULL,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  -- ID token 的 email,只用來在 app 顯示「用哪個帳號登入」;Apple 可能是 private relay。
  email TEXT,
  -- Sign in with Apple 以 authorization code 換來的 refresh token,刪除會員時用來撤銷(Apple 規定)。
  apple_refresh_token TEXT,
  linked_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject),
  UNIQUE (member_id, provider)
);

-- 更新權杖只存 SHA-256 雜湊;每次使用就輪替。
CREATE TABLE refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX refresh_tokens_member ON refresh_tokens (member_id);
