import { describe, expect, it } from "vitest";
import { api } from "./fakes";

/// 每個 IP(`CF-Connecting-IP`)60 秒最多 60 次(#2)。限流視窗對齊時鐘，測試期間可能剛好換窗，
/// 所以不斷言「第 61 次」,而是：新 IP 的前 60 次都放行，連送 120 次一定會撞到 429。

function uniqueIp(): string {
  const [a, b, c] = crypto.getRandomValues(new Uint8Array(3));
  return `10.${a}.${b}.${c}`;
}

async function burst(method: string, path: string, ip: string, count: number, body?: unknown) {
  const responses = [];
  for (let i = 0; i < count; i++) {
    responses.push(await api(method, path, { headers: { "cf-connecting-ip": ip }, body }));
  }
  return responses;
}

describe("每個 IP 的限流", () => {
  it("同一個 IP 前 60 次放行，之後回 429 rate_limited 並帶 Retry-After", async () => {
    const responses = await burst("GET", "/v1/members/me", uniqueIp(), 120);

    expect(responses.slice(0, 60).every((response) => response.status === 401)).toBe(true);
    const limited = responses.find((response) => response.status === 429);
    expect(limited?.body.error.code).toBe("rate_limited");
    expect(Number(limited?.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("一個 IP 被限流不影響另一個 IP", async () => {
    const limitedIp = uniqueIp();
    await burst("GET", "/v1/members/me", limitedIp, 120);

    const [other] = await burst("GET", "/v1/members/me", uniqueIp(), 1);

    expect(other!.status).toBe(401);
  });

  it("App Store 通知來自 Apple 的伺服器，不限流", async () => {
    const responses = await burst("POST", "/v1/app-store/notifications", uniqueIp(), 120, { signedPayload: "not-a-jws" });

    expect(responses.every((response) => response.body.error.code === "invalid_notification")).toBe(true);
  });
});
