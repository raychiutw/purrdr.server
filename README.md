# Purrdr 後台

Cloudflare Worker + D1(ADR-0004、ADR-0007、ADR-0009)。負責會員登入、訂閱權限、推播轉送與主機同步;聊天與終端機不經過這裡。目前只有會員(#27),訂閱(#28)、推播(#29)、主機同步(#30)之後加。

## 指令

```bash
cd backend
npm ci
npm test            # Workers 本機測試環境(@cloudflare/vitest-plugin + 本機 D1),不連 Cloudflare、不連 Apple／Google
npm run typecheck   # tsc + 檢查 worker-configuration.d.ts 是否與 wrangler.jsonc 一致
npm run types       # 改了 wrangler.jsonc 之後重新產生 worker-configuration.d.ts
```

## 測試

- 測試對 Worker 送真正的 HTTP 請求(`exports.default.fetch`),看回應與 D1 狀態;D1 套用 `migrations/` 的正式 migration。
- **不用任何真金鑰**:`vitest.config.ts` 每次執行都重新產生測試金鑰(Apple／Google 簽 ID token 的 RSA 金鑰、取代 `.p8` 的 P-256 金鑰、存取權杖密鑰)。
- 對外請求(Apple／Google 的 JWKS、Apple 的 token 與 revoke 端點)由 `test/fakes.ts` 換掉 global `fetch` 接手;沒預期的對外請求直接丟錯。假 Apple token 端點會驗證後台簽的 client secret(kid、iss、sub、aud、ES256 簽章)。
- TDD 紅綠燈紀錄放在 repo 根目錄的 `.tdd-logs/`(不進 git)。

## API

全部 JSON(camelCase),時間是 ISO 8601。錯誤一律 `{ "error": { "code", "message" } }`,app 依 `code` 判斷。API 不綁平台(Android 之後共用)。

| 方法與路徑 | 權杖 | 說明 |
|---|---|---|
| `POST /v1/sessions` | — | 登入。body `{ provider: "apple"\|"google", idToken, nonce, authorizationCode? }`;Apple 必須帶 `authorizationCode`。回 `{ accessToken, accessTokenExpiresAt, refreshToken, memberCreated, member }` |
| `POST /v1/sessions/refresh` | — | body `{ refreshToken }`,換一組新權杖(舊的更新權杖立即失效)。回應同登入，但沒有 `memberCreated` |
| `POST /v1/sessions/revoke` | — | 登出。body `{ refreshToken }`,回 204 |
| `GET /v1/members/me` | 存取權杖 | 回 `{ member }` |
| `POST /v1/members/me/identities` | 存取權杖 | 連結另一種登入方式。body 同登入。回 `{ member, mergedMemberId }` |
| `DELETE /v1/members/me/identities/{apple\|google}` | 存取權杖 | 解除連結。回 `{ member }` |
| `DELETE /v1/members/me` | 存取權杖 | 刪除會員。回 204 |

`member` 的形狀:`{ id, identities: [{ provider, email, linkedAt }] }`(email 可能是 Apple private relay,也可能是 `null`)。

存取權杖放在 `Authorization: Bearer <accessToken>`。

### 錯誤碼

| HTTP | code | 何時 |
|---|---|---|
| 400 | `invalid_request` | body 不是 JSON、缺欄位、provider 不認得 |
| 401 | `invalid_id_token` | ID token 簽章、iss、aud、exp、nonce 不對，或 Apple 拒絕 authorization code |
| 401 | `invalid_access_token` | 沒帶、無效、過期，或會員已刪除 |
| 401 | `invalid_refresh_token` | 更新權杖無效、過期或已用過 → app 要請使用者重新登入 |
| 404 | `identity_not_linked` | 解除沒有連結的登入方式 |
| 409 | `provider_already_linked` | 連結時已經有同一種登入方式(每種最多一個) |
| 409 | `identity_in_use` | 要連結的身分屬於另一個有訂閱或同步資料的會員 |
| 409 | `last_identity` | 解除最後一種登入方式 |
| 502 | `provider_unavailable` | 連不上 Apple／Google |
| 502 | `apple_revoke_failed` | 刪除會員時撤銷 Sign in with Apple 權杖失敗;資料沒有刪，請稍後重試 |

### 規則

- **nonce**:app 每次登入產生隨機 nonce,把原文送來。Sign in with Apple 交給 Apple 的是 nonce 的 SHA-256(小寫 hex),Google 是原文;後台依此比對 ID token 的 `nonce`。
- **權杖**:存取權杖是 HS256 JWT,15 分鐘;更新權杖 90 天、只存雜湊、用一次就輪替。
- **連結衝突**(ADR-0007):身分屬於另一個會員時，對方沒有 `entitlements` 也沒有 `synced_hosts` 就併入：身分移過來，對方會員(連同其餘身分、權杖)刪除;對方其餘的 Apple 身分先撤銷(盡力而為)。否則 409 `identity_in_use`。
- **解除 Apple**:同時撤銷該 Sign in with Apple 權杖(盡力而為)。
- **刪除會員**:先撤銷 Sign in with Apple 權杖(Apple 回 200 或 400 都算完成),成功才刪資料;刪除靠 foreign key 的 `ON DELETE CASCADE`。Apple 訂閱不會因此取消，由 app 提醒使用者自行取消。

## 資料表

見 `migrations/`。`members`、`identities`、`refresh_tokens` 是 #27 的;`entitlements`、`synced_hosts` 是給合併規則用的最小骨架，欄位由 #28、#30 決定(上線前可直接改寫 `0002`)。之後新增的會員資料表一律 `REFERENCES members(id) ON DELETE CASCADE`。

## 上線前要填的東西

目前沒有真的 Cloudflare 帳號與金鑰，以下都是佔位符(`REPLACE_ME`),上線前由人工提供：

| 項目 | 放哪裡 | 怎麼取得 |
|---|---|---|
| D1 資料庫 ID | `wrangler.jsonc` 的 `database_id` | `npx wrangler d1 create purrdr`,再 `npx wrangler d1 migrations apply purrdr --remote` |
| Sign in with Apple Key ID | `wrangler.jsonc` 的 `APPLE_KEY_ID` | Apple Developer → Keys,建立啟用 Sign in with Apple 的金鑰(綁 `com.raychiu.purrdr`) |
| Sign in with Apple 私鑰 | secret `APPLE_PRIVATE_KEY` | 上一步下載的 `.p8` 全文:`npx wrangler secret put APPLE_PRIVATE_KEY < AuthKey_XXXX.p8` |
| 存取權杖密鑰 | secret `ACCESS_TOKEN_SECRET` | `openssl rand -base64 48 \| npx wrangler secret put ACCESS_TOKEN_SECRET`;更換會讓所有存取權杖失效(更新權杖不受影響) |
| Google OAuth client ID | `wrangler.jsonc` 的 `GOOGLE_CLIENT_IDS` | Google Cloud Console 建立 iOS 類型的 OAuth client(bundle id `com.raychiu.purrdr`);app 端也要填同一個 ID(見下) |
| App ID 開 Sign in with Apple | Apple Developer → Identifiers | `com.raychiu.purrdr` 勾選 Sign in with Apple(app 的 entitlement 已加) |
| 後台網址 | app 的 `src/App/Purrdr/BackendConfiguration.swift` | 部署後的 `https://purrdr-backend.<子網域>.workers.dev` |
| Google client ID(app 端) | app 的 `src/App/Purrdr/BackendConfiguration.swift` | 同上面的 iOS OAuth client ID |

`APPLE_TEAM_ID`(`8Z6WVFJ574`)與 `APPLE_CLIENT_ID`(bundle id)已是真值。隱私權政策要寫明：後台保存登入身分的 subject 與 email(可能是 Apple 轉寄地址)、Sign in with Apple refresh token(只用於撤銷)。
