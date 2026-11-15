// 只有測試環境才有的 binding(vitest.config.ts 注入)。
declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
    /** 假 Apple 簽 ID token 用的 RSA 私鑰(JWK JSON)。 */
    TEST_APPLE_ID_TOKEN_KEY: string;
    /** 假 Google 簽 ID token 用的 RSA 私鑰(JWK JSON)。 */
    TEST_GOOGLE_ID_TOKEN_KEY: string;
    /** 測試用 Sign in with Apple 私鑰的公鑰(JWK JSON),假 Apple token 端點用來驗 client secret。 */
    TEST_APPLE_CLIENT_SECRET_PUBLIC_JWK: string;
    /** 測試用 App Store 根憑證的私鑰(JWK JSON);公開的憑證在 `APPLE_ROOT_CERTIFICATES`。 */
    TEST_APP_STORE_ROOT_KEY: string;
    /** 測試用 APNs 驗證金鑰的公鑰(JWK JSON),假 APNs 端點用來驗 provider token。 */
    TEST_APNS_PUBLIC_JWK: string;
  }
}
