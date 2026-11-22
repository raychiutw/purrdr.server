import { importPKCS8, SignJWT } from "jose";

/// Google Play Developer API 客戶端(#26):綁定與收到通知時查證訂閱、acknowledge 新購買。
///
/// 認證:服務帳戶 JWT(RS256,`iss` 是服務帳戶 email `GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL`、`scope` 是 androidpublisher、
/// `aud` 是 `https://oauth2.googleapis.com/token`、`exp` 不超過 `iat` + 1 小時)換 access token(`grant_type=jwt-bearer`),
/// 再帶 `Authorization: Bearer` 呼叫。私鑰是 secret `GOOGLE_PLAY_SERVICE_ACCOUNT_KEY`(下載的 JSON 金鑰檔全文,或只放 `private_key` 的 PEM)。
/// 每次呼叫都換一個新的 access token(綁定與通知的量很小,不做快取,省掉跨請求的狀態)。

/// Google 明確拒絕(400、404、410):purchase token 無效、查無此購買、或已超過過期後 60 天的查詢期限,重試沒有用。
export class GooglePlayApiError extends Error {
  constructor(readonly status: number) {
    super(`Google Play Developer API rejected the request (${status}).`);
  }
}

/// 暫時問不到 Google:沒設定、金鑰無效、連不上、逾時、429、5xx、401／403(服務帳戶沒授權,屬於設定錯誤)。呼叫端可以稍後重試。
export class GooglePlayApiUnavailable extends Error {}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";
const REQUEST_TIMEOUT_MS = 5000;
const ASSERTION_LIFETIME_SECONDS = 300;

/// Secret 可以是 JSON 金鑰檔全文或 PEM;回 PEM。
function privateKeyPem(secret: string): string {
  const trimmed = secret.trim();
  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as { private_key?: unknown };
    if (typeof parsed.private_key !== "string") {
      throw new Error("no private_key");
    }
    return parsed.private_key;
  }
  return trimmed;
}

function isConfigured(value: string | undefined): value is string {
  return typeof value === "string" && value !== "" && value !== "REPLACE_ME";
}

async function accessToken(env: Env): Promise<string> {
  if (!isConfigured(env.GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL) || !env.GOOGLE_PLAY_SERVICE_ACCOUNT_KEY) {
    throw new GooglePlayApiUnavailable("Google Play Developer API is not configured.");
  }
  let assertion: string;
  try {
    const key = await importPKCS8(privateKeyPem(env.GOOGLE_PLAY_SERVICE_ACCOUNT_KEY), "RS256");
    const now = Math.floor(Date.now() / 1000);
    assertion = await new SignJWT({ scope: SCOPE })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(env.GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL)
      .setAudience(TOKEN_URL)
      .setIssuedAt(now)
      .setExpirationTime(now + ASSERTION_LIFETIME_SECONDS)
      .sign(key);
  } catch {
    throw new GooglePlayApiUnavailable("Google Play service account key is invalid.");
  }
  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new GooglePlayApiUnavailable("Google OAuth is unreachable.");
  }
  if (!response.ok) {
    console.error(`Google OAuth rejected the service account assertion (${response.status}): check GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL and GOOGLE_PLAY_SERVICE_ACCOUNT_KEY.`);
    throw new GooglePlayApiUnavailable(`Google OAuth failed (${response.status}).`);
  }
  try {
    const body = (await response.json()) as { access_token?: unknown };
    if (typeof body.access_token === "string") {
      return body.access_token;
    }
  } catch {
    // 落到下面的 unavailable。
  }
  throw new GooglePlayApiUnavailable("Google OAuth returned an unexpected body.");
}

/// 送請求。2xx 回 Response;400、404、410 丟 GooglePlayApiError;其餘(含連不上)丟 GooglePlayApiUnavailable。
async function call(env: Env, method: string, path: string): Promise<Response> {
  if (!isConfigured(env.GOOGLE_PLAY_PACKAGE_NAME)) {
    throw new GooglePlayApiUnavailable("Google Play package name is not configured.");
  }
  const token = await accessToken(env);
  let response: Response;
  try {
    response = await fetch(`${API}/${encodeURIComponent(env.GOOGLE_PLAY_PACKAGE_NAME)}/${path}`, {
      method,
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new GooglePlayApiUnavailable("Google Play Developer API is unreachable.");
  }
  if (response.ok) {
    return response;
  }
  if (response.status === 400 || response.status === 404 || response.status === 410) {
    throw new GooglePlayApiError(response.status);
  }
  if (response.status === 401 || response.status === 403) {
    console.error(`Google Play Developer API denied the request (${response.status}): is the service account authorized in Play Console (View financial data)?`);
  }
  throw new GooglePlayApiUnavailable(`Google Play Developer API failed (${response.status}).`);
}

/// 後台用到的 `SubscriptionPurchaseV2` 欄位(已檢查型別)。
export type SubscriptionPurchase = {
  /** 例如 `SUBSCRIPTION_STATE_ACTIVE`。 */
  subscriptionState: string;
  acknowledged: boolean;
  /** 升降級、在 app 內重新訂閱時,被這筆取代的舊 purchase token。 */
  linkedPurchaseToken: string | null;
  testPurchase: boolean;
  /** 購買時帶的 `obfuscatedAccountId`(Android app 放會員 ID)。 */
  obfuscatedAccountId: string | null;
  startTime: number | null;
  productId: string;
  expiryTime: number;
  latestOrderId: string | null;
  autoRenewEnabled: boolean | null;
};

/// `GET purchases/subscriptionsv2/tokens/{token}`。token 無效、查無或超過查詢期限回 null;連不上或 Google 暫時有問題丟 GooglePlayApiUnavailable。
export async function getSubscriptionPurchase(env: Env, purchaseToken: string): Promise<SubscriptionPurchase | null> {
  let response: Response;
  try {
    response = await call(env, "GET", `purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`);
  } catch (error) {
    if (error instanceof GooglePlayApiError) {
      return null;
    }
    throw error;
  }
  let body: any;
  try {
    body = await response.json();
  } catch {
    throw new GooglePlayApiUnavailable("Google Play Developer API returned an unreadable body.");
  }
  const item = Array.isArray(body?.lineItems) ? body.lineItems[0] : undefined;
  const expiryTime = typeof item?.expiryTime === "string" ? Date.parse(item.expiryTime) : Number.NaN;
  if (typeof body?.subscriptionState !== "string" || typeof item?.productId !== "string" || Number.isNaN(expiryTime)) {
    throw new GooglePlayApiUnavailable("Google Play Developer API returned an unexpected body.");
  }
  const startTime = typeof body.startTime === "string" ? Date.parse(body.startTime) : Number.NaN;
  const obfuscated = body.externalAccountIdentifiers?.obfuscatedExternalAccountId;
  return {
    subscriptionState: body.subscriptionState,
    acknowledged: body.acknowledgementState === "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
    linkedPurchaseToken: typeof body.linkedPurchaseToken === "string" && body.linkedPurchaseToken !== "" ? body.linkedPurchaseToken : null,
    testPurchase: body.testPurchase !== undefined && body.testPurchase !== null,
    obfuscatedAccountId: typeof obfuscated === "string" && obfuscated !== "" ? obfuscated : null,
    startTime: Number.isNaN(startTime) ? null : startTime,
    productId: item.productId,
    expiryTime,
    latestOrderId: typeof item.latestSuccessfulOrderId === "string" ? item.latestSuccessfulOrderId : null,
    autoRenewEnabled: typeof item.autoRenewingPlan?.autoRenewEnabled === "boolean" ? item.autoRenewingPlan.autoRenewEnabled : null,
  };
}

/// `POST purchases/subscriptions/{productId}/tokens/{token}:acknowledge`。新購買要在 3 天內 acknowledge,否則 Google 自動退款並撤銷。
/// 路徑仍帶 productId(官方文件寫 2025-05-21 起 subscriptionId 不是必要,但範本路徑還在,帶著最保險)。
/// Google 拒絕丟 GooglePlayApiError(例如已經 acknowledge 過);暫時不可用丟 GooglePlayApiUnavailable。
export async function acknowledgePurchase(env: Env, productId: string, purchaseToken: string): Promise<void> {
  await call(env, "POST", `purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`);
}
