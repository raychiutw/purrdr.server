import { env, exports } from "cloudflare:workers";
import { importJWK, jwtVerify, SignJWT, type JWK } from "jose";
import { vi } from "vitest";

/// 假的 Apple 與 Google:簽 ID token,並接手後台對兩家的 HTTP 請求(JWKS、Apple token／revoke 端點)。
/// 後台程式走的是正式的 fetch 路徑，只是 global fetch 被換成這裡的路由，不連網路。

const APPLE_KID = "test-apple-kid";
const GOOGLE_KID = "test-google-kid";

export type AppleTokenCall = { code: string; clientSecretValid: boolean; clientId: string };
export type AppleRevokeCall = { token: string; tokenTypeHint: string | null; clientSecretValid: boolean };

/// 送到假 APNs 的一則推播。
export type ApnsCall = {
  /** `production` = api.push.apple.com、`sandbox` = api.sandbox.push.apple.com。 */
  environment: "production" | "sandbox";
  deviceToken: string;
  headers: Record<string, string>;
  /** provider token(ES256 JWT)用測試金鑰的公鑰驗得過、kid 與 iss 正確。 */
  providerTokenValid: boolean;
  payload: any;
};

/// 假 APNs 的回應:200 成功，否則帶 Apple 的 reason(例如 410 `Unregistered`、400 `BadDeviceToken`)。
export type ApnsReply = { status: number; reason?: string };

const APNS_ORIGINS: Record<string, ApnsCall["environment"]> = {
  "https://api.push.apple.com": "production",
  "https://api.sandbox.push.apple.com": "sandbox",
};

class IdentityProviders {
  appleTokenCalls: AppleTokenCall[] = [];
  appleRevokeCalls: AppleRevokeCall[] = [];
  /** Apple revoke 端點回的狀態碼。 */
  appleRevokeStatus = 200;
  /** Apple token 端點回的狀態碼(400 = invalid_grant)。 */
  appleTokenStatus = 200;
  /** 假 APNs 收到的推播。 */
  apnsCalls: ApnsCall[] = [];
  /** 假 APNs 依序回的結果;用完之後一律 200。 */
  apnsReplies: ApnsReply[] = [];
  private spy: ReturnType<typeof vi.spyOn> | undefined;

  install() {
    this.appleTokenCalls = [];
    this.appleRevokeCalls = [];
    this.appleRevokeStatus = 200;
    this.appleTokenStatus = 200;
    this.apnsCalls = [];
    this.apnsReplies = [];
    this.spy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => this.route(new Request(input, init)));
  }

  uninstall() {
    this.spy?.mockRestore();
  }

  private async route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const route = `${request.method} ${url.origin}${url.pathname}`;
    const apnsEnvironment = APNS_ORIGINS[url.origin];
    if (apnsEnvironment && request.method === "POST" && url.pathname.startsWith("/3/device/")) {
      return this.apns(request, apnsEnvironment, url.pathname.slice("/3/device/".length));
    }
    switch (route) {
      case "GET https://appleid.apple.com/auth/keys":
        return Response.json({ keys: [publicJwk(env.TEST_APPLE_ID_TOKEN_KEY, APPLE_KID)] });
      case "GET https://www.googleapis.com/oauth2/v3/certs":
        return Response.json({ keys: [publicJwk(env.TEST_GOOGLE_ID_TOKEN_KEY, GOOGLE_KID)] });
      case "POST https://appleid.apple.com/auth/token": {
        const form = new URLSearchParams(new TextDecoder().decode(await request.arrayBuffer()));
        const code = form.get("code") ?? "";
        const clientId = form.get("client_id") ?? "";
        const clientSecretValid = await verifyClientSecret(form.get("client_secret"), clientId);
        this.appleTokenCalls.push({ code, clientSecretValid, clientId });
        if (!clientSecretValid) return Response.json({ error: "invalid_client" }, { status: 400 });
        if (this.appleTokenStatus !== 200 || form.get("grant_type") !== "authorization_code") {
          return Response.json({ error: "invalid_grant" }, { status: this.appleTokenStatus === 200 ? 400 : this.appleTokenStatus });
        }
        return Response.json({
          access_token: "apple-access",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: `apple-refresh-for-${code}`,
          id_token: "unused",
        });
      }
      case "POST https://appleid.apple.com/auth/revoke": {
        const form = new URLSearchParams(new TextDecoder().decode(await request.arrayBuffer()));
        this.appleRevokeCalls.push({
          token: form.get("token") ?? "",
          tokenTypeHint: form.get("token_type_hint"),
          clientSecretValid: await verifyClientSecret(form.get("client_secret"), form.get("client_id") ?? ""),
        });
        return new Response(null, { status: this.appleRevokeStatus });
      }
      default:
        throw new TypeError(`測試沒有預期這個對外請求：${route}`);
    }
  }

  /// APNs provider API(HTTP/2 POST /3/device/<token>):驗 provider token、記錄 header 與 payload。
  private async apns(request: Request, environment: ApnsCall["environment"], deviceToken: string): Promise<Response> {
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => (headers[name] = value));
    const authorization = headers.authorization ?? "";
    this.apnsCalls.push({
      environment,
      deviceToken,
      headers,
      providerTokenValid: authorization.startsWith("bearer ") && (await verifyApnsProviderToken(authorization.slice("bearer ".length))),
      payload: await request.json(),
    });
    const reply = this.apnsReplies.shift() ?? { status: 200 };
    if (reply.status === 200) return new Response(null, { status: 200, headers: { "apns-id": crypto.randomUUID() } });
    return Response.json({ reason: reply.reason ?? "InternalServerError" }, { status: reply.status });
  }
}

export const identityProviders = new IdentityProviders();

/// APNs 的 provider token:ES256、kid 是 APNs Key ID、iss 是 Team ID、有 iat。
async function verifyApnsProviderToken(token: string): Promise<boolean> {
  try {
    const key = await importJWK(JSON.parse(env.TEST_APNS_PUBLIC_JWK) as JWK, "ES256");
    const { payload, protectedHeader } = await jwtVerify(token, key, { issuer: env.APPLE_TEAM_ID, algorithms: ["ES256"] });
    return protectedHeader.kid === env.APNS_KEY_ID && typeof payload.iat === "number";
  } catch {
    return false;
  }
}

function publicJwk(privateJson: string, kid: string): JWK {
  const { kty, n, e } = JSON.parse(privateJson) as JWK;
  return { kty, n, e, kid, alg: "RS256", use: "sig" };
}

/// Apple 的 client secret:ES256、kid 是 Key ID、iss 是 Team ID、sub 與 client_id 相同、aud 是 appleid。
async function verifyClientSecret(secret: string | null, clientId: string): Promise<boolean> {
  if (!secret) return false;
  try {
    const key = await importJWK(JSON.parse(env.TEST_APPLE_CLIENT_SECRET_PUBLIC_JWK) as JWK, "ES256");
    const { payload, protectedHeader } = await jwtVerify(secret, key, {
      audience: "https://appleid.apple.com",
      issuer: env.APPLE_TEAM_ID,
      subject: clientId,
      algorithms: ["ES256"],
    });
    return protectedHeader.kid === env.APPLE_KEY_ID && clientId === env.APPLE_CLIENT_ID && typeof payload.exp === "number";
  } catch {
    return false;
  }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type IdTokenOptions = {
  subject: string;
  email?: string;
  /** app 產生的原始 nonce。Apple 的 token 裡是它的 SHA-256(hex),Google 是原文。 */
  nonce?: string;
  audience?: string;
  issuer?: string;
  expiresIn?: string;
  /** 用另一把不是該家公布的金鑰簽(偽造)。 */
  forged?: boolean;
};

export async function appleIdToken(options: IdTokenOptions): Promise<string> {
  const nonce = await sha256Hex(options.nonce ?? "nonce-1");
  return sign(env.TEST_APPLE_ID_TOKEN_KEY, APPLE_KID, options, {
    issuer: "https://appleid.apple.com",
    audience: env.APPLE_CLIENT_ID,
    claims: { nonce, nonce_supported: true, email_verified: true },
  });
}

export async function googleIdToken(options: IdTokenOptions): Promise<string> {
  return sign(env.TEST_GOOGLE_ID_TOKEN_KEY, GOOGLE_KID, options, {
    issuer: "https://accounts.google.com",
    audience: "test-ios.apps.googleusercontent.com",
    claims: { nonce: options.nonce ?? "nonce-1", email_verified: true },
  });
}

async function sign(
  privateJson: string,
  kid: string,
  options: IdTokenOptions,
  defaults: { issuer: string; audience: string; claims: Record<string, unknown> },
): Promise<string> {
  const signingJson = options.forged
    ? (env.TEST_APPLE_ID_TOKEN_KEY === privateJson ? env.TEST_GOOGLE_ID_TOKEN_KEY : env.TEST_APPLE_ID_TOKEN_KEY)
    : privateJson;
  const key = await importJWK(JSON.parse(signingJson) as JWK, "RS256");
  return new SignJWT({ ...defaults.claims, ...(options.email ? { email: options.email } : {}) })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(options.issuer ?? defaults.issuer)
    .setAudience(options.audience ?? defaults.audience)
    .setSubject(options.subject)
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? "10m")
    .sign(key);
}

// MARK: - 對後台送 HTTP 請求

export type ApiResponse = { status: number; body: any };

export async function api(method: string, path: string, options: { body?: unknown; accessToken?: string } = {}): Promise<ApiResponse> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.accessToken) headers.authorization = `Bearer ${options.accessToken}`;
  const response = await exports.default.fetch(`https://backend.test${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

/// 用 Sign in with Apple 登入(預設帶 authorization code,後台會拿去跟 Apple 換 refresh token)。
export async function signInWithApple(subject: string, extra: Partial<IdTokenOptions> & { authorizationCode?: string } = {}) {
  const nonce = extra.nonce ?? "nonce-1";
  return api("POST", "/v1/sessions", {
    body: {
      provider: "apple",
      idToken: await appleIdToken({ subject, nonce, ...extra }),
      nonce,
      authorizationCode: extra.authorizationCode ?? `code-${subject}`,
    },
  });
}

export async function signInWithGoogle(subject: string, extra: Partial<IdTokenOptions> = {}) {
  const nonce = extra.nonce ?? "nonce-1";
  return api("POST", "/v1/sessions", {
    body: { provider: "google", idToken: await googleIdToken({ subject, nonce, ...extra }), nonce },
  });
}
