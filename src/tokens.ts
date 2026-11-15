import { errors, jwtVerify, SignJWT } from "jose";
import { ApiError } from "./http";
import { sha256Hex } from "./identity";

/// 後台自己簽發的權杖。
/// - 存取權杖：HS256 JWT,15 分鐘，`sub` 是會員 ID。每次使用都會再確認會員還在(刪除後立即失效)。
/// - 更新權杖：32 bytes 隨機值，資料庫只存雜湊;90 天、每次使用就輪替(舊的立即失效)。
export const ACCESS_TOKEN_LIFETIME_SECONDS = 15 * 60;
export const REFRESH_TOKEN_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
const ISSUER = "purrdr-backend";
const AUDIENCE = "purrdr-app";

export type Tokens = { accessToken: string; accessTokenExpiresAt: string; refreshToken: string };

function secretKey(env: Env): Uint8Array {
  return new TextEncoder().encode(env.ACCESS_TOKEN_SECRET);
}

/// 簽發一組新的權杖給會員。
export async function issueTokens(env: Env, memberId: string): Promise<Tokens> {
  const now = Date.now();
  const expiresAt = Math.floor(now / 1000) + ACCESS_TOKEN_LIFETIME_SECONDS;
  const accessToken = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(memberId)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(secretKey(env));

  const refreshToken = randomToken();
  await env.DB.prepare("INSERT INTO refresh_tokens (token_hash, member_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(refreshToken), memberId, now + REFRESH_TOKEN_LIFETIME_MS, now)
    .run();
  return { accessToken, accessTokenExpiresAt: new Date(expiresAt * 1000).toISOString(), refreshToken };
}

/// 用更新權杖換一組新的權杖;舊的更新權杖同時作廢。
export async function rotateRefreshToken(env: Env, refreshToken: string): Promise<{ memberId: string; tokens: Tokens }> {
  const hash = await sha256Hex(refreshToken);
  const row = await env.DB.prepare("DELETE FROM refresh_tokens WHERE token_hash = ? RETURNING member_id, expires_at")
    .bind(hash)
    .first<{ member_id: string; expires_at: number }>();
  if (!row || row.expires_at <= Date.now()) {
    throw new ApiError(401, "invalid_refresh_token", "Please sign in again.");
  }
  return { memberId: row.member_id, tokens: await issueTokens(env, row.member_id) };
}

/// 登出：作廢這個更新權杖。不存在也算成功。
export async function revokeRefreshToken(env: Env, refreshToken: string): Promise<void> {
  await env.DB.prepare("DELETE FROM refresh_tokens WHERE token_hash = ?").bind(await sha256Hex(refreshToken)).run();
}

/// 從 `Authorization: Bearer` 取出會員 ID,並確認會員仍存在。
export async function authenticate(env: Env, request: Request): Promise<string> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  if (!match?.[1]) throw new ApiError(401, "invalid_access_token", "Sign in required.");
  let memberId: string | undefined;
  try {
    const { payload } = await jwtVerify(match[1], secretKey(env), { issuer: ISSUER, audience: AUDIENCE, algorithms: ["HS256"] });
    memberId = payload.sub;
  } catch (error) {
    if (!(error instanceof errors.JOSEError)) throw error;
  }
  if (!memberId) throw new ApiError(401, "invalid_access_token", "Sign in required.");
  const exists = await env.DB.prepare("SELECT 1 FROM members WHERE id = ?").bind(memberId).first();
  if (!exists) throw new ApiError(401, "invalid_access_token", "Sign in required.");
  return memberId;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
