# Purrdr 後台

Cloudflare Worker + D1(ADR-0004、ADR-0007、ADR-0009)。負責會員登入、訂閱權限、推播轉送與主機同步;聊天與終端機不經過這裡。目前有會員(#27)、訂閱權限(#28)與推播轉送(#29);主機同步(#30)之後加。

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
- 對外請求(Apple／Google 的 JWKS、Apple 的 token 與 revoke 端點、APNs)由 `test/fakes.ts` 換掉 global `fetch` 接手;沒預期的對外請求直接丟錯。假 Apple token 端點會驗證後台簽的 client secret(kid、iss、sub、aud、ES256 簽章);假 APNs 端點(`api.push.apple.com`、`api.sandbox.push.apple.com` 的 `/3/device/<token>`)驗證 provider token、記錄 header 與 payload,回應可由測試指定(`apnsReplies`)。
- **App Store 簽章用自建憑證鏈**:`vitest.config.ts` 每次產生一張測試根憑證(P-384,取代 Apple Root CA - G3),以 `APPLE_ROOT_CERTIFICATES` 交給後台信任;`test/app-store.ts` 用它簽中繼(帶 Apple WWDR OID)與葉憑證(帶 App Store 收據簽章 OID),再簽交易、續訂資訊與通知。`test/certificates.ts` 是只用 WebCrypto 的 X.509 產生器，可以做出各種壞掉的鏈(不受信任的根、少 OID、過期、簽發者不符)。後台程式不知道是測試，換成 Apple 的根憑證就是正式驗證。
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
| `GET /v1/members/me/subscription` | 存取權杖 | 回 `{ subscription }`;從沒訂閱過是 `null` |
| `POST /v1/members/me/subscription/app-store` | 存取權杖 | 提交 StoreKit 2 交易。body `{ signedTransaction }`(`VerificationResult.jwsRepresentation`)。回 `{ subscription }` |
| `POST /v1/members/me/push-pairings` | 存取權杖 | 註冊推播配對(需要有效訂閱)。body `{ keyHash, platform: "apns", deviceToken, environment: "production"\|"sandbox" }`;同一個 `keyHash` 再送一次是更新(APNs token 輪替)。回 201 |
| `DELETE /v1/members/me/push-pairings/{keyHash}` | 存取權杖 | 撤銷推播配對(只刪自己的、不存在也算成功、不需要訂閱)。回 204 |
| `POST /v1/push` | 配對密鑰 | 主機外掛送「需要你」。body 只能有 `{ key, workspace, status: "blocked", pane? }`,多一個欄位就 400。回 200 `{ delivered: true }` |
| `POST /v1/app-store/notifications` | — | App Store Server Notifications v2 的 webhook。body `{ signedPayload }`,處理完回 200 `{ received: true }` |

`member` 的形狀:`{ id, identities: [{ provider, email, linkedAt }] }`(email 可能是 Apple private relay,也可能是 `null`)。

`subscription` 的形狀:`{ status, store, productId, expiresAt, gracePeriodExpiresAt, willAutoRenew }`。`status` 是 `active`、`in_grace_period`(扣款失敗、Apple 重試中，仍有權限)、`expired`、`revoked`(退款或撤銷);`store` 是 `app_store`／`google_play`;`willAutoRenew` 在還沒收過續訂資訊時是 `null`。會員有多個訂閱時回有效的那個，其次是最晚到期的。

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
| 400 | `invalid_transaction` | 交易簽章驗不過，或不是這個 app、不是 Purrdr Plus、環境不是 Production／Sandbox(StoreKit 設定檔的交易一律驗不過) |
| 400 | `invalid_notification` | App Store 通知簽章驗不過，或 bundle id、環境、app Apple ID 不對 |
| 403 | `subscription_required` | 需要有效的 Purrdr Plus(註冊推播配對、送推播、#30 主機同步) |
| 404 | `pairing_not_found` | 送推播的配對密鑰沒有註冊(或已撤銷) |
| 409 | `pairing_in_use` | 這個配對密鑰雜湊已屬於另一個會員 |
| 410 | `pairing_revoked` | APNs 說 device token 已失效(`Unregistered`、`BadDeviceToken`、`DeviceTokenNotForTopic`);配對已刪除 |
| 413 | `invalid_request` | 推播請求 body 超過 2 KB |
| 429 | `rate_limited` | 這組配對密鑰一分鐘內超過 10 則 |
| 502 | `apns_failed` | APNs 拒絕或連不上(配對保留) |
| 409 | `identity_in_use` | 要連結的身分屬於另一個有訂閱或同步資料的會員 |
| 409 | `subscription_in_use` | 這個 App Store 訂閱已屬於另一個會員 |
| 409 | `last_identity` | 解除最後一種登入方式 |
| 502 | `provider_unavailable` | 連不上 Apple／Google |
| 502 | `apple_revoke_failed` | 刪除會員時撤銷 Sign in with Apple 權杖失敗;資料沒有刪，請稍後重試 |

### 規則

- **nonce**:app 每次登入產生隨機 nonce,把原文送來。Sign in with Apple 交給 Apple 的是 nonce 的 SHA-256(小寫 hex),Google 是原文;後台依此比對 ID token 的 `nonce`。
- **權杖**:存取權杖是 HS256 JWT,15 分鐘;更新權杖 90 天、只存雜湊、用一次就輪替。
- **連結衝突**(ADR-0007):身分屬於另一個會員時，對方沒有 `entitlements` 也沒有 `synced_hosts` 就併入：身分移過來，對方會員(連同其餘身分、權杖)刪除;對方其餘的 Apple 身分先撤銷(盡力而為)。否則 409 `identity_in_use`。
- **解除 Apple**:同時撤銷該 Sign in with Apple 權杖(盡力而為)。
- **訂閱權限**(ADR-0007):app 購買時以 `appAccountToken` 帶入會員 ID;交易與通知都只信任 App Store 簽的 JWS:`x5c` 三張憑證、最上層與 `APPLE_ROOT_CERTIFICATES` 逐位元組相同、逐層簽章正確、中繼與葉帶 Apple 的 OID、在 `signedDate` 時都在有效期間、JWS 是 ES256 由葉憑證簽(與 App Store Server Library 相同，不做線上 OCSP)。另外檢查 bundle id、環境(Production 與 Sandbox 都收：App Review 與 TestFlight 是 Sandbox)、商品、正式環境通知的 app Apple ID。
- **訂閱歸屬**:一個 App Store 訂閱(original transaction)只屬於一個會員。已登記的只屬於原會員;`appAccountToken` 是另一個現有會員時不能被領走(409 `subscription_in_use`);沒有 `appAccountToken`(在 App Store 兌換 Offer Code)或原會員已刪除時，歸提交的會員。
- **通知**:不依通知類型個別處理，而是寫入通知裡的交易與續訂資訊：續訂帶新的到期時間、到期的時間已過、退款與撤銷帶 `revocationDate`、撤銷被取消時不帶。較晚購買的交易取代舊的;同一筆交易只接受簽章時間不早於現有的;續訂資訊也依簽章時間，晚到的舊通知不會蓋掉新狀態。沒登記且 `appAccountToken` 不是現有會員的訂閱略過(回 200)。
- **權限判定**:沒有 `revoked_at`,且到期時間或帳單寬限期還沒過。推播與主機同步用 `src/subscriptions.ts` 的 `hasActiveSubscription`／`requireActiveSubscription`(403 `subscription_required`)。
- **推播**(ADR-0004、#29):app 產生 32 bytes 配對密鑰(64 位小寫 hex),只把那 32 bytes 的 SHA-256(小寫 hex)交給後台;密鑰本身只在 app 與主機的 `~/.purrdr/push-<裝置>/pairing`。主機外掛送推播時帶密鑰，後台算雜湊找配對 → 每組密鑰每分鐘 10 則 → 會員要有有效訂閱 → 由後台自己組 APNs payload(標題 = workspace 名稱，內文 `loc-key` 「An agent needs you.」、`interruption-level: time-sensitive`、`category: AGENT_BLOCKED`(app 以它設定隱藏預覽時的通用文字)、根層 `pairing`(雜湊)、`pane`、`status`)。外掛不能決定推播內容，只能送 workspace 名稱、狀態與 pane id,所以對話內容不經過後台與 APNs。APNs provider token(ES256)每 50 分鐘重簽一次。推播配對不算「擋合併的資料」;刪除會員時一併刪除。
- **合併規則**:會員只要有 `entitlements` 列(不論是否過期)就不是空會員。
- **刪除會員**:先撤銷 Sign in with Apple 權杖(Apple 回 200 或 400 都算完成),成功才刪資料;刪除靠 foreign key 的 `ON DELETE CASCADE`。Apple 訂閱不會因此取消，由 app 提醒使用者自行取消。

## 資料表

見 `migrations/`。`members`、`identities`、`refresh_tokens` 是 #27 的;`entitlements`(訂閱權限)是 #28 的;`push_pairings`(推播配對，含每組密鑰的速率限制計數)是 #29 的;`synced_hosts` 是給合併規則用的最小骨架，欄位由 #30 決定(上線前可直接改寫 `0002`)。之後新增的會員資料表一律 `REFERENCES members(id) ON DELETE CASCADE`。

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
| Apple 根憑證 | `wrangler.jsonc` 的 `APPLE_ROOT_CERTIFICATES` | 從 https://www.apple.com/certificateauthority/ 下載 **Apple Root CA - G3**(`AppleRootCA-G3.cer`,DER),核對 SHA-256 指紋與 Apple 公布的相同後 `base64 -i AppleRootCA-G3.cer \| tr -d '\n'` 填入。不是 secret |
| App 的 Apple ID | `wrangler.jsonc` 的 `APP_STORE_APP_APPLE_ID` | App Store Connect → App 資訊 → Apple ID(數字) |
| Purrdr Plus 商品 | App Store Connect → 訂閱 | 訂閱群組「Purrdr Plus」,商品 `com.raychiu.purrdr.plus.monthly`(1 個月)、`com.raychiu.purrdr.plus.yearly`(1 年),兩者都有 2 週免費試用(新訂閱者)。價格、顯示名稱與說明要跟 `src/App/Purrdr.storekit` 的意思一致(設定檔的價格只是測試用)。ID 改了要同步 `src/subscriptions.ts` 的 `PLUS_PRODUCT_IDS` 與 app 的 `MemberSubscription.productIDs` |
| Offer Code | App Store Connect → 訂閱 → 優惠代碼 | 送朋友與活動用;不用自訂授權碼(審查規範 3.1.1) |
| App Store Server Notifications | App Store Connect → App 資訊 → App Store 伺服器通知 | Production 與 Sandbox 都填 `https://<後台網址>/v1/app-store/notifications`,版本選 **Version 2**;填好後可用 App Store Server API 的「Request a Test Notification」確認(回 TEST 通知) |
| APNs 驗證金鑰 Key ID | `wrangler.jsonc` 的 `APNS_KEY_ID` | Apple Developer → Keys,建立啟用 Apple Push Notifications service (APNs) 的金鑰(環境選 Sandbox & Production);Team ID 沿用 `APPLE_TEAM_ID` |
| APNs 私鑰 | secret `APNS_PRIVATE_KEY` | 上一步下載的 `.p8` 全文:`npx wrangler secret put APNS_PRIVATE_KEY < AuthKey_XXXX.p8` |
| App ID 開推播 | Apple Developer → Identifiers | `com.raychiu.purrdr` 勾選 Push Notifications 與 Time Sensitive Notifications(app 的 entitlement 已加 `aps-environment` 與 time-sensitive) |
| 主機外掛的公開 repo | GitHub | 把本 repo 的 `host-plugin/` 發佈成公開 repo `raychiutw/purrdr-host-plugin`(根目錄就是 `herdr-plugin.toml`),加 topic `herdr-plugin`;app 的 `PushConfiguration.pluginSource` 要一致。外掛的後台網址在配對檔裡，由 app 寫入 |
| 隱私權政策網址 | app 的 `src/PurrdrFeatures/PlusView.swift`(`PlusLinks.privacyPolicy`)、App Store Connect | 正式的隱私權政策頁(目前是 `REPLACE-ME.invalid`) |
| 使用條款 | App Store Connect 的 License Agreement | 目前用 Apple 標準 EULA(`PlusLinks.termsOfUse`);改用自訂條款時兩邊一起換 |
| Google client ID(app 端) | app 的 `src/App/Purrdr/BackendConfiguration.swift` | 同上面的 iOS OAuth client ID |

`APPLE_TEAM_ID`(`8Z6WVFJ574`)與 `APPLE_CLIENT_ID`(bundle id)已是真值。隱私權政策要寫明：後台保存登入身分的 subject 與 email(可能是 Apple 轉寄地址)、Sign in with Apple refresh token(只用於撤銷)、訂閱紀錄(App Store 的 original transaction ID、商品、購買與到期時間、退款或撤銷時間、自動續訂狀態)、推播配對(配對密鑰的雜湊、APNs device token 與環境);推播經過後台時只有 workspace 名稱、狀態與 pane id,後台不保存。

沒有使用 App Store Server API,所以不需要 In-App Purchase key(`.p8`):權限只靠 app 提交的簽章交易與 App Store Server Notifications。之後若要主動查狀態或補抓漏掉的通知(Get All Subscription Statuses、Get Notification History),再新增金鑰與 secret。
