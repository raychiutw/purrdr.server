import { importPKCS8, SignJWT } from "jose";
import { ApiError } from "./http";

/// Sign in with Apple 的 REST API:用 authorization code 換 refresh token,以及刪除會員時撤銷權杖。
/// https://developer.apple.com/documentation/sign_in_with_apple/generate_and_validate_tokens
/// https://developer.apple.com/documentation/sign_in_with_apple/revoke_tokens

const APPLE_BASE = "https://appleid.apple.com";

/// client secret:以 Sign in with Apple 私鑰(.p8)簽的 ES256 JWT,效期最長 6 個月;這裡每次現簽、5 分鐘。
async function clientSecret(env: Env): Promise<string> {
  const key = await importPKCS8(env.APPLE_PRIVATE_KEY, "ES256");
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: env.APPLE_KEY_ID })
    .setIssuer(env.APPLE_TEAM_ID)
    .setSubject(env.APPLE_CLIENT_ID)
    .setAudience(APPLE_BASE)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key);
}

async function post(path: string, form: Record<string, string>): Promise<Response> {
  try {
    return await fetch(`${APPLE_BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form),
    });
  } catch {
    throw new ApiError(502, "provider_unavailable", "Couldn't reach Apple.");
  }
}

/// 用 app 拿到的 authorization code(5 分鐘內、只能用一次)換 refresh token。
export async function exchangeAuthorizationCode(env: Env, code: string): Promise<string> {
  const response = await post("/auth/token", {
    client_id: env.APPLE_CLIENT_ID,
    client_secret: await clientSecret(env),
    code,
    grant_type: "authorization_code",
  });
  if (response.status === 400) {
    throw new ApiError(401, "invalid_id_token", "The Sign in with Apple authorization code is invalid or expired.");
  }
  if (!response.ok) throw new ApiError(502, "provider_unavailable", "Apple couldn't complete sign-in.");
  const body = (await response.json()) as { refresh_token?: unknown };
  if (typeof body.refresh_token !== "string") throw new ApiError(502, "provider_unavailable", "Apple didn't return a token.");
  return body.refresh_token;
}

/// 撤銷 Sign in with Apple 的 refresh token(刪除會員時必做)。
///
/// Apple 回 400 表示權杖本來就無效(例如使用者已在 Apple ID 設定停用),視同已撤銷。
/// 連不上或 5xx 回傳 false,由呼叫端決定要不要中止。
export async function revokeAppleToken(env: Env, token: string): Promise<boolean> {
  try {
    const response = await post("/auth/revoke", {
      client_id: env.APPLE_CLIENT_ID,
      client_secret: await clientSecret(env),
      token,
      token_type_hint: "refresh_token",
    });
    return response.ok || response.status === 400;
  } catch {
    return false;
  }
}
