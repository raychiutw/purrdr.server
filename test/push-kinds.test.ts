import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, identityProviders, signInWithApple } from "./fakes";

/// 通知種類清單與配對資料 API(purrdr.server#39、ADR-0016)。全部從 HTTP 入口驗證，APNs 是 test/fakes.ts 的假端點。

const DEVICE_TOKEN = "a1".repeat(32);
const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_DEVICE_ID = "22222222-2222-4222-8222-222222222222";

async function member(subject = "apple-user-1") {
  const signIn = await signInWithApple(subject);
  return { accessToken: signIn.body.accessToken as string, id: signIn.body.member.id as string };
}

function pairingKey(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashOf(key: string): Promise<string> {
  const bytes = new Uint8Array(key.match(/../g)!.map((pair) => parseInt(pair, 16)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function register(accessToken: string, key: string, extra: Record<string, unknown> = {}) {
  return api("POST", "/v1/members/me/push-pairings", {
    accessToken,
    body: { keyHash: await hashOf(key), platform: "apns", deviceToken: DEVICE_TOKEN, environment: "production", ...extra },
  });
}

const push = (body: Record<string, unknown>) => api("POST", "/v1/push", { body });
const blocked = (key: string) => ({ key, workspace: "weather-app", status: "blocked", pane: "w2:p1" });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /v1/push-kinds", () => {
  it("需要會員權杖", async () => {
    expect((await api("GET", "/v1/push-kinds")).status).toBe(401);
  });

  it("回種類清單(含 long_work_done、usage_alert),依順序", async () => {
    const me = await member();

    const response = await api("GET", "/v1/push-kinds", { accessToken: me.accessToken });

    expect(response.status).toBe(200);
    expect(response.body.kinds.map((kind: { code: string }) => kind.code)).toEqual([
      "blocked", "done", "long_work_done", "stuck", "reminder", "host_service", "daily_limit_reached", "usage_alert",
    ]);
    expect(response.body.kinds[0]).toEqual({
      code: "blocked",
      name: { en: "Needs you", "zh-Hant": "需要你" },
      description: { en: "An agent is waiting for your reply or approval.", "zh-Hant": "Agent 在等你回覆或核准。" },
      defaultOn: true,
      transports: ["https", "ssh"],
      minServiceVersion: null,
      minPluginVersion: null,
      order: 10,
    });
    const defaults = Object.fromEntries(response.body.kinds.map((kind: { code: string; defaultOn: boolean }) => [kind.code, kind.defaultOn]));
    expect(defaults).toEqual({ blocked: true, done: false, stuck: false, reminder: false, host_service: false, daily_limit_reached: true, long_work_done: false, usage_alert: true });
  });

  it("停用的種類不出現,最低版本與順序照資料表", async () => {
    const me = await member();
    await env.DB.prepare("UPDATE push_kinds SET disabled = 1 WHERE code = 'stuck'").run();
    await env.DB.prepare("UPDATE push_kinds SET min_service_version = '1.4.0', min_plugin_version = '0.9.0', sort_order = 5 WHERE code = 'done'").run();

    const response = await api("GET", "/v1/push-kinds", { accessToken: me.accessToken });

    const codes = response.body.kinds.map((kind: { code: string }) => kind.code);
    expect(codes).not.toContain("stuck");
    expect(codes[0]).toBe("done");
    expect(response.body.kinds[0].minServiceVersion).toBe("1.4.0");
    expect(response.body.kinds[0].minPluginVersion).toBe("0.9.0");
  });
});
