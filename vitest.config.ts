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
  return {
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
      // wrangler 會檢查 wrangler.jsonc 宣告的必要 secrets;測試值放進 process.env,免得每次都警告。
      process.env.APPLE_PRIVATE_KEY = keys.applePrivateKey;
      process.env.ACCESS_TOKEN_SECRET = accessTokenSecret;
      process.env.APNS_PRIVATE_KEY = keys.apnsPrivateKey;
      return {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "migrations")),
            APPLE_KEY_ID: "TESTKEY123",
            GOOGLE_CLIENT_IDS: "test-ios.apps.googleusercontent.com,test-android.apps.googleusercontent.com",
            APPLE_PRIVATE_KEY: keys.applePrivateKey,
            ACCESS_TOKEN_SECRET: accessTokenSecret,
            TEST_APPLE_ID_TOKEN_KEY: keys.appleIdTokenKey,
            TEST_GOOGLE_ID_TOKEN_KEY: keys.googleIdTokenKey,
            TEST_APPLE_CLIENT_SECRET_PUBLIC_JWK: keys.applePublicJwk,
            APPLE_ROOT_CERTIFICATES: appStoreRoot.certificate,
            APP_STORE_APP_APPLE_ID: "1234567890",
            TEST_APP_STORE_ROOT_KEY: appStoreRoot.privateKey,
            APNS_KEY_ID: "TESTAPNS12",
            APNS_PRIVATE_KEY: keys.apnsPrivateKey,
            TEST_APNS_PUBLIC_JWK: keys.apnsPublicJwk,
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});
