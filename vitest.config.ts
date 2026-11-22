import { generateKeyPairSync, randomBytes } from "node:crypto";
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { base64, makeCertificate } from "./test/certificates.ts";

/// 測試用金鑰：每次執行重新產生，絕不使用真的 Apple／Google 金鑰。
/// - Apple 與 Google 的 ID token 用各自的 RSA 金鑰簽，測試再假裝成兩家的 JWKS 端點提供公鑰。
/// - Sign in with Apple 的 .p8 私鑰換成自產的 P-256 金鑰;假的 Apple token 端點用公鑰驗證 client secret。
/// - APNs 的 .p8 也換成自產的 P-256 金鑰;假的 APNs 端點用公鑰驗證 provider token。
/// App Store 簽交易用的測試根憑證(取代 Apple Root CA - G3);中繼與葉憑證由測試自己用這把根簽。
async function testAppStoreRoot() {
  const root = await makeCertificate({ subject: "Purrdr Test Root CA", curve: "P-384", ca: true });
  return { certificate: base64(root.der), privateKey: JSON.stringify(await crypto.subtle.exportKey("jwk", root.privateKey)) };
}

function testKeys() {
  const rsa = () => generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "jwk" });
  const p8 = generateKeyPairSync("ec", { namedCurve: "P-256" });
  // APNs 驗證金鑰(.p8)的替身;假 APNs 端點用公鑰驗證 provider token。
  const apns = generateKeyPairSync("ec", { namedCurve: "P-256" });
  // App Store Server API 的 In-App Purchase 金鑰(.p8)的替身;假 App Store Server API 用公鑰驗 JWT。
  const appStoreApi = generateKeyPairSync("ec", { namedCurve: "P-256" });
  // Google Play Developer API 服務帳戶金鑰的替身(RSA,RS256);假 Google token 端點用公鑰驗 assertion。
  const googlePlay = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    googlePlayPrivateKey: googlePlay.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    googlePlayPublicJwk: JSON.stringify(googlePlay.publicKey.export({ format: "jwk" })),
    appStoreApiPrivateKey: appStoreApi.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    appStoreApiPublicJwk: JSON.stringify(appStoreApi.publicKey.export({ format: "jwk" })),
    appleIdTokenKey: JSON.stringify(rsa()),
    googleIdTokenKey: JSON.stringify(rsa()),
    applePrivateKey: p8.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    applePublicJwk: JSON.stringify(p8.publicKey.export({ format: "jwk" })),
    apnsPrivateKey: apns.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    apnsPublicJwk: JSON.stringify(apns.publicKey.export({ format: "jwk" })),
  };
}

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const keys = testKeys();
      const appStoreRoot = await testAppStoreRoot();
      const accessTokenSecret = randomBytes(32).toString("base64url");
      const appleTokenEncryptionKey = randomBytes(32).toString("base64");
      // wrangler 會檢查 wrangler.jsonc 宣告的必要 secrets;測試值放進 process.env,免得每次都警告。
      process.env.APPLE_PRIVATE_KEY = keys.applePrivateKey;
      process.env.ACCESS_TOKEN_SECRET = accessTokenSecret;
      process.env.APNS_PRIVATE_KEY = keys.apnsPrivateKey;
      process.env.APP_STORE_API_KEY = keys.appStoreApiPrivateKey;
      process.env.APPLE_TOKEN_ENCRYPTION_KEY = appleTokenEncryptionKey;
      process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_KEY = keys.googlePlayPrivateKey;
      return {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "migrations")),
            APPLE_KEY_ID: "TESTKEY123",
            GOOGLE_CLIENT_IDS: "test-ios.apps.googleusercontent.com,test-android.apps.googleusercontent.com",
            APPLE_PRIVATE_KEY: keys.applePrivateKey,
            ACCESS_TOKEN_SECRET: accessTokenSecret,
            APPLE_TOKEN_ENCRYPTION_KEY: appleTokenEncryptionKey,
            TEST_APPLE_ID_TOKEN_KEY: keys.appleIdTokenKey,
            TEST_GOOGLE_ID_TOKEN_KEY: keys.googleIdTokenKey,
            TEST_APPLE_CLIENT_SECRET_PUBLIC_JWK: keys.applePublicJwk,
            APPLE_ROOT_CERTIFICATES: appStoreRoot.certificate,
            APP_STORE_APP_APPLE_ID: "1234567890",
            TEST_APP_STORE_ROOT_KEY: appStoreRoot.privateKey,
            APNS_KEY_ID: "TESTAPNS12",
            APNS_PRIVATE_KEY: keys.apnsPrivateKey,
            TEST_APNS_PUBLIC_JWK: keys.apnsPublicJwk,
            APP_STORE_API_KEY_ID: "TESTAPI123",
            APP_STORE_API_ISSUER_ID: "11111111-2222-3333-4444-555555555555",
            APP_STORE_API_KEY: keys.appStoreApiPrivateKey,
            TEST_APP_STORE_API_PUBLIC_JWK: keys.appStoreApiPublicJwk,
            GOOGLE_PLAY_PACKAGE_NAME: "com.raychiu.purrdr.test",
            GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL: "play-api@purrdr-test.iam.gserviceaccount.com",
            GOOGLE_PLAY_PRODUCT_IDS: "plus.monthly,plus.yearly",
            GOOGLE_PLAY_PUBSUB_SERVICE_ACCOUNT_EMAIL: "rtdn-push@purrdr-test.iam.gserviceaccount.com",
            GOOGLE_PLAY_PUBSUB_AUDIENCE: "https://backend.test/v1/google-play/notifications",
            GOOGLE_PLAY_SERVICE_ACCOUNT_KEY: keys.googlePlayPrivateKey,
            TEST_GOOGLE_PLAY_PUBLIC_JWK: keys.googlePlayPublicJwk,
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
    // 每個測試都要簽 JWT、跑 D1 與假 APNs,機器忙時偶爾超過預設 5 秒。
    testTimeout: 20_000,
    // 本機的 agent worktree 會帶一份測試副本，不要一起跑。
    exclude: ["**/node_modules/**", ".claude/**"],
  },
});
