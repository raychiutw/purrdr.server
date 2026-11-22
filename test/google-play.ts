import { api, identityProviders, pubSubToken, type PubSubTokenOptions } from "./fakes";

/// Google Play 的測試輔助:組 SubscriptionPurchaseV2、讓假 Developer API 回它、送 RTDN。

export const PLAY_MONTHLY = "plus.monthly";
export const PLAY_YEARLY = "plus.yearly";
export const DAY = 86_400_000;
export const PACKAGE = "com.raychiu.purrdr.test";

export type PurchaseOptions = {
  subscriptionState?: string;
  productId?: string;
  expiryTime?: number;
  acknowledged?: boolean;
  linkedPurchaseToken?: string;
  testPurchase?: boolean;
  autoRenewEnabled?: boolean;
  obfuscatedAccountId?: string;
  orderId?: string;
};

/// Google Play Developer API 的 SubscriptionPurchaseV2(只放後台用到的欄位)。
export function purchase(options: PurchaseOptions = {}) {
  return {
    kind: "androidpublisher#subscriptionPurchaseV2",
    startTime: new Date(Date.now() - 3 * DAY).toISOString(),
    subscriptionState: options.subscriptionState ?? "SUBSCRIPTION_STATE_ACTIVE",
    acknowledgementState: options.acknowledged === false ? "ACKNOWLEDGEMENT_STATE_PENDING" : "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
    ...(options.linkedPurchaseToken ? { linkedPurchaseToken: options.linkedPurchaseToken } : {}),
    ...(options.testPurchase ? { testPurchase: {} } : {}),
    ...(options.obfuscatedAccountId ? { externalAccountIdentifiers: { obfuscatedExternalAccountId: options.obfuscatedAccountId } } : {}),
    lineItems: [
      {
        productId: options.productId ?? PLAY_MONTHLY,
        expiryTime: new Date(options.expiryTime ?? Date.now() + 29 * DAY).toISOString(),
        latestSuccessfulOrderId: options.orderId ?? "GPA.1234-5678-9012-34567",
        autoRenewingPlan: { autoRenewEnabled: options.autoRenewEnabled ?? true },
      },
    ],
  };
}

/// 讓假 Developer API 對這些 purchase token 回對應的訂閱(其他 token 回 404);acknowledge 回 204。
/// 回傳的物件可以事後改(模擬 Google 那邊狀態變了)。
export function serveGoogle(purchases: Record<string, ReturnType<typeof purchase>>) {
  identityProviders.googlePlayHandler = (call) => {
    const prefix = `/androidpublisher/v3/applications/${PACKAGE}/purchases/`;
    const rest = call.path.startsWith(prefix) ? call.path.slice(prefix.length) : "";
    const get = rest.match(/^subscriptionsv2\/tokens\/([^/:]+)$/);
    if (call.method === "GET" && get) {
      const found = purchases[decodeURIComponent(get[1] as string)];
      return found ? { status: 200, body: found } : { status: 404, body: { error: { code: 404 } } };
    }
    if (call.method === "POST" && /^subscriptions\/[^/]+\/tokens\/[^/:]+:acknowledge$/.test(rest)) {
      return { status: 204 };
    }
    return { status: 500 };
  };
  return purchases;
}

export function lookups() {
  return identityProviders.googlePlayCalls.filter((call) => call.method === "GET");
}

export function acknowledgements() {
  return identityProviders.googlePlayCalls.filter((call) => call.method === "POST");
}

export function bindGoogle(accessToken: string, purchaseToken: string, productId = PLAY_MONTHLY) {
  return api("POST", "/v1/members/me/subscription/google-play", { accessToken, body: { purchaseToken, productId } });
}

export type Rtdn = { type: number; token: string } | { voidedToken: string } | { test: true } | { raw: unknown };

/// 送一則 Pub/Sub push(預設帶正確的 OIDC token)。
export async function sendRtdn(rtdn: Rtdn, options: { messageId?: string; auth?: PubSubTokenOptions | null; packageName?: string } = {}) {
  const notification: Record<string, unknown> = { version: "1.0", packageName: options.packageName ?? PACKAGE, eventTimeMillis: `${Date.now()}` };
  if ("type" in rtdn) {
    notification.subscriptionNotification = { version: "1.0", notificationType: rtdn.type, purchaseToken: rtdn.token };
  } else if ("voidedToken" in rtdn) {
    notification.voidedPurchaseNotification = { purchaseToken: rtdn.voidedToken, orderId: "GPA.1", productType: 1, refundType: 1 };
  } else if ("test" in rtdn) {
    notification.testNotification = { version: "1.0" };
  }
  const data = "raw" in rtdn ? rtdn.raw : notification;
  const headers: Record<string, string> = {};
  if (options.auth !== null) {
    headers.authorization = `Bearer ${await pubSubToken(options.auth ?? {})}`;
  }
  return api("POST", "/v1/google-play/notifications", {
    headers,
    body: {
      message: { data: btoa(JSON.stringify(data)), messageId: options.messageId ?? crypto.randomUUID(), publishTime: new Date().toISOString() },
      subscription: "projects/purrdr-test/subscriptions/rtdn-push",
    },
  });
}
