import { importPKCS8, SignJWT } from "jose";

/// App Store Server API 客戶端(#25):綁定時查證訂閱狀態、之後轉移訂閱(#27)時改 appAccountToken。
///
/// 認證:ES256 JWT,header `kid` 是 In-App Purchase 金鑰的 Key ID(`APP_STORE_API_KEY_ID`),
/// payload `iss` 是 Issuer ID(`APP_STORE_API_ISSUER_ID`)、`aud` 是 `appstoreconnect-v1`、`bid` 是 bundle id、
/// `exp` 比 `iat` 晚不超過 60 分鐘。私鑰是 secret `APP_STORE_API_KEY`(.p8 的 PEM)。
/// 每個請求簽一個新的 JWT(5 分鐘有效)。
///
/// 主機依交易的 `environment` 選:Production 是 `api.storekit.apple.com`、Sandbox 是 `api.storekit-sandbox.apple.com`。

export type AppStoreEnvironment = "Production" | "Sandbox";

/// Apple 明確拒絕(400、404):請求本身有問題或查無此交易,重試沒有用。
export class AppStoreApiError extends Error {
  constructor(
    readonly status: number,
    /** Apple 回應 body 的 `errorCode`(例如 4040010 TransactionIdNotFoundError);沒有時是 null。 */
    readonly errorCode: number | null,
    message: string,
  ) {
    super(message);
  }
}

/// 暫時問不到 Apple:沒設定金鑰、連不上、逾時、429、5xx、或 JWT 被拒(401,通常是金鑰設定錯)。呼叫端可以稍後重試。
export class AppStoreApiUnavailable extends Error {}

const HOSTS: Record<AppStoreEnvironment, string> = {
  Production: "https://api.storekit.apple.com",
  Sandbox: "https://api.storekit-sandbox.apple.com",
};

const REQUEST_TIMEOUT_MS = 5000;
const TOKEN_LIFETIME_SECONDS = 300;

async function bearerToken(env: Env): Promise<string> {
  if (!env.APP_STORE_API_KEY || !env.APP_STORE_API_KEY_ID || !env.APP_STORE_API_ISSUER_ID) {
    throw new AppStoreApiUnavailable("App Store Server API is not configured.");
  }
  try {
    const key = await importPKCS8(env.APP_STORE_API_KEY, "ES256");
    const now = Math.floor(Date.now() / 1000);
    return await new SignJWT({ bid: env.APPLE_CLIENT_ID })
      .setProtectedHeader({ alg: "ES256", kid: env.APP_STORE_API_KEY_ID, typ: "JWT" })
      .setIssuer(env.APP_STORE_API_ISSUER_ID)
      .setAudience("appstoreconnect-v1")
      .setIssuedAt(now)
      .setExpirationTime(now + TOKEN_LIFETIME_SECONDS)
      .sign(key);
  } catch {
    throw new AppStoreApiUnavailable("App Store Server API key is invalid.");
  }
}

async function errorCodeOf(response: Response): Promise<number | null> {
  try {
    const body = (await response.json()) as { errorCode?: unknown };
    return typeof body.errorCode === "number" ? body.errorCode : null;
  } catch {
    return null;
  }
}

/// 送請求。2xx 回 Response;400、404 丟 AppStoreApiError;其餘(含連不上)丟 AppStoreApiUnavailable。
async function call(env: Env, method: string, environment: AppStoreEnvironment, path: string, body?: unknown): Promise<Response> {
  const token = await bearerToken(env);
  let response: Response;
  try {
    response = await fetch(`${HOSTS[environment]}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new AppStoreApiUnavailable("App Store Server API is unreachable.");
  }
  if (response.ok) {
    return response;
  }
  if (response.status === 400 || response.status === 404) {
    throw new AppStoreApiError(response.status, await errorCodeOf(response), `App Store Server API rejected the request (${response.status}).`);
  }
  if (response.status === 401) {
    console.error("App Store Server API rejected our JWT (401): check APP_STORE_API_KEY, APP_STORE_API_KEY_ID and APP_STORE_API_ISSUER_ID.");
  }
  throw new AppStoreApiUnavailable(`App Store Server API failed (${response.status}).`);
}

/// Get All Subscription Statuses 裡這筆訂閱的最新交易(JWS 還沒驗章,呼叫端驗)。
export type SubscriptionStatusResult = {
  /** Apple 的訂閱狀態:1 active、2 expired、3 billing retry、4 billing grace period、5 revoked。 */
  status: number;
  signedTransactionInfo: string;
  signedRenewalInfo?: string;
};

/// `GET /inApps/v1/subscriptions/{originalTransactionId}`。查無此訂閱(404、或回應裡沒有這筆)回 null;
/// 連不上或 Apple 暫時有問題丟 AppStoreApiUnavailable。
export async function getSubscriptionStatus(env: Env, originalTransactionId: string, environment: AppStoreEnvironment): Promise<SubscriptionStatusResult | null> {
  let response: Response;
  try {
    response = await call(env, "GET", environment, `/inApps/v1/subscriptions/${encodeURIComponent(originalTransactionId)}`);
  } catch (error) {
    if (error instanceof AppStoreApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
  let body: { data?: { lastTransactions?: { originalTransactionId?: unknown; status?: unknown; signedTransactionInfo?: unknown; signedRenewalInfo?: unknown }[] }[] };
  try {
    body = await response.json();
  } catch {
    throw new AppStoreApiUnavailable("App Store Server API returned an unreadable body.");
  }
  for (const group of body.data ?? []) {
    for (const item of group.lastTransactions ?? []) {
      if (item.originalTransactionId === originalTransactionId) {
        if (typeof item.status !== "number" || typeof item.signedTransactionInfo !== "string") {
          throw new AppStoreApiUnavailable("App Store Server API returned an unexpected body.");
        }
        return {
          status: item.status,
          signedTransactionInfo: item.signedTransactionInfo,
          ...(typeof item.signedRenewalInfo === "string" ? { signedRenewalInfo: item.signedRenewalInfo } : {}),
        };
      }
    }
  }
  return null;
}

/// `PUT /inApps/v1/transactions/{originalTransactionId}/appAccountToken`:把訂閱的 appAccountToken 設成會員 ID(UUID)。
/// 給訂閱轉移(#27)用:套用到目前這一期與之後的續訂,已有 token 的會被覆寫;不支援家人共享的交易。
/// Apple 拒絕丟 AppStoreApiError(`errorCode` 是 Apple 的錯誤碼);暫時不可用丟 AppStoreApiUnavailable,可以重試。
export async function setAppAccountToken(env: Env, originalTransactionId: string, memberId: string, environment: AppStoreEnvironment): Promise<void> {
  await call(env, "PUT", environment, `/inApps/v1/transactions/${encodeURIComponent(originalTransactionId)}/appAccountToken`, {
    appAccountToken: memberId,
  });
}
