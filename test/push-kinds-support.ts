import { api, signInWithApple } from "./fakes";

/// 通知種類與配對資料測試(purrdr.server#39)共用的小工具。

export const DEVICE_TOKEN = "a1".repeat(32);
export const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
export const OTHER_DEVICE_ID = "22222222-2222-4222-8222-222222222222";

export async function member(subject = "apple-user-1") {
  const signIn = await signInWithApple(subject);
  return { accessToken: signIn.body.accessToken as string, id: signIn.body.member.id as string };
}

export function pairingKey(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/// 雜湊 = 密鑰 32 bytes 的 SHA-256(小寫 hex)。用 WebCrypto 另外算，不經後台程式。
export async function hashOf(key: string): Promise<string> {
  const bytes = new Uint8Array(key.match(/../g)!.map((pair) => parseInt(pair, 16)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function register(accessToken: string, key: string, extra: Record<string, unknown> = {}) {
  return api("POST", "/v1/members/me/push-pairings", {
    accessToken,
    body: { keyHash: await hashOf(key), platform: "apns", deviceToken: DEVICE_TOKEN, environment: "production", ...extra },
  });
}

export const push = (body: Record<string, unknown>) => api("POST", "/v1/push", { body });
export const blocked = (key: string) => ({ key, workspace: "weather-app", status: "blocked", pane: "w2:p1" });

export const pairingsOf = (accessToken: string, deviceId?: string) =>
  api("GET", `/v1/members/me/push-pairings${deviceId === undefined ? "" : `?deviceId=${deviceId}`}`, { accessToken });

export const patchPairing = (accessToken: string, keyHash: string, body: unknown) =>
  api("PATCH", `/v1/members/me/push-pairings/${keyHash}`, { accessToken, body });
