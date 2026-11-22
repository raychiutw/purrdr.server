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
- 對外請求(Apple／Google 的 JWKS、Google Play 的 OAuth token 與 Developer API(`test/google-play.ts` 組 `SubscriptionPurchaseV2` 與 RTDN,Pub/Sub 的 OIDC token 由假的 Google JWKS 簽)、Apple 的 token 與 revoke 端點、APNs)由 `test/fakes.ts` 換掉 global `fetch` 接手;沒預期的對外請求直接丟錯。假 Apple token 端點會驗證後台簽的 client secret(kid、iss、sub、aud、ES256 簽章);假 APNs 端點(`api.push.apple.com`、`api.sandbox.push.apple.com` 的 `/3/device/<token>`)驗證 provider token、記錄 header 與 payload,回應可由測試指定(`apnsReplies`)。
- **App Store 簽章用自建憑證鏈**:`vitest.config.ts` 每次產生一張測試根憑證(P-384,取代 Apple Root CA - G3),以 `APPLE_ROOT_CERTIFICATES` 交給後台信任;`test/app-store.ts` 用它簽中繼(帶 Apple WWDR OID)與葉憑證(帶 App Store 收據簽章 OID),再簽交易、續訂資訊與通知。`test/certificates.ts` 是只用 WebCrypto 的 X.509 產生器，可以做出各種壞掉的鏈(不受信任的根、少 OID、過期、簽發者不符)。後台程式不知道是測試，換成 Apple 的根憑證就是正式驗證。
- TDD 紅綠燈紀錄放在 repo 根目錄的 `.tdd-logs/`(不進 git)。

## API

全部 JSON(camelCase),時間是 ISO 8601。錯誤一律 `{ "error": { "code", "message" } }`,app 依 `code` 判斷。API 不綁平台(Android 之後共用)。

| 方法與路徑 | 權杖 | 說明 |
|---|---|---|
| `POST /v1/sessions` | — | 登入。body `{ provider: "apple"\|"google", idToken, nonce, authorizationCode?, deviceId?, platform? }`;Apple 必須帶 `authorizationCode`。`deviceId` 選填,是 app 存在 Keychain 的 UUID(1~64 字元的英數與 `.` `_` `:` `-`,不合 400 `invalid_request`;大小寫不拘,後台一律存小寫):帶了就以它建立或更新裝置,並撤銷這支裝置舊的工作階段(每裝置一個);別的會員在這支裝置上還有未撤銷的工作階段時不動那列,這次登入另建一列裝置(見「規則」的「裝置與工作階段」);沒帶(舊 app)維持每次登入建一個裝置。`platform` 選填(`ios`|`android`,預設 `ios`,不合法 400 `invalid_request`),寫進新建的裝置列。回 `{ accessToken, accessTokenExpiresAt, refreshToken, memberCreated, autoLinked, member }`;新身分的 email 已驗證且非私密轉寄、另一個會員有相同的已驗證 email 時歸到那個會員(`autoLinked: true`、`memberCreated: false`),見「規則」的「登入與自動合併」 |
| `POST /v1/sessions/refresh` | — | body `{ refreshToken }`,換一組新權杖。舊的更新權杖有 60 秒寬限:寬限內重送回傳**同一組**新權杖;寬限外再用舊權杖視為外洩,撤銷該工作階段並回 401。回應同登入，但沒有 `memberCreated` |
| `POST /v1/sessions/revoke` | — | 登出。body `{ refreshToken }`,回 204 |
| `GET /v1/members/me/sessions` | 存取權杖 | 列出自己未撤銷、未過期的工作階段(每裝置一個)。回 `{ sessions: [{ id, deviceId, deviceName, deviceModel, createdAt, lastActiveAt, expiresAt, current }] }`;`current` 是發出這個存取權杖的工作階段;`deviceName`／`deviceModel` 沒有時為 `null`;時間為 ISO 8601。存取權杖所屬的工作階段已撤銷也回 401 |
| `DELETE /v1/members/me/sessions/{id}` | 存取權杖 | 撤銷自己另一支裝置的工作階段(app 要求 Face ID 後才呼叫)。回 204;已撤銷的再撤銷也回 204(冪等);`id` 不存在或屬於別的會員 404 `session_not_found`;是目前這個工作階段 409 `cannot_revoke_current_session`(登出用 `POST /v1/sessions/revoke`)。被撤銷那支裝置的更新權杖立即失效,它已發出的存取權杖最多再活 15 分鐘(只有上面兩支工作階段 API 會即時拒絕) |
| `GET /v1/members/me` | 存取權杖 | 回 `{ member }` |
| `POST /v1/members/me/identities` | 存取權杖 | 連結另一種登入方式。body 同登入。回 `{ member, mergedMemberId: null }`;身分已屬於另一個會員時**不合併**,回 409 `merge_required`,`error.details` 是合併確認用的摘要(見下方「合併確認」) |
| `POST /v1/members/me/identities/merge` | 存取權杖 | 確認合併。body 同連結(要重新帶憑證)。回 `{ member, mergedMemberId, accessToken, accessTokenExpiresAt }` |
| `DELETE /v1/members/me/identities/{apple\|google}` | 存取權杖 | 解除連結。回 `{ member }` |
| `DELETE /v1/members/me` | 存取權杖 | 刪除會員。回 204 |
| `GET /v1/members/me/subscription` | 存取權杖 | 回 `{ subscription }`;從沒訂閱過是 `null` |
| `POST /v1/members/me/subscription/app-store` | 存取權杖 | 提交 StoreKit 2 交易。body `{ signedTransaction }`(`VerificationResult.jwsRepresentation`)。回 `{ subscription }`;訂閱屬於其他會員回 409 `subscription_in_use`,帶 `error.details`,見下方「訂閱綁定與 App Store 串接」 |
| `POST /v1/members/me/subscription/google-play` | 存取權杖 | Android app 提交 Google Play 購買。body `{ purchaseToken, productId }`。後台向 Google 查證後寫入訂閱,回 `{ subscription }`(`store: "google_play"`)。商品不在白名單或 Google 查不到回 400 `invalid_purchase`;Google 連不上回 502 `store_unavailable`;token 屬於其他會員回 409 `subscription_in_use`(同 App Store,帶 `error.details`);會員已有另一個有效訂閱(任一商店)回 409 `subscription_already_active`。見下方「Google Play 串接」 |
| `POST /v1/members/me/subscription/transfer` | 存取權杖 | 把屬於其他會員的 App Store 訂閱轉給目前會員。body `{ signedTransaction }`。回 `{ subscription, appAccountTokenUpdated }`,見「訂閱轉移」 |
| `POST /v1/members/me/hosts/sync` | 存取權杖 | 主機同步(要有效的 Purrdr Plus)。body `{ changes: [...] }`,回 `{ hosts: [...], deletedHostIds: [...] }`,見下方「主機同步」 |
| `POST /v1/members/me/push-pairings` | 存取權杖 | 註冊推播配對(需要有效訂閱)。body `{ keyHash, platform: "apns", deviceToken, environment: "production"\|"sandbox", deviceId?, deviceName?, model?, kinds? }`;`kinds` 是要收的推播種類(`blocked`、`done`、`stuck`、`reminder`、`host_service` 的陣列),新配對沒帶時只收 `blocked`。同一個 `keyHash` 再送一次是更新(APNs token 輪替、改偏好;沒帶 `kinds` 保留原本的偏好)。裝置欄位見下方「通知裝置」。回 201 |
| `DELETE /v1/members/me/push-pairings/{keyHash}` | 存取權杖 | 撤銷推播配對(只刪自己的、不存在也算成功、不需要訂閱)。回 204 |
| `GET /v1/members/me/push-devices?currentDeviceId=` | 存取權杖 | 會收到通知的裝置(不需要訂閱：到期後仍要能看到並關閉遺失的裝置)。回 `{ devices: [{ deviceId, name, model, hostCount, lastRegisteredAt, current }] }`,見下方「通知裝置」 |
| `PATCH /v1/members/me/push-devices/{deviceId}?currentDeviceId=` | 存取權杖 | 裝置改名(需要有效訂閱)。body `{ name }`,回 `{ device }`;不是自己的或沒有配對回 404 `device_not_found` |
| `DELETE /v1/members/me/push-devices/{deviceId}` | 存取權杖 | 遠端關閉裝置：撤銷它在所有主機的配對(不需要訂閱)。回 204;不是自己的或沒有配對回 404 `device_not_found` |
| `POST /v1/push` | 配對密鑰 | 主機外掛送「需要你」或「完成」、主機服務送「可能卡住」或「仍在等你」:body 只能有 `{ key, workspace, status: "blocked"\|"done"\|"stuck"\|"reminder", pane?, tab? }`(`tab`(#31)選填字串,herdr 的 Tab 名稱;控制字元換成空白、頭尾修掉,剩下空的當成沒帶,最長 100 字元,不是字串或太長 400;舊外掛不帶也照常運作)。主機服務送事件:body 只能有 `{ key, event: "host_service_update_available"\|"host_service_updated"\|"host_service_update_rolled_back", version? }`(`host_service_updated` 必須帶 `version`)。測試通知(#19,app 帳號頁「傳送測試通知」):body 只能有 `{ key, event: "test", host_name? }`(`host_name` 選填字串，最長 64 字元，控制字元與換行換成空白、頭尾修掉，剩下空的當成沒帶，不是字串或太長 400)。三種形狀互斥;多一個欄位、不認得的 `status`／`event`、`version` 不是語意化版本就 400。回 200 `{ delivered: true }`;種類不在配對的 `kinds` 內，或同一事件與版本 24 小時內送過時不轉 APNs,回 200 `{ delivered: false }`(測試通知不受 `kinds` 與去重影響) |
| `POST /v1/app-store/notifications` | — | App Store Server Notifications v2 的 webhook。body `{ signedPayload }`,處理完回 200 `{ received: true }` |
| `POST /v1/google-play/notifications` | Pub/Sub OIDC Bearer token | Google Play real-time developer notifications(Pub/Sub push,wrapped 格式 `{ message: { data, messageId }, subscription }`)。token 驗不過回 401 `invalid_notification`;處理完或略過回 200 `{ received: true }`;暫時查不到 Google 回 503(Pub/Sub 會重送)。不限流 |

**合併確認**(#24):連結時身分屬於另一個會員,回
`409 { error: { code: "merge_required", message, details: { canMerge, current, other } } }`;`current` 是目前登入的會員、`other` 是擁有該身分的會員,
兩邊都是 `{ identities: [{ provider, email }], hasActiveSubscription, hostCount }`。`email` 已遮蔽(只留第一個字元與網域,例如 `r***@example.com`;
沒有或格式不對是 `null`,遮蔽函式在 `src/mask-email.ts`,#25 也用它),不回對方的會員 ID。`hasActiveSubscription` 含帳單寬限期,
`hostCount` 不含已刪除的主機。`canMerge` 在兩邊都有有效訂閱時是 `false`。使用者確認後呼叫 `POST /v1/members/me/identities/merge`:
`mergedMemberId` 是被刪除的會員,`member` 是留下的會員;留下的可能是對方,原本的存取權杖屬於被刪的會員(之後 401),
所以回應附留下會員的新 `accessToken`;新存取權杖沿用同一個 `sid`;更新權杖不變(sessions 一併搬過去)。存取權杖要帶 `sid`(同工作階段 API),舊版沒帶 `sid` 的存取權杖回 401。身分沒有屬於任何會員、或本來就是自己的回 409 `no_merge_needed`。

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
(套用 `0001`～`0009`),再 `npx wrangler deploy`,最後把後台網址填進 app 的 `BackendConfiguration.swift` 發版。後台是手動部署，
不會跟著 app 發布上線。

存取權杖放在 `Authorization: Bearer <accessToken>`。

### 錯誤碼

| HTTP | code | 何時 |
|---|---|---|
| 400 | `invalid_request` | body 不是 JSON、缺欄位、provider 不認得 |
| 401 | `invalid_id_token` | ID token 簽章、iss、aud、exp、nonce 不對，或 Apple 拒絕 authorization code |
| 401 | `invalid_access_token` | 沒帶、無效、過期，或會員已刪除 |
| 401 | `invalid_refresh_token` | 更新權杖無效、過期、工作階段已撤銷,或寬限(60 秒)外重用舊權杖(同時撤銷該工作階段) → app 要請使用者重新登入 |
| 404 | `session_not_found` | 撤銷工作階段:`id` 不存在或不是自己的 |
| 409 | `cannot_revoke_current_session` | 撤銷工作階段:不能撤銷目前這個(要登出請用 `POST /v1/sessions/revoke`) |
| 404 | `identity_not_linked` | 解除沒有連結的登入方式 |
| 409 | `provider_already_linked` | 連結或確認合併時已經有同一種登入方式(每種最多一個) |
| 400 | `invalid_transaction` | 交易簽章驗不過，或不是這個 app、不是 Purrdr Plus、環境不是 Production／Sandbox(StoreKit 設定檔的交易一律驗不過) |
| 400 | `invalid_notification` | App Store 通知簽章驗不過，或 bundle id、環境(`data.environment` 與交易的 `environment` 不一致也算)、app Apple ID 不對 |
| 400 | `invalid_purchase` | Google Play 購買驗不過:商品不在白名單(或與 Google 回的不一致)、Google 查無此 purchase token |
| 401 | `invalid_notification` | Google Play 通知的 OIDC token 驗不過(簽章、iss、aud、exp、email、email_verified) |
| 502／503 | `store_unavailable` | 暫時問不到 Google Play(綁定回 502、通知回 503 讓 Pub/Sub 重送):沒設定、金鑰或服務帳戶授權有問題、連不上、逾時、429、5xx |
| 403 | `subscription_required` | 需要有效的 Purrdr Plus(主機同步、註冊推播配對、送推播) |
| 404 | `subscription_not_found` | 轉移的訂閱沒登記在任何會員 |
| 404 | `pairing_not_found` | 送推播的配對密鑰沒有註冊(或已撤銷) |
| 409 | `pairing_in_use` | 這個配對密鑰雜湊已屬於另一個會員 |
| 410 | `pairing_revoked` | APNs 說 device token 已失效(`Unregistered`、`BadDeviceToken`、`DeviceTokenNotForTopic`);配對已刪除 |
| 413 | `invalid_request` | 推播請求 body 超過 2 KB |
| 429 | `rate_limited` | 同一個 IP(`CF-Connecting-IP`)60 秒內超過 60 次(帶 `Retry-After` 秒數;App Store 通知不限流),或推播的這組配對密鑰一分鐘內超過 10 則 |
| 502 | `apns_failed` | APNs 拒絕或連不上(配對保留) |
| 409 | `merge_required` | 連結時身分屬於另一個會員;`error.details` 是合併摘要,確認後改呼叫 `POST /v1/members/me/identities/merge` |
| 409 | `subscription_conflict` | 確認合併時兩邊都有有效訂閱(一個會員只能有一個);什麼都沒動,要先讓其中一邊不再有效 |
| 409 | `no_merge_needed` | 確認合併時身分沒有屬於任何會員,或本來就是自己的 |
| 409 | `subscription_in_use` | 這個 App Store 或 Google Play 訂閱已屬於另一個會員;`error.details` 是 `{ ownerEmail, canTransfer }`(見「訂閱綁定與 App Store 串接」) |
| 409 | `subscription_already_active` | 這個會員已有另一個有效訂閱(一個會員同時最多一個:有效 = 生效中、帳單寬限期、帳單重試期);換訂閱要等原訂閱不再有效 |
| 409 | `subscription_already_owned` | 轉移的訂閱已屬於目前會員 |
| 409 | `last_identity` | 解除最後一種登入方式 |
| 502 | `provider_unavailable` | 連不上 Apple／Google |
| 502 | `apple_revoke_failed` | 刪除會員時撤銷 Sign in with Apple 權杖失敗;資料沒有刪，請稍後重試 |

### 訂閱綁定與 App Store 串接(#25)

**屬於其他會員**:提交的交易(或其 `appAccountToken`)屬於另一個會員時回
`409 { error: { code: "subscription_in_use", message, details: { ownerEmail, canTransfer } } }`。
`ownerEmail` 是擁有者任一登入身分的遮蔽 email(`maskEmail`,例如 `r***@example.com`;擁有者沒有 email 時是 `null`),不回對方的會員 ID。
`canTransfer` 是提交的會員自己沒有佔著有效訂閱名額(生效中、帳單寬限期、帳單重試期;一會員一訂閱),供訂閱轉移(#27,見下方「訂閱轉移」)判斷。

**事件稽核**(`subscription_events`):app 提交的交易記 `client` / `transaction_submitted`;通知記 `store_notification`,`type` 是
`<notificationType>` 或 `<notificationType>.<subtype>`,`notification_uuid` 唯一。

**通知冪等**:同一個 `notificationUUID` 已處理過就直接回 200,不重複處理(Apple 失敗時會重送;Sandbox 只送一次)。
**狀態轉換**:依通知 `data.status`(1 active、2 expired、3 billing retry、4 grace、5 revoked)寫入 `subscriptions.status`:
`active`、`expired`、`billing_retry`、`grace`、`revoked`;REFUND(交易帶 `revocationDate`)記 `refunded`。`GRACE_PERIOD_EXPIRED` 的 status 是 3,對應
`billing_retry`(寬限期結束、Apple 仍在重試)。通知沒帶 `data.status` 時才依通知類型推算。`grace` 之外的狀態都沒有 Plus 權限(`billing_retry` 沒有權限,
但仍佔著一會員一訂閱的名額;會員重新購買另一個訂閱時,已過期的重試中訂閱讓位成 `expired`)。Production 與 Sandbox 通知用同一個網址,依 `data.environment` 區分,
且必須與交易的 `environment` 一致。不認得的訂閱(沒登記、`appAccountToken` 也不是現有會員)略過、回 200,不記事件(事件要掛在訂閱底下)。

**App Store Server API 查證**(`src/app-store-api.ts`):綁定時後台用 ES256 JWT(`kid` = `APP_STORE_API_KEY_ID`、`iss` = `APP_STORE_API_ISSUER_ID`、
`aud` = `appstoreconnect-v1`、`bid` = bundle id、有效 5 分鐘)呼叫 `GET /inApps/v1/subscriptions/{originalTransactionId}`(Get All Subscription Statuses),
主機依交易環境選:Production `api.storekit.apple.com`、Sandbox `api.storekit-sandbox.apple.com`。
- 查得到:以 Apple 回報的最新交易、續訂資訊與狀態為準,記 `store_api` / `status_checked`。
- **查不到或 Apple 不可達都不擋購買**:提交的簽章交易本身已驗過 Apple 憑證鏈,所以以簽章交易為準。Apple 查無此訂閱(404)記 `lookup_not_found`;
  沒設定金鑰、連不上、逾時(5 秒)、429、5xx、或 JWT 被拒(401,查 secret 與 Key ID／Issuer ID)記 `lookup_unreachable`。之後的通知或下一次提交會補上 Apple 的狀態。
- `setAppAccountToken(env, originalTransactionId, memberId, environment)`(`PUT /inApps/v1/transactions/{id}/appAccountToken`)由訂閱轉移(#27)呼叫。Apple 拒絕丟 `AppStoreApiError`(帶 `errorCode`),暫時不可用丟 `AppStoreApiUnavailable`(可重試)。

### 訂閱轉移(#27)

`POST /v1/members/me/subscription/transfer`,body `{ signedTransaction }`:app 提交 StoreKit 簽章交易(`VerificationResult.jwsRepresentation`),證明目前裝置的 Apple ID 擁有該訂閱。
後台驗章(與綁定相同:憑證鏈、bundle id、環境、商品),找到該 original transaction 目前所屬的另一個會員,改歸目前會員。**Face ID 驗證是 app 端的責任,後台不處理。**

成功回 `200 { subscription, appAccountTokenUpdated }`:`subscription` 是目前會員的新訂閱(形狀同 `GET /v1/members/me/subscription`);
`appAccountTokenUpdated` 表示之後的續訂是否已讓 Apple 歸新會員。

| 狀態 | `error.code` | 情境 |
|---|---|---|
| 400 | `invalid_transaction` | 簽章交易驗不過 |
| 404 | `subscription_not_found` | 這個訂閱沒登記在任何會員(不是轉移,走一般綁定 `POST .../subscription/app-store`) |
| 409 | `subscription_already_owned` | 訂閱已屬於目前會員 |
| 409 | `subscription_already_active` | 目前會員已佔著有效訂閱名額(生效中、帳單寬限期、帳單重試期);什麼都沒動 |

**一個 D1 batch(原子)**:改 `subscriptions.member_id`、寫 `subscription_transfers`、寫 `subscription_events`(`client` / `transferred`)、
撤銷原會員的推播配對(寫 `revoked_push_pairings` 並刪 `push_pairings`,主機外掛之後送推播收 410 `pairing_revoked`,做法同遠端關閉裝置)。
原會員若還有別的有效訂閱則不撤銷配對。原會員的 Plus 因訂閱不再屬於它而**立即失效**,主機同步因 `requireActiveSubscription` 回 403 `subscription_required`。

**Set App Account Token**:batch 之後呼叫 `setAppAccountToken`(`appAccountToken` = 新會員 ID),讓之後續訂的交易歸新會員。
**失敗不回滾轉移**(Apple 不可達是常態):記 `subscription_events`(`store_api` / `set_app_account_token_failed`),回應 `appAccountTokenUpdated: false`;成功記 `app_account_token_set`。
後台目前沒有自動重試;`appAccountTokenUpdated: false` 時,續訂通知仍帶舊的 `appAccountToken`,但通知處理**一律先查 `external_id` 的登記歸屬**,
所以訂閱仍屬新會員,不會被舊 token 拉回原會員。

**邊角:重試中的舊訂閱被新購買讓位後才續訂成功**:會員購買新的 original transaction 時,舊的 `billing_retry` 訂閱會被標成 `expired` 讓位;
之後舊訂閱的 `DID_RENEW` 若撞上「一會員一個有效訂閱」的唯一索引,通知不再回 409(Apple 會一直重送),改記 `store_notification` / `slot_conflict_ignored` 並回 200,
舊訂閱維持 `expired`、新訂閱不受影響。代價:使用者其實同時付了兩筆訂閱的錢,需由使用者在 Apple 取消其中一個(或之後把其中一個轉移給另一個會員)。

### 規則

- **更新權杖輪替寬限**(purrdr.server#23):輪替是單一 `UPDATE`(換上新雜湊、舊雜湊記到 `previous_refresh_token_hash`、`rotated_at`、`grace_until = 輪替時間 + 60 秒`),發新與作廢是同一筆原子寫入;登入時撤銷舊工作階段、upsert 裝置、新增工作階段在同一個 D1 batch(交易)。
  - **寬限內重送要回同一組新權杖,但資料庫不能存明文更新權杖**,所以新權杖不是隨機值,而是 `HMAC-SHA256(ACCESS_TOKEN_SECRET, "purrdr-refresh-rotation-v1:" + SHA-256(舊權杖))` 的 base64url。重送時用同一個舊權杖再導一次就得到相同結果,並確認它的雜湊等於目前存的雜湊才回傳。沒有新增 secret、沒有新欄位、沒有任何可還原權杖的密文;只有資料庫(雜湊)或只有舊權杖都導不出新權杖,要同時持有伺服器 secret。取捨:新權杖在給定舊權杖時是確定的,所以保護它靠的是 `ACCESS_TOKEN_SECRET` 保密(它本來就能簽出任何存取權杖);更換這個 secret 會同時讓所有存取權杖與寬限內的重送失效(之後換權杖不受影響)。
  - 寬限外重送舊權杖 → 撤銷該工作階段(新權杖也失效),回 401 `invalid_refresh_token`。只記得「上一個」權杖,更早的權杖查不到,一律當無效權杖(401,不撤銷)。
  - 已撤銷或已過期的工作階段,寬限內的舊權杖也換不到。
  - 登出(`POST /v1/sessions/revoke`)也認寬限內的舊權杖。
- **裝置與工作階段**:`deviceId` 是 app 產生並存 Keychain 的 UUID(後台一律存小寫),**不是秘密、也不證明持有**,所以不能憑它接管別人的裝置:
  - 該裝置列屬於別的會員、而且那個會員在這支裝置上還有未撤銷(未過期)的工作階段時,不動那一列、不撤銷它的工作階段,這次登入另建一列裝置(`anon:` 開頭的佔位 id)照常登入。
  - 沒有這一列、列的 `member_id` 為 `NULL`、屬於同一個會員,或原會員已登出(工作階段都撤銷了)時沿用該列;同一支手機換會員登入屬於最後一種。裝置改歸新會員時,原會員在這支裝置的推播配對一併撤銷(寫 `revoked_push_pairings`、刪 `push_pairings`,同一個 batch),新會員不會收到原會員主機的通知。
  - 沒帶 `deviceId` 的舊 app,每次登入產生一個 `anon:` 佔位裝置列,舊工作階段不會被撤銷(可從別的裝置在列表撤銷);佔位裝置在沒有推播權杖、沒有配對、沒有未撤銷工作階段時(工作階段被登出或被撤銷)連同它的工作階段列一起刪除。已撤銷的佔位工作階段因此查不到,再次撤銷回 404 而不是 204。
  - `deviceId` 只會在持有人自己的 `GET .../sessions` 回應裡出現。
- **nonce**:app 每次登入產生隨機 nonce,把原文送來。Sign in with Apple 交給 Apple 的是 nonce 的 SHA-256(小寫 hex),Google 是原文;後台依此比對 ID token 的 `nonce`。
- **權杖**:存取權杖是 HS256 JWT,15 分鐘;更新權杖 90 天、只存雜湊(`sessions`,每支裝置一個未撤銷的工作階段)、用一次就輪替。存取權杖帶 `sid`(工作階段 ID)。
- **登入與自動合併**(#24):登入的是**新身分**(不屬於任何會員)時,若 token 的 email 已驗證(`email_verified`)、不是 Apple 私密轉寄、且另一個會員有某個身分 `email_verified = 1`、非私密轉寄、email 相同(不分大小寫),就歸到那個會員並新增這個身分(Apple 一樣換 refresh token)。不自動合併:email 沒驗證或沒有、私密轉寄(兩邊任一邊)、符合的會員不只一個(不猜)、符合的會員已有同一提供者的身分(每種最多一個,沿用 `provider_already_linked` 的精神)。這些情形一律建新會員,使用者之後可在帳號頁手動連結。既有身分再次登入不做合併判斷。既有身分再次登入(與確認合併)時 token 沒帶 email,則 email、`email_verified`、`is_private_relay` 都維持原值,不被洗掉。
- **連結與確認合併**(ADR-0007、#24,取代舊的「空會員自動併入」):身分屬於另一個會員時一律先回合併摘要(`merge_required`),不直接合併、也不換 Apple authorization code;使用者確認(app 要 Face ID)後才合併。ADR-0007 原文的「對方有訂閱或同步資料就拒絕」改成下列規則,ADR 另行更新:
  - 兩邊都有**有效訂閱**(佔著名額:生效中、帳單寬限期、帳單重試期,即 `holdsLiveSlot`)→ 409 `subscription_conflict`。合併摘要的 `hasActiveSubscription`／`canMerge` 與此一致(帳單重試期也算 `true`)。
  - 否則**留下資料多的那邊**:有有效訂閱 > 有訂閱列(含過期)或同步主機列(含刪除紀錄) > 空會員;同等時留下目前登入的會員(請求這一邊)。另一邊整個併進來後刪除。
  - 同一個 D1 batch(單一 transaction)搬 `identities`、`subscriptions`、`synced_hosts`、`devices`、`push_pairings`、`sessions`(連同 `revoked_push_pairings`、`host_service_push_events`)的歸屬,最後刪除被併的會員;任何一步失敗整個 rollback。`synced_hosts` 同一個 `host_id` 兩邊都有時取 `modified_at` 最新者(一樣新留下的那邊)。合併前先把兩邊「狀態還是有效、實際已過期」的訂閱列改成 `expired`,避免佔著有效訂閱的名額。兩邊同時各有有效訂閱的競態由 `subscriptions_one_live_per_member` 擋下,同樣回 `subscription_conflict`。
  - 確認合併時,目前會員已有「剛驗證的那個提供者」→ 409 `provider_already_linked`(同連結;否則合併會悄悄丟掉其中一個,可能是剛驗證的,Apple authorization code 也已消耗),不動資料。
  - 兩邊有同一提供者的身分(不含剛驗證的那個提供者,每個會員每種最多一個)時:留下那邊的保留,被併那邊的丟掉,丟掉的 Apple 身分在合併成功後撤銷 Sign in with Apple 權杖(盡力而為,失敗不擋合併)。搬過來的身分保留原有的 refresh token,不撤銷。
- **解除 Apple**:同時撤銷該 Sign in with Apple 權杖(盡力而為)。
- **訂閱權限**(ADR-0007):app 購買時以 `appAccountToken` 帶入會員 ID;交易與通知都只信任 App Store 簽的 JWS:`x5c` 三張憑證、最上層與 `APPLE_ROOT_CERTIFICATES` 逐位元組相同、逐層簽章正確、中繼與葉帶 Apple 的 OID、在 `signedDate` 時都在有效期間、JWS 是 ES256 由葉憑證簽(與 App Store Server Library 相同，不做線上 OCSP)。另外檢查 bundle id、環境(Production 與 Sandbox 都收：App Review 與 TestFlight 是 Sandbox)、商品、正式環境通知的 app Apple ID。
- **訂閱歸屬**:一個 App Store 訂閱(original transaction)只屬於一個會員。已登記的只屬於原會員;`appAccountToken` 是另一個現有會員時不能被領走(409 `subscription_in_use`);沒有 `appAccountToken`(在 App Store 兌換 Offer Code)或原會員已刪除時，歸提交的會員。
- **通知**:不依通知類型個別處理，而是寫入通知裡的交易與續訂資訊：續訂帶新的到期時間、到期的時間已過、退款與撤銷帶 `revocationDate`、撤銷被取消時不帶。較晚購買的交易取代舊的;同一筆交易只接受簽章時間不早於現有的;續訂資訊也依簽章時間，晚到的舊通知不會蓋掉新狀態。沒登記且 `appAccountToken` 不是現有會員的訂閱略過(回 200)。
- **權限判定**:沒有 `revoked_at`,且到期時間或帳單寬限期還沒過(讀取時依時間推算;`subscriptions.status` 是寫入當下的快照,寫入新訂閱前會先把這個會員已到期的有效列改成 `expired`)。推播與主機同步用 `src/subscriptions.ts` 的 `hasActiveSubscription`／`requireActiveSubscription`(403 `subscription_required`)。
- **推播**(ADR-0004、#29):app 產生 32 bytes 配對密鑰(64 位小寫 hex),只把那 32 bytes 的 SHA-256(小寫 hex)交給後台;密鑰本身只在 app 與主機的 `~/.purrdr/push-<裝置>/pairing`。主機外掛送推播時帶密鑰，後台算雜湊找配對 → 會員要有有效訂閱 → 種類要在配對的 `kinds` 偏好內(否則回 `{ delivered: false }`,不呼叫 APNs)→ 主機服務事件去重 → 每組密鑰每分鐘 10 則(只計真的要送 APNs 的，偏好或去重擋下的不計，避免擠掉「需要你」;速率限制、訂閱檢查與 410 對所有種類一致)→ 由後台自己組 APNs payload(標題 = workspace 名稱,有帶 `tab` 時是「workspace · Tab」;`aps` 另有 `mutable-content: 1`(app 的 Notification Service Extension 可改寫)與 `thread-id` = SHA-256(配對雜湊 + 換行 + workspace),同一配對同一 workspace 的通知疊在一起,不含主機名稱與 tab;主機服務事件與測試通知也帶 `mutable-content: 1`,但沒有 `thread-id`;根層 `pairing`(雜湊)、`pane`、`status`;`category` 讓 app 設定隱藏預覽時的通用文字):
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
  - 舊版 app 沒帶 `deviceId` 的配對以 device token 歸類，`deviceId` 是 `legacy-` 加 token 的 SHA-256 前 32 位 hex,`name`／`model` 為 `null`(app 顯示「未命名裝置」);可用這個 id 撤銷或改名;改名存在 `devices.name`(舊版 app 的新配對以同一組 device token 歸成同一台)。0009 遷移前就存在的舊配對,`devices.id` 是 `token:<device token>`,對外一律換成同一個 `legacy-` 加雜湊的 id,device token 不出後台。
  - 遠端關閉：刪除配對並記入 `revoked_push_pairings`,主機外掛之後用那組密鑰送推播回 410 `pairing_revoked`(外掛據此清掉本機的 `push-<裝置>` 目錄);同一組密鑰重新註冊就恢復。410 只回一次(回完刪掉紀錄，之後是 404),每次遠端關閉時順手刪掉 90 天前的紀錄。以密鑰撤銷(`DELETE .../push-pairings/{keyHash}`,裝置自己關)則照舊回 404。
- **「有資料」的定義**(決定合併時留哪邊):會員只要有 `subscriptions` 列(不論是否過期)或 `synced_hosts` 列(含刪除紀錄)就不是空會員。
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

見 `migrations/`。會員架構重做(purrdr.server#22,規格 raychiutw/purrdr.ios#402)之後,所有時間是 Unix epoch 毫秒:

| 表 | 內容 |
|---|---|
| `members` | `id`、`created_at`、`deleted_at`(目前刪除是硬刪,欄位先留) |
| `identities` | 登入方式:`provider`(apple\|google)、`subject`、`email`、`email_verified`、`is_private_relay`、`apple_refresh_token`(加密)、`linked_at`;唯一 `(provider, subject)`。`email_verified` 是 token 的 `email_verified`,Apple 私密轉寄一律 0(不參與自動合併) |
| `subscriptions` | 訂閱:`store`(app_store\|google_play)、`external_id`(App Store 的 original transaction ID／Google Play 的 purchase token)、`status`(active\|grace\|billing_retry\|expired\|revoked\|refunded)、`expires_at`、`auto_renew`、`environment`(sandbox\|production)…;唯一 `(store, external_id)`;**部分唯一索引 `subscriptions_one_live_per_member`:每個會員在 `status` 是 active／grace／billing_retry 且 `pending_review = 0` 的列最多一筆**。`pending_review` 是遷移合併留下的「待處理」標記(見下) |
| `subscription_events` | 稽核與冪等:`source`(store_notification\|store_api\|client)、`type`、`notification_uuid`(唯一) |
| `subscription_transfers` | 轉移紀錄:`from_member`、`to_member` |
| `devices` | 一支實體裝置一列(`id` = app 的 Keychain `device_id`):`member_id`(可空)、`platform`(ios\|android)、`name`、`model`、`push_token`、`push_environment`、`revoked_at` |
| `sessions` | 工作階段:每個裝置最多一個未撤銷的(部分唯一索引);`refresh_token_hash`、`previous_refresh_token_hash`、`rotated_at`、`grace_until`(輪替寬限,purrdr.server#23)、`revoked_at` |
| `push_pairings` | 推播配對:`key_hash`(唯一)、`device_id`(→ `devices`;推播權杖在裝置上)、`kinds`、`muted`(靜音清單,JSON,預設 `[]`)、速率限制計數 |
| `synced_hosts` | 主機同步(沿用既有,欄位本來就符合規格:內容欄位、`modified_at` 當版本、`deleted_at`) |

另外有 `revoked_push_pairings`(遠端關閉的配對)與 `host_service_push_events`(主機服務事件的 24 小時去重)。之後新增的會員資料表一律 `REFERENCES members(id) ON DELETE CASCADE`。
`subscriptions` 比規格多的欄位(`current_transaction_id`、`purchased_at`、`revoked_at`、`transaction_signed_at`、`grace_expires_at`、`renewal_signed_at`)是 App Store 的簽章時間與寬限期,晚到的舊通知靠它判斷新舊。

### 0009 遷移(會員架構重做)

`migrations/0009_member_architecture.sql` 同時建新表與搬舊資料(`entitlements` → `subscriptions`、`refresh_tokens` 丟掉、`push_devices` 併入 `devices`、`push_pairings` 的裝置權杖移到 `devices`),搬完就刪舊表。

- **合併**:已驗證 email 相同(不分大小寫)的會員合併成一個,登入方式都保留。舊資料沒有 `email_verified`,判定為:Google 的 email 與 Apple 非私密轉寄(`@privaterelay.appleid.com`)視為已驗證,私密轉寄不參與。群組以共用 email 連起來(三輪傳遞,A~B、B~C 也併成一群)。留下的會員:有有效訂閱者優先,其次最早建立。被合併掉的會員,它的訂閱、主機、推播配對與裝置都歸留下的會員;同一個 `host_id` 取 `modified_at` 最新者。
- **訂閱**:`status` 依遷移當下的時間推算(退款 → revoked、未到期 → active、帳單寬限期內 → grace、其餘 expired)。合併後同一個會員有多個有效訂閱時,到期(含寬限)最晚者保留,其餘標 `pending_review = 1`(保留真實狀態、不佔有效訂閱的名額),之後帳號頁提示使用者處理。
- **登入**:舊的更新權杖全部作廢(沒有搬到 `sessions`),使用者重新登入一次。
- **冪等**:wrangler 以 `d1_migrations` 記錄套用過的 migration,**同一個 migration 只會跑一次**,重複執行 `migrations apply` 不會再動資料(`test/migration-0009.test.ts` 驗證)。這個 migration 本身不能整段重跑(舊表搬完就刪)。
- **回滾**:D1 的 migration 不能 down。套用前先記下目前的 bookmark:`npx wrangler d1 time-travel info purrdr`;出問題用 `npx wrangler d1 time-travel restore purrdr --bookmark=<bookmark>` 還原整個資料庫(保留期間內有效,依 Cloudflare 方案 7 或 30 天),再把 Worker 退回上一版(`npx wrangler rollback`)。還原會丟掉套用後新登入與新訂閱的資料,所以要在 Worker 還沒對外使用新版前決定。
- **順序**:先套用 migration,再 `npx wrangler deploy`(舊版 Worker 讀不了新表,新版 Worker 讀不了舊表,中間會有一小段空窗;兩步請連續做)。**部署由使用者手動執行**。
- 測試:`test/migration-0009.test.ts` 先建出 0001~0008 的舊資料庫、塞一份快照(合併、私密轉寄不合併、兩邊都有有效訂閱、寬限期、退款、裝置與配對、重複主機)再套用 0009;`test/schema.test.ts` 驗證各項限制。
### Google Play 串接(#26)

與 App Store 並列的第二個訂閱來源(`src/google-play.ts`、`src/google-play-api.ts`)。`subscriptions.store = 'google_play'`、`external_id` 是 purchase token(Google 保證全域唯一)。
`GET /v1/members/me/subscription` 與 Plus 權限判定對兩個商店一視同仁,`store` 欄位回 `google_play` 時 iOS 端顯示「透過 Google Play 訂閱」。

**一會員一訂閱跨商店**:有效 = 生效中、寬限期、重試期(on hold),與 App Store 同一個部分唯一索引。會員已有有效的 App Store 訂閱時綁定 Google Play、或反過來,都回 409 `subscription_already_active`。
token 已屬於另一個會員回 409 `subscription_in_use`(`details` 同 #25:遮蔽 email 與 `canTransfer`);`linkedPurchaseToken` 的舊 token 屬於別人、或購買時帶的 `obfuscatedAccountId` 是另一個現有會員也一樣。**不實作 Google 的訂閱轉移**。

**Developer API 查證**:服務帳戶 JWT(RS256;`iss` = `GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL`、`scope` = `https://www.googleapis.com/auth/androidpublisher`、`aud` = `https://oauth2.googleapis.com/token`、有效 5 分鐘)
向 `oauth2.googleapis.com/token` 換 access token(`jwt-bearer`;每次呼叫換一個,不快取),再呼叫 `GET /androidpublisher/v3/applications/{package}/purchases/subscriptionsv2/tokens/{token}`。
**Google 是這條路徑唯一的購買證明**,所以查不到(400/404/410)回 400 `invalid_purchase`、暫時問不到回 502,都不寫入。purchase token 過期後 60 天就不能再查。

**狀態對應**(`subscriptionState`):

| Google | 我們存的狀態 |
|---|---|
| `ACTIVE` | `active`(`expiryTime` 已過則 `expired`) |
| `CANCELED`(已取消、存取到 `expiryTime`) | `expiryTime` 還沒到 `active`(`auto_renew = 0`),已過 `expired` |
| `IN_GRACE_PERIOD` | `grace`(保留權限) |
| `ON_HOLD` | `billing_retry`(沒有權限;重新購買時讓位成 `expired`,同 App Store) |
| `EXPIRED`、`PAUSED`、`PENDING`、`PENDING_PURCHASE_CANCELED` | `expired`(沒有權限) |

沒有權限的狀態,到期時間會壓到現在以前,免得之後依時間推算又變有效。**撤銷沒有獨立的 `subscriptionState`**(撤銷後 Google 回 `EXPIRED`),只能靠通知:
`SUBSCRIPTION_REVOKED`(12)記 `revoked`、`voidedPurchaseNotification`(訂閱退款或 chargeback,`productType = 1`)記 `refunded`,兩者都設 `revoked_at`、立刻失去權限,且之後的查證不會復活(`revoked_at` 有值就不再覆寫)。

**acknowledge**:新購買 3 天內沒 acknowledge 會被 Google 自動退款並撤銷。綁定或通知查證後,有權限且 `acknowledgementState` 還是 `PENDING` 就由後台 acknowledge
(`POST .../purchases/subscriptions/{productId}/tokens/{token}:acknowledge`;文件寫 2025-05-21 起 `subscriptionId` 不是必要,後台仍帶 productId)。失敗不擋綁定,記 `acknowledge_failed` 事件,下一次查證再送。

**linkedPurchaseToken**(升降級、在 app 內重新訂閱):新 token 綁定時,舊 token 的列改成 `expired`,同一會員不會被一會員一訂閱擋下。通知先於 app 提交到達時(`PURCHASED` 帶新 token),依 `linkedPurchaseToken` 找到舊 token 的會員後綁上新 token。

**RTDN**(`POST /v1/google-play/notifications`):
- 驗 Pub/Sub push 的 OIDC Bearer token:Google 簽章(`googleapis.com/oauth2/v3/certs`)、`iss`(`accounts.google.com`)、`aud` = `GOOGLE_PLAY_PUBSUB_AUDIENCE`、`exp`,且 `email` = `GOOGLE_PLAY_PUBSUB_SERVICE_ACCOUNT_EMAIL`、`email_verified` = true。沒設定一律拒絕。
- 以 `message.messageId` 冪等(事件的 `notification_uuid` 記成 `gp:<messageId>`,`source = store_notification`,`type` 是通知類型名稱如 `RENEWED`、`REVOKED`、`VOIDED`);處理成功後才記,所以 503 後重送會重新處理。
- 通知只代表「狀態變了」:收到後重新向 Google 查證再更新。不認得的 token(沒綁過、`linkedPurchaseToken` 也找不到會員)、測試通知、別的 package、一次性商品通知、格式壞掉的訊息都回 200 略過。
- Google 回 5xx／非 2xx 才會重送(指數退避 100 ms 到 60 秒);後台回 200 即確認。

**設定步驟**(上線前,由人工執行):
1. Google Cloud:建立(或沿用)專案,啟用 **Google Play Android Developer API**。
2. 建立呼叫 API 的服務帳戶,下載 JSON 金鑰。email 填 `wrangler.jsonc` 的 `GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL`;金鑰全文 `npx wrangler secret put GOOGLE_PLAY_SERVICE_ACCOUNT_KEY < key.json`(只放 `private_key` 的 PEM 也行)。
3. Play Console → 使用者與權限 → 邀請這個服務帳戶 email,授權 App 的 **View financial data**(含查詢訂閱與 acknowledge 所需的權限);授權生效可能要幾小時。
4. `wrangler.jsonc`:`GOOGLE_PLAY_PACKAGE_NAME`(Android package name)、`GOOGLE_PLAY_PRODUCT_IDS`(Play Console 的訂閱商品 ID,逗號分隔;預設與 App Store 同名,不同就改)。
5. RTDN:Google Cloud Pub/Sub 建 topic,把 `google-play-developer-notifications@system.gserviceaccount.com` 設為該 topic 的 **Pub/Sub Publisher**。
6. 建 **push subscription**:endpoint `https://<後台網址>/v1/google-play/notifications`、啟用 authentication(OIDC),選一個服務帳戶(它的 email 填 `GOOGLE_PLAY_PUBSUB_SERVICE_ACCOUNT_EMAIL`)、**audience 填同一個通知網址**(同時填 `GOOGLE_PLAY_PUBSUB_AUDIENCE`)。Pub/Sub 服務代理(`service-<專案編號>@gcp-sa-pubsub.iam.gserviceaccount.com`)要有該服務帳戶的 **Service Account Token Creator** 角色。使用 wrapped 格式(預設)。
7. Play Console → 營利 → 營利設定 → Real-time developer notifications:填 topic 名稱 `projects/<專案>/topics/<topic>`,選「訂閱與撤銷」類通知,按 **Send test message** 確認後台回 200。
8. 新 secret 與 vars 清單:secret `GOOGLE_PLAY_SERVICE_ACCOUNT_KEY`(選用,不在 `secrets.required`;Android 上線前可不設,型別宣告在 `src/env.d.ts`);vars `GOOGLE_PLAY_PACKAGE_NAME`、`GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL`、`GOOGLE_PLAY_PRODUCT_IDS`、`GOOGLE_PLAY_PUBSUB_SERVICE_ACCOUNT_EMAIL`、`GOOGLE_PLAY_PUBSUB_AUDIENCE`(識別碼,可進 repo;目前除商品 ID 外是 `REPLACE_ME`)。
Android app 購買時要把會員 ID 放進 `obfuscatedAccountId`(對應 App Store 的 `appAccountToken`),後台用它擋下被別人領走的購買。


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
| App Store Server Notifications | App Store Connect → App 資訊 → App Store 伺服器通知 | 兩個環境各設一次(Apple 允許同一個網址,後台依 `data.environment` 區分):App Store Connect → 我的 App → App 資訊 → App Store 伺服器通知,<br>1. **Production 伺服器網址**填 `https://<後台網址>/v1/app-store/notifications`,版本選 **Version 2**;<br>2. **Sandbox 伺服器網址**填同一個網址,版本選 **Version 2**;<br>3. 填好後用 App Store Server API 的「Request a Test Notification」確認(回 TEST 通知,後台回 200)。通知來源 IP 是 `17.0.0.0/8`;後台回 200 才算收到,非 2xx 時 Production 會重送(Sandbox 不重送) |
| App Store Server API 金鑰 Key ID 與 Issuer ID | `wrangler.jsonc` 的 `APP_STORE_API_KEY_ID`、`APP_STORE_API_ISSUER_ID`(已填 `5UCMXA2DN8` 與 Issuer ID) | App Store Connect → 使用者與存取權限 → 整合 → App 內購買項目 → 產生金鑰;Key ID 在金鑰列表、Issuer ID 在頁面上方。不是 secret,可進 repo(公開 repo 只放識別碼) |
| Google Play 串接 | `wrangler.jsonc` 的 `GOOGLE_PLAY_*` 與 secret `GOOGLE_PLAY_SERVICE_ACCOUNT_KEY` | 步驟見「Google Play 串接」的設定步驟;金鑰沒設定時綁定回 502 `store_unavailable`、通知回 503 |
| App Store Server API 私鑰 | secret `APP_STORE_API_KEY` | 上一步下載的 `.p8` 全文(只能下載一次):`npx wrangler secret put APP_STORE_API_KEY < SubscriptionKey_XXXX.p8`。這把是 In-App Purchase 金鑰,跟 APNs、Sign in with Apple 的金鑰不同;選用(不在 `secrets.required`,可先不設就部署,型別宣告在 `src/env.d.ts`);缺或失效,綁定不查證(記 `lookup_unreachable`),不影響購買 |
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

使用 App Store Server API(綁定時查證、之後訂閱轉移改 appAccountToken),需要 In-App Purchase 金鑰(`.p8`):識別碼放 `wrangler.jsonc`,私鑰只放 secret `APP_STORE_API_KEY`,不進 repo。這把金鑰沒有設定時,權限仍靠 app 提交的簽章交易與 App Store Server Notifications。
