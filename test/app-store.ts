import { env } from "cloudflare:workers";
import { CompactSign } from "jose";
import { api } from "./fakes";
import { base64, makeCertificate, OID, type CertificateOptions, type TestCertificate } from "./certificates";

/// 假的 App Store:用測試根憑證(vitest.config.ts 產生，後台的 `APPLE_ROOT_CERTIFICATES` 信任它)
/// 簽發中繼與葉憑證，再簽 StoreKit 交易與 App Store Server Notifications v2 的 JWS。

export const MONTHLY = "com.raychiu.purrdr.plus.monthly";
export const YEARLY = "com.raychiu.purrdr.plus.yearly";
export const DAY = 86_400_000;

export type Chain = { leaf: TestCertificate; intermediate: TestCertificate; root: { der: Uint8Array; privateKey: CryptoKey; subject: string } };

let trusted: Promise<Chain> | undefined;

async function trustedRoot() {
  const der = Uint8Array.from(atob(env.APPLE_ROOT_CERTIFICATES), (c) => c.charCodeAt(0));
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    JSON.parse(env.TEST_APP_STORE_ROOT_KEY) as JsonWebKey,
    { name: "ECDSA", namedCurve: "P-384" },
    false,
    ["sign"],
  );
  return { der, privateKey, subject: "Purrdr Test Root CA" };
}

export type ChainOptions = {
  /** 換掉根憑證(例如不受信任的自簽根)。 */
  root?: Chain["root"];
  intermediate?: Partial<CertificateOptions>;
  leaf?: Partial<CertificateOptions>;
};

/// 依信任的根簽一條新的鏈;選項可以做出各種壞掉的鏈。
export async function makeChain(options: ChainOptions = {}): Promise<Chain> {
  const root = options.root ?? (await trustedRoot());
  const intermediate = await makeCertificate({
    subject: "Purrdr Test WWDR",
    curve: "P-384",
    ca: true,
    markers: [OID.appleIntermediate],
    issuer: root,
    ...options.intermediate,
  });
  const leaf = await makeCertificate({
    subject: "Purrdr Test StoreKit Signing",
    curve: "P-256",
    markers: [OID.appleLeaf],
    issuer: intermediate,
    ...options.leaf,
  });
  return { leaf, intermediate, root };
}

/// 正常的鏈(整個測試執行共用一條)。
export function trustedChain(): Promise<Chain> {
  trusted ??= makeChain();
  return trusted;
}

/// 自己產生的根(後台不信任)。
export async function untrustedRoot(): Promise<Chain["root"]> {
  const root = await makeCertificate({ subject: "Purrdr Test Root CA", curve: "P-384", ca: true });
  return root;
}

export async function signJws(payload: unknown, chain?: Chain, signWith?: CryptoKey): Promise<string> {
  const { leaf, intermediate, root } = chain ?? (await trustedChain());
  return new CompactSign(new TextEncoder().encode(JSON.stringify(payload)))
    .setProtectedHeader({ alg: "ES256", x5c: [base64(leaf.der), base64(intermediate.der), base64(root.der)] })
    .sign(signWith ?? leaf.privateKey);
}

export type TransactionOptions = {
  transactionId?: string;
  originalTransactionId?: string;
  productId?: string;
  appAccountToken?: string | null;
  purchaseDate?: number;
  expiresDate?: number;
  revocationDate?: number;
  signedDate?: number;
  environment?: string;
  bundleId?: string;
  type?: string;
  offerType?: number;
};

/// StoreKit 2 的 JWSTransactionDecodedPayload(只放後台用得到與幾個常見欄位)。
export function transaction(options: TransactionOptions = {}) {
  const now = Date.now();
  const purchaseDate = options.purchaseDate ?? now - DAY;
  return {
    transactionId: options.transactionId ?? "2000000000000001",
    originalTransactionId: options.originalTransactionId ?? "2000000000000001",
    webOrderLineItemId: "2000000000000099",
    bundleId: options.bundleId ?? "com.raychiu.purrdr",
    productId: options.productId ?? MONTHLY,
    subscriptionGroupIdentifier: "21500000",
    purchaseDate,
    originalPurchaseDate: purchaseDate,
    expiresDate: options.expiresDate ?? purchaseDate + 30 * DAY,
    quantity: 1,
    type: options.type ?? "Auto-Renewable Subscription",
    ...(options.appAccountToken === null ? {} : { appAccountToken: options.appAccountToken }),
    inAppOwnershipType: "PURCHASED",
    signedDate: options.signedDate ?? now,
    environment: options.environment ?? "Sandbox",
    transactionReason: "PURCHASE",
    storefront: "TWN",
    storefrontId: "143470",
    price: 150000,
    currency: "TWD",
    ...(options.revocationDate ? { revocationDate: options.revocationDate, revocationReason: 0 } : {}),
    ...(options.offerType ? { offerType: options.offerType } : {}),
  };
}

export type RenewalOptions = {
  originalTransactionId?: string;
  autoRenewStatus?: 0 | 1;
  gracePeriodExpiresDate?: number;
  signedDate?: number;
  environment?: string;
};

export function renewalInfo(options: RenewalOptions = {}) {
  return {
    originalTransactionId: options.originalTransactionId ?? "2000000000000001",
    autoRenewProductId: MONTHLY,
    productId: MONTHLY,
    autoRenewStatus: options.autoRenewStatus ?? 1,
    signedDate: options.signedDate ?? Date.now(),
    environment: options.environment ?? "Sandbox",
    ...(options.gracePeriodExpiresDate ? { gracePeriodExpiresDate: options.gracePeriodExpiresDate, isInBillingRetryPeriod: true } : {}),
  };
}

export type NotificationOptions = {
  notificationType: string;
  subtype?: string;
  transaction?: TransactionOptions;
  renewal?: RenewalOptions | null;
  environment?: string;
  bundleId?: string;
  appAppleId?: number;
  signedDate?: number;
  chain?: Chain;
};

/// App Store Server Notifications v2 的 signedPayload。
export async function notification(options: NotificationOptions): Promise<string> {
  const environment = options.environment ?? "Sandbox";
  const tx = transaction({ environment, ...options.transaction });
  const data = {
    appAppleId: options.appAppleId ?? Number(env.APP_STORE_APP_APPLE_ID),
    bundleId: options.bundleId ?? "com.raychiu.purrdr",
    bundleVersion: "1",
    environment,
    signedTransactionInfo: await signJws(tx, options.chain),
    ...(options.renewal === null
      ? {}
      : { signedRenewalInfo: await signJws(renewalInfo({ environment, originalTransactionId: tx.originalTransactionId, ...options.renewal }), options.chain) }),
    status: 1,
  };
  return signJws(
    {
      notificationType: options.notificationType,
      ...(options.subtype ? { subtype: options.subtype } : {}),
      notificationUUID: crypto.randomUUID(),
      version: "2.0",
      signedDate: options.signedDate ?? Date.now(),
      data,
    },
    options.chain,
  );
}

// MARK: - 對後台的請求

export async function submitTransaction(accessToken: string, options: TransactionOptions = {}, chain?: Chain) {
  return api("POST", "/v1/members/me/subscription/app-store", {
    accessToken,
    body: { signedTransaction: await signJws(transaction(options), chain) },
  });
}

export async function sendNotification(options: NotificationOptions) {
  return api("POST", "/v1/app-store/notifications", { body: { signedPayload: await notification(options) } });
}

export async function subscriptionOf(accessToken: string) {
  return api("GET", "/v1/members/me/subscription", { accessToken });
}
