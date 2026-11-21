# Purrdr 後台

Cloudflare Worker + D1(app repo [`raychiutw/purrdr.ios`](https://github.com/raychiutw/purrdr.ios) 的 ADR-0004、ADR-0007、ADR-0009)。從 app repo 的 `backend/` 抽出(保留歷史),私人 repo。負責會員登入、訂閱權限、推播轉送與主機同步;聊天與終端機不經過這裡。目前有會員(#27)、訂閱權限(#28)、推播轉送(#29)與主機同步(#30)。

## 指令

```bash
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
| `POST /v1/members/me/hosts/sync` | 存取權杖 | 主機同步(要有效的 Purrdr Plus)。body `{ changes: [...] }`,回 `{ hosts: [...], deletedHostIds: [...] }`,見下方「主機同步」 |
| `POST /v1/members/me/push-pairings` | 存取權杖 | 註冊推播配對(需要有效訂閱)。body `{ keyHash, platform: "apns", deviceToken, environment: "production"\|"sandbox", deviceId?, deviceName?, model?, kinds? }`;`kinds` 是要收的推播種類(`blocked`、`done`、`stuck`、`reminder`、`host_service` 的陣列),新配對沒帶時只收 `blocked`。同一個 `keyHash` 再送一次是更新(APNs token 輪替、改偏好;沒帶 `kinds` 保留原本的偏好)。裝置欄位見下方「通知裝置」。回 201 |
| `DELETE /v1/members/me/push-pairings/{keyHash}` | 存取權杖 | 撤銷推播配對(只刪自己的、不存在也算成功、不需要訂閱)。回 204 |
| `GET /v1/members/me/push-devices?currentDeviceId=` | 存取權杖 | 會收到通知的裝置(不需要訂閱：到期後仍要能看到並關閉遺失的裝置)。回 `{ devices: [{ deviceId, name, model, hostCount, lastRegisteredAt, current }] }`,見下方「通知裝置」 |
| `PATCH /v1/members/me/push-devices/{deviceId}?currentDeviceId=` | 存取權杖 | 裝置改名(需要有效訂閱)。body `{ name }`,回 `{ device }`;不是自己的或沒有配對回 404 `device_not_found` |
| `DELETE /v1/members/me/push-devices/{deviceId}` | 存取權杖 | 遠端關閉裝置：撤銷它在所有主機的配對(不需要訂閱)。回 204;不是自己的或沒有配對回 404 `device_not_found` |
| `POST /v1/push` | 配對密鑰 | 主機外掛送「需要你」或「完成」、主機服務送「可能卡住」或「仍在等你」:body 只能有 `{ key, workspace, status: "blocked"\|"done"\|"stuck"\|"reminder", pane? }`。主機服務送事件:body 只能有 `{ key, event: "host_service_update_available"\|"host_service_updated"\|"host_service_update_rolled_back", version? }`(`host_service_updated` 必須帶 `version`)。測試通知(#19,app 帳號頁「傳送測試通知」):body 只能有 `{ key, event: "test", host_name? }`(`host_name` 選填字串，最長 64 字元，控制字元與換行換成空白、頭尾修掉，剩下空的當成沒帶，不是字串或太長 400)。三種形狀互斥;多一個欄位、不認得的 `status`／`event`、`version` 不是語意化版本就 400。回 200 `{ delivered: true }`;種類不在配對的 `kinds` 內，或同一事件與版本 24 小時內送過時不轉 APNs,回 200 `{ delivered: false }`(測試通知不受 `kinds` 與去重影響) |
| `POST /v1/app-store/notifications` | — | App Store Server Notifications v2 的 webhook。body `{ signedPayload }`,處理完回 200 `{ received: true }` |

`member` 的形狀:`{ id, identities: [{ provider, email, linkedAt }] }`(email 可能是 Apple private relay,也可能是 `null`)。

`subscription` 的形狀:`{ status, store, productId, expiresAt, gracePeriodExpiresAt, willAutoRenew }`。`status` 是 `active`、`in_grace_period`(扣款失敗、Apple 重試中，仍有權限)、`expired`、`revoked`(退款或撤銷);`store` 是 `app_store`／`google_play`;`willAutoRenew` 在還沒收過續訂資訊時是 `null`。會員有多個訂閱時回有效的那個，其次是最晚到期的。

`changes` 的每一筆是修改(新增也是)`{ id, name, address, port, username, connectionMethod, hostKeyFingerprint, modifiedAt }`
或刪除 `{ id, deleted: true }`;回應的 `hosts` 每一筆是同樣的修改形狀，依 `id` 排序。`id` 是 app 產生的 UUID(後台一律回小寫);
`connectionMethod` 是 `tailscale_ssh`／`openssh`／`https`;`hostKeyFingerprint` 是 `SHA256:` 之後、不補等號的 base64(43 字)或 `null`(還沒確認);
`modifiedAt` 是這支裝置修改那台主機的時間。

**HTTPS 主機**(#63、#250):`address` 只能是主機服務的主機名稱或 IP(不含 scheme、埠、路徑),埠只在 `port`(預設 443,例如 8443);
app 以這兩個欄位組回主機服務位址(loopback 是本機測試、用 http,其他一律 https),沒有另外的位址欄位。`username` 是空字串、
`hostKeyFingerprint` 是 `null`;裝置權杖不在白名單。body 可帶 `connectionMethods: [...]`(這支 app 看得懂的連線方式);
**沒帶的 app 回應不含 HTTPS 主機**(不認得的連線方式會讓整個同步失敗),刪除紀錄照常給。

**主機圖示**(#243):修改可多帶 `icon`(app `HostIcon` 的存檔值，例如 `macMini`、`rack`,「無」是 `none`;後台只檢查是 1–32 個英數字、
不列舉名稱，較新版 app 加的圖示也收)。**沒帶 `icon` 的修改保留已存的圖示**;刪除時清掉。回應只有存過圖示的主機帶 `icon`;
app 遇到沒帶或不認得的值沿用本機圖示(沒有就用預設)。

首次部署(後台還沒上線過，也沒有舊資料):依「上線前要填的東西」填好設定後，先 `npx wrangler d1 migrations apply purrdr --remote`
(套用 `0001`～`0005`),再 `npx wrangler deploy`,最後把後台網址填進 app 的 `BackendConfiguration.swift` 發版。後台是手動部署，
不會跟著 app 發布上線。

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
| 403 | `subscription_required` | 需要有效的 Purrdr Plus(主機同步、註冊推播配對、送推播) |
| 404 | `pairing_not_found` | 送推播的配對密鑰沒有註冊(或已撤銷) |
| 409 | `pairing_in_use` | 這個配對密鑰雜湊已屬於另一個會員 |
| 410 | `pairing_revoked` | APNs 說 device token 已失效(`Unregistered`、`BadDeviceToken`、`DeviceTokenNotForTopic`);配對已刪除 |
| 413 | `invalid_request` | 推播請求 body 超過 2 KB |
| 429 | `rate_limited` | 同一個 IP(`CF-Connecting-IP`)60 秒內超過 60 次(帶 `Retry-After` 秒數;App Store 通知不限流),或推播的這組配對密鑰一分鐘內超過 10 則 |
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
- **推播**(ADR-0004、#29):app 產生 32 bytes 配對密鑰(64 位小寫 hex),只把那 32 bytes 的 SHA-256(小寫 hex)交給後台;密鑰本身只在 app 與主機的 `~/.purrdr/push-<裝置>/pairing`。主機外掛送推播時帶密鑰，後台算雜湊找配對 → 會員要有有效訂閱 → 種類要在配對的 `kinds` 偏好內(否則回 `{ delivered: false }`,不呼叫 APNs)→ 主機服務事件去重 → 每組密鑰每分鐘 10 則(只計真的要送 APNs 的，偏好或去重擋下的不計，避免擠掉「需要你」;速率限制、訂閱檢查與 410 對所有種類一致)→ 由後台自己組 APNs payload(標題 = workspace 名稱、根層 `pairing`(雜湊)、`pane`、`status`;`category` 讓 app 設定隱藏預覽時的通用文字):
  - `blocked`(需要你):`loc-key` 「An agent needs you.」、`interruption-level: time-sensitive`、`category: AGENT_BLOCKED`。
  - `done`(完成):`loc-key` 「An agent finished.」、`interruption-level: active`、`category: AGENT_DONE`。
  - `stuck`(可能卡住,purrdr.server#15):`loc-key` 「An agent may be stuck.」、`interruption-level: active`、`category: AGENT_STUCK`。
  - `reminder`(仍在等你,purrdr.server#15):`loc-key` 「An agent is still waiting for you.」、`interruption-level: time-sensitive`、`category: AGENT_REMINDER`。

    `stuck`、`reminder` 由主機服務偵測(raychiutw/purrdr.host#25),每個狀態期間只送一次;後台不另做去重，由速率限制保護。
  - 主機服務事件(purrdr.server#11,偏好 `host_service`):主機服務以同一份配對檔的密鑰送 `{ key, event, version? }`。標題 `title-loc-key` 「Host service」(不帶 workspace 或主機名稱)、`interruption-level: passive`、`category: HOST_SERVICE_EVENT`,根層 `pairing`、`event` 與 `version`(有帶才有),沒有 `pane`／`status`。內文 `loc-key`:
    - `host_service_update_available`:「A host service update is available.」
    - `host_service_updated`:「Host service updated to %@.」,`loc-args: [version]`(這個事件必須帶 `version`)
    - `host_service_update_rolled_back`:「Host service update failed and was rolled back.」

  - 測試通知(purrdr.server#19,不是配對的種類，沒有對應的 `kinds`):app 帳號頁按「傳送測試通知」，HTTPS 主機由主機服務的 `push.test` 代送，SSH 主機由 app 經 SSH 在主機上直接 POST,都送 `{ key, event: "test", host_name? }`(不收 `version`、`pane` 或其他欄位)。內容像「需要你」但說明是測試:有 `host_name` 時 `title-loc-key` 「Test: %@ needs you」、`title-loc-args: [host_name]`,沒有時 `title-loc-key` 「Test: Purrdr needs you」(無參數);內文 `loc-key` 「This is a test. When an agent needs your reply or finishes, you'll get a notice like this.」;`sound: default`、`interruption-level: active`(與真正的「需要你」一致),**沒有 `category`**,根層只有 `pairing` 與 `event: "test"`(沒有 `pane`／`status`),點擊只開 app。主機名稱只用在這則通知的標題，不存。不看配對的 `kinds`、不去重(使用者每次按都該收到);仍要有效訂閱(403 `subscription_required`),與狀態推播共用每組密鑰每分鐘 10 則(429 `rate_limited`);配對不存在 404 `pairing_not_found`、已遠端關閉或 APNs 回 410 回 410 `pairing_revoked`、APNs 其他錯誤 502 `apns_failed`。

    `version` 是語意化版本(`1.2.3`,可帶 `-prerelease`、`+build`,不帶 `v`),最長 64 字。同一組密鑰、同一個 `event` 與 `version` 24 小時內只送一次(`host_service_push_events`,APNs 收下後才算送過;重複的回 200 `{ delivered: false }`);`done`、`stuck`、`reminder` 不去重，由速率限制保護。

  外掛與主機服務不能決定推播內容，只能送 workspace 名稱、狀態、pane id、事件種類與版本號，所以對話內容不經過後台與 APNs。APNs provider token(ES256)每 50 分鐘重簽一次。推播配對不算「擋合併的資料」;刪除會員時一併刪除。
- **通知裝置**(purrdr.server#5):一組配對 = 一支裝置 × 一台主機;註冊配對時帶 `deviceId`(app 產生、存在 Keychain 的 UUID,大小寫不拘、後台存小寫)、`deviceName`(去頭尾空白後 1～64 字，不能含控制字元、格式字元(零寬、bidi 覆寫)與行／段落分隔;改名同規則)、`model`(`iPhone`／`iPad`),同一個 `deviceId` 的配對歸成一台裝置。名稱已存在時註冊不覆蓋(使用者改的名稱以 PATCH 為準)。
  - 清單：`hostCount` = 配對數(開了幾台主機)、`lastRegisteredAt` = 最後註冊或更新配對的時間(epoch 毫秒)、`current` = 是否等於 `currentDeviceId`;不回 device token、配對密鑰與雜湊。只列至少有一組配對的裝置，最新的在前。
  - 舊版 app 沒帶 `deviceId` 的配對以 device token 歸類，`deviceId` 是 `legacy-` 加 token 的 SHA-256 前 32 位 hex,`name`／`model` 為 `null`(app 顯示「未命名裝置」);可用這個 id 撤銷或改名;改名後這個 id 會記到配對上，同一支裝置之後再用舊版 app 新增的配對仍歸成同一台。
  - 遠端關閉：刪除配對並記入 `revoked_push_pairings`,主機外掛之後用那組密鑰送推播回 410 `pairing_revoked`(外掛據此清掉本機的 `push-<裝置>` 目錄);同一組密鑰重新註冊就恢復。410 只回一次(回完刪掉紀錄，之後是 404),每次遠端關閉時順手刪掉 90 天前的紀錄。以密鑰撤銷(`DELETE .../push-pairings/{keyHash}`,裝置自己關)則照舊回 404。
- **合併規則**:會員只要有 `entitlements` 列(不論是否過期)或 `synced_hosts` 列(含刪除紀錄)就不是空會員。
- **主機同步**(#30、ADR-0007):
  - 要有效的 Purrdr Plus,讀取也是;到期後資料保留(續訂後接著用),刪除會員時一起刪。
  - 以單一主機為單位**最後修改者勝**:比 `modifiedAt`,比已存的新才取代，一樣新時保留已存的;回應永遠是套用後的整份清單，app 以它為準。
    `modifiedAt` 晚於後台收到的時間(裝置時鐘跑到未來)時以後台時間為準，避免那支裝置永遠贏。
  - **刪除留紀錄**:欄位清空，只留 id 與刪除時間，列在 `deletedHostIds`;之後同一個 id 的上傳一律忽略(即使修改時間較晚),還沒同步到刪除的裝置傳不回來。
  - **只收白名單欄位**:修改與刪除各自的欄位以外，多一個欄位(例如 `password`、`privateKey`、`authentication`、`deviceToken`)整個請求 400 `invalid_request`、什麼都不存。
    私鑰、密碼、passphrase、裝置權杖、登入方式、herdr 路徑與 session、作業系統都不上傳。一次最多 200 筆;任何一筆不合法，整個請求不動資料。
- **限流**(#2):所有 API 依 `CF-Connecting-IP` 每 60 秒最多 60 次(Workers Rate Limiting binding `IP_RATE_LIMITER`,`wrangler.jsonc` 的 `ratelimits`;計數是每個 Cloudflare 據點各自算、近似值)。超過回 429 `rate_limited` 與 `Retry-After: 60`。`POST /v1/app-store/notifications` 不限流：來自 Apple 共用的伺服器 IP,被擋會延後訂閱狀態，且每則都要驗 App Store 簽章。推播另有每組配對密鑰每分鐘 10 則。
- **Apple refresh token**(#3):`identities.apple_refresh_token` 以 AES-GCM 加密(金鑰 secret `APPLE_TOKEN_ENCRYPTION_KEY`,身分的 subject 當 AAD),存 base64(IV ‖ 密文);只在撤銷時解密，解不開(金鑰換過、資料壞掉)視同沒有權杖。更換金鑰會讓既有權杖無法撤銷(之後重新登入時會存新的)。
- **刪除會員**:先撤銷 Sign in with Apple 權杖(Apple 回 200 或 400 都算完成),成功才刪資料;刪除靠 foreign key 的 `ON DELETE CASCADE`。Apple 訂閱不會因此取消，由 app 提醒使用者自行取消。

## 資料表

見 `migrations/`。`members`、`identities`、`refresh_tokens` 是 #27 的;`entitlements`(訂閱權限)是 #28 的;`push_pairings`(推播配對，含每組密鑰的速率限制計數)是 #29 的，`device_id`、`push_devices`(裝置名稱與型號)、`revoked_push_pairings`(遠端關閉的配對)是 purrdr.server#5 的，`push_pairings.kinds`(推播種類偏好)是 purrdr.server#10 的，`host_service_push_events`(主機服務事件的 24 小時去重)是 purrdr.server#11 的;`synced_hosts`(主機同步)是 #30 的。之後新增的會員資料表一律 `REFERENCES members(id) ON DELETE CASCADE`。

## 上線前要填的東西

目前沒有真的 Cloudflare 帳號與金鑰，以下都是佔位符(`REPLACE_ME`),上線前由人工提供：

| 項目 | 放哪裡 | 怎麼取得 |
|---|---|---|
| D1 資料庫 ID | `wrangler.jsonc` 的 `database_id` | `npx wrangler d1 create purrdr`,再 `npx wrangler d1 migrations apply purrdr --remote` |
| Sign in with Apple Key ID | `wrangler.jsonc` 的 `APPLE_KEY_ID` | Apple Developer → Keys,建立啟用 Sign in with Apple 的金鑰(綁 `com.raychiu.purrdr`) |
| Sign in with Apple 私鑰 | secret `APPLE_PRIVATE_KEY` | 上一步下載的 `.p8` 全文:`npx wrangler secret put APPLE_PRIVATE_KEY < AuthKey_XXXX.p8` |
| 存取權杖密鑰 | secret `ACCESS_TOKEN_SECRET` | `openssl rand -base64 48 \| npx wrangler secret put ACCESS_TOKEN_SECRET`;更換會讓所有存取權杖失效(更新權杖不受影響) |
| Apple 權杖加密金鑰 | secret `APPLE_TOKEN_ENCRYPTION_KEY` | `openssl rand -base64 32 \| npx wrangler secret put APPLE_TOKEN_ENCRYPTION_KEY`(32 bytes);更換會讓已存的 Sign in with Apple 權杖無法撤銷 |
| 限流 namespace | `wrangler.jsonc` 的 `ratelimits[].namespace_id` | 已填 `1001`;同一個 Cloudflare 帳號內要唯一的正整數字串，跟其他 Worker 重複時改掉 |
| Google OAuth client ID | `wrangler.jsonc` 的 `GOOGLE_CLIENT_IDS` | Google Cloud Console 建立 iOS 類型的 OAuth client(bundle id `com.raychiu.purrdr`);app 端也要填同一個 ID(見下) |
| App ID 開 Sign in with Apple | Apple Developer → Identifiers | `com.raychiu.purrdr` 勾選 Sign in with Apple(app 的 entitlement 已加) |
| 後台網址 | app 的 `src/App/Purrdr/BackendConfiguration.swift` | 部署後的 `https://purrdr-backend.<子網域>.workers.dev` |
| Apple 根憑證 | `wrangler.jsonc` 的 `APPLE_ROOT_CERTIFICATES` | 從 https://www.apple.com/certificateauthority/ 下載 **Apple Root CA - G3**(`AppleRootCA-G3.cer`,DER),核對 SHA-256 指紋與 Apple 公布的相同後 `base64 -i AppleRootCA-G3.cer \| tr -d '\n'` 填入。不是 secret |
| App 的 Apple ID | `wrangler.jsonc` 的 `APP_STORE_APP_APPLE_ID`,以及 app 的 `PurrdrLinks.appStoreID`(`src/PurrdrFeatures/PlusView.swift`) | 已填 `6835416115`(App Store Connect → App 資訊 → Apple ID);兩處要相同 |
| Purrdr Plus 商品 | App Store Connect → 訂閱 | 訂閱群組「Purrdr Plus」,商品 `com.raychiu.purrdr.plus.monthly`(1 個月)、`com.raychiu.purrdr.plus.yearly`(1 年),兩者都有 2 週免費試用(新訂閱者)。價格、顯示名稱與說明要跟 app repo 的 `src/App/Purrdr.storekit` 的意思一致(設定檔的價格只是測試用)。ID 改了要同步 `src/subscriptions.ts` 的 `PLUS_PRODUCT_IDS` 與 app 的 `MemberSubscription.productIDs` |
| Offer Code | App Store Connect → 訂閱 → 優惠代碼 | 送朋友與活動用;不用自訂授權碼(審查規範 3.1.1) |
| App Store Server Notifications | App Store Connect → App 資訊 → App Store 伺服器通知 | Production 與 Sandbox 都填 `https://<後台網址>/v1/app-store/notifications`,版本選 **Version 2**;填好後可用 App Store Server API 的「Request a Test Notification」確認(回 TEST 通知) |
| APNs 驗證金鑰 Key ID | `wrangler.jsonc` 的 `APNS_KEY_ID` | Apple Developer → Keys,建立啟用 Apple Push Notifications service (APNs) 的金鑰(環境選 Sandbox & Production);Team ID 沿用 `APPLE_TEAM_ID` |
| APNs 私鑰 | secret `APNS_PRIVATE_KEY` | 上一步下載的 `.p8` 全文:`npx wrangler secret put APNS_PRIVATE_KEY < AuthKey_XXXX.p8` |
| App ID 開推播 | Apple Developer → Identifiers | `com.raychiu.purrdr` 勾選 Push Notifications 與 Time Sensitive Notifications(app 的 entitlement 已加 `aps-environment` 與 time-sensitive) |
| 主機外掛的公開 repo | GitHub | 主機外掛在公開 repo `raychiutw/purrdr.host` 的 `host-plugin/`(已發佈;herdr 以 `OWNER/REPO/SUBDIR` 安裝 `raychiutw/purrdr.host/host-plugin`);app 的 `PushSettings.pluginSource` 要一致。外掛的後台網址在配對檔裡，由 app 寫入 |
| 隱私權政策網址 | app 的 `PurrdrLinks.privacyPolicy`(`src/PurrdrFeatures/PlusView.swift`)、App Store Connect | 已是 `https://raychiutw.github.io/purrdr/privacy/`;網頁原始碼在 app repo 的 `docs/site/purrdr/`,要發佈到 `raychiutw.github.io` repo 的 `purrdr/` 資料夾(見 app repo 的 `docs/launch/checklist.md`) |
| 使用條款 | App Store Connect 的 License Agreement | 目前用 Apple 標準 EULA(`PurrdrLinks.termsOfUse`);改用自訂條款時兩邊一起換 |
| Google client ID(app 端) | app 的 `src/App/Purrdr/BackendConfiguration.swift` | 同上面的 iOS OAuth client ID |

`APPLE_TEAM_ID`(`8Z6WVFJ574`)、`APPLE_CLIENT_ID`(bundle id)與 `APP_STORE_APP_APPLE_ID`(`6835416115`)已是真值。隱私權政策要寫明：後台保存登入身分的 subject 與 email(可能是 Apple 轉寄地址)、Sign in with Apple refresh token(加密存放，只用於撤銷)、訂閱紀錄(App Store 的 original transaction ID、商品、購買與到期時間、退款或撤銷時間、自動續訂狀態)、推播配對(配對密鑰的雜湊、APNs device token 與環境);推播經過後台時只有 workspace 名稱、狀態與 pane id,後台不保存。
會員開啟主機同步時，另保存每台主機的名稱、位址與埠、使用者名稱、連線方式(Tailscale SSH／OpenSSH／HTTPS)、host key 指紋、HTTPS 主機的主機服務位址與修改時間，
以及已刪除主機的 id 與刪除時間;後台可讀(TLS 傳輸、Cloudflare 靜態加密，不做端對端加密)。私鑰、密碼、passphrase、裝置權杖永不上傳。刪除會員時一併刪除。

沒有使用 App Store Server API,所以不需要 In-App Purchase key(`.p8`):權限只靠 app 提交的簽章交易與 App Store Server Notifications。之後若要主動查狀態或補抓漏掉的通知(Get All Subscription Statuses、Get Notification History),再新增金鑰與 secret。
