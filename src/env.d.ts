// 選用的 secret:wrangler types 只會替 secrets.required 與 vars 產生型別,所以這裡補宣告。
// 沒設定時 Google Play 綁定回 502 store_unavailable、通知回 503(Android 上線前可以不設)。
interface Env {
  /** Google Play Developer API 服務帳戶金鑰(JSON 金鑰檔全文,或只放 private_key 的 PEM)。 */
  GOOGLE_PLAY_SERVICE_ACCOUNT_KEY?: string;
}
