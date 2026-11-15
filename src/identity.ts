import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload } from "jose";
import { ApiError } from "./http";

/// 登入方式。API 不綁平台：Android 之後也用同一組。
export type Provider = "apple" | "google";

export function parseProvider(value: unknown): Provider {
  if (value === "apple" || value === "google") return value;
  throw new ApiError(400, "invalid_request", "provider must be apple or google.");
}

/// 驗證過的登入身分。
export type VerifiedIdentity = { provider: Provider; subject: string; email: string | null };

const appleKeys = createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"));
const googleKeys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

/// 驗證 Sign in with Apple 或 Google 的 ID token:簽章(各家公布的 JWKS)、iss、aud、exp 與 nonce。
///
/// nonce 由 app 產生、送原文來。Apple 的 token 放的是 app 交給 Apple 的 SHA-256(hex),Google 放原文。
export async function verifyIdToken(env: Env, provider: Provider, idToken: string, nonce: string): Promise<VerifiedIdentity> {
  let payload: JWTPayload;
  try {
    if (provider === "apple") {
      ({ payload } = await jwtVerify(idToken, appleKeys, {
        issuer: "https://appleid.apple.com",
        audience: env.APPLE_CLIENT_ID,
        algorithms: ["RS256"],
      }));
    } else {
      ({ payload } = await jwtVerify(idToken, googleKeys, {
        issuer: ["https://accounts.google.com", "accounts.google.com"],
        audience: env.GOOGLE_CLIENT_IDS.split(",").map((id) => id.trim()).filter(Boolean),
        algorithms: ["RS256"],
      }));
    }
  } catch (error) {
    if (error instanceof errors.JOSEError) {
      throw new ApiError(401, "invalid_id_token", "The sign-in credential is invalid or expired.");
    }
    throw new ApiError(502, "provider_unavailable", "Couldn't reach the sign-in provider.");
  }

  const expectedNonce = provider === "apple" ? await sha256Hex(nonce) : nonce;
  if (payload.nonce !== expectedNonce) {
    throw new ApiError(401, "invalid_id_token", "The sign-in credential doesn't match this request.");
  }
  if (!payload.sub) throw new ApiError(401, "invalid_id_token", "The sign-in credential has no subject.");
  const email = typeof payload.email === "string" ? payload.email : null;
  return { provider, subject: payload.sub, email };
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
