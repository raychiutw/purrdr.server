import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { api, appleIdToken, googleIdToken, signInWithApple, signInWithGoogle } from "./fakes";

const DEVICE_A = "11111111-1111-4111-8111-111111111111";
const DEVICE_B = "22222222-2222-4222-8222-222222222222";

async function signInOn(deviceId: string | undefined, subject = "google-1") {
  const nonce = "nonce-1";
  return api("POST", "/v1/sessions", {
    body: { provider: "google", idToken: await googleIdToken({ subject, nonce }), nonce, ...(deviceId === undefined ? {} : { deviceId }) },
  });
}

async function refresh(refreshToken: string) {
  return api("POST", "/v1/sessions/refresh", { body: { refreshToken } });
}

type SessionRow = { id: string; device_id: string; revoked_at: number | null; grace_until: number | null; refresh_token_hash: string };
async function sessionRows(): Promise<SessionRow[]> {
  return (await env.DB.prepare("SELECT * FROM sessions ORDER BY created_at, id").all<SessionRow>()).results;
}

/// 讓寬限過期(不靠等 60 秒)。
async function expireGrace() {
  await env.DB.prepare("UPDATE sessions SET grace_until = ? WHERE grace_until IS NOT NULL").bind(Date.now() - 1).run();
}

describe("登入帶 deviceId", () => {
  it("帶 deviceId:以該 id 建立裝置,工作階段屬於它", async () => {
    const signIn = await signInOn(DEVICE_A);

    expect(signIn.status).toBe(200);
    const rows = await sessionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.device_id).toBe(DEVICE_A);
    const device = await env.DB.prepare("SELECT member_id FROM devices WHERE id = ?").bind(DEVICE_A).first();
    expect(device).toEqual({ member_id: signIn.body.member.id });
  });

  it("同一裝置重新登入:撤銷該裝置舊的工作階段,舊更新權杖失效,只剩一個未撤銷的", async () => {
    const first = await signInOn(DEVICE_A);
    const second = await signInOn(DEVICE_A);

    expect(second.status).toBe(200);
    const rows = await sessionRows();
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.revoked_at === null)).toHaveLength(1);
    expect((await refresh(first.body.refreshToken)).status).toBe(401);
    expect((await refresh(second.body.refreshToken)).status).toBe(200);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM devices").first<{ n: number }>())?.n).toBe(1);
  });

  it("不同裝置各有自己的工作階段,互不影響", async () => {
    const a = await signInOn(DEVICE_A);
    const b = await signInOn(DEVICE_B);

    expect((await sessionRows()).filter((row) => row.revoked_at === null)).toHaveLength(2);
    expect((await refresh(a.body.refreshToken)).status).toBe(200);
    expect((await refresh(b.body.refreshToken)).status).toBe(200);
  });

  it("這支裝置換另一個會員登入(舊會員已登出):裝置改歸新會員,舊會員的工作階段早已撤銷", async () => {
    const old = await signInOn(DEVICE_A, "google-1");
    await api("POST", "/v1/sessions/revoke", { body: { refreshToken: old.body.refreshToken } });
    const next = await signInOn(DEVICE_A, "google-2");

    expect(next.body.member.id).not.toBe(old.body.member.id);
    expect((await refresh(old.body.refreshToken)).status).toBe(401);
    const device = await env.DB.prepare("SELECT member_id FROM devices WHERE id = ?").bind(DEVICE_A).first();
    expect(device).toEqual({ member_id: next.body.member.id });
  });

  it("沒帶 deviceId:維持每次登入建一個裝置(舊 app 相容)", async () => {
    await signInOn(undefined);
    await signInOn(undefined);

    const rows = await sessionRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.device_id).not.toBe(rows[1]!.device_id);
    expect(rows.every((row) => row.revoked_at === null)).toBe(true);
  });

  it.each([[""], [123], ["has space"], ["x".repeat(65)]])("deviceId 格式不對(%j)回 400,不建立工作階段", async (deviceId) => {
    const nonce = "nonce-1";
    const response = await api("POST", "/v1/sessions", {
      body: { provider: "google", idToken: await googleIdToken({ subject: "google-1", nonce }), nonce, deviceId },
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("invalid_request");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>())?.n).toBe(0);
  });

  it("Apple 登入也接受 deviceId", async () => {
    const nonce = "nonce-1";
    const response = await api("POST", "/v1/sessions", {
      body: { provider: "apple", idToken: await appleIdToken({ subject: "apple-1", nonce }), nonce, authorizationCode: "c", deviceId: DEVICE_A },
    });

    expect(response.status).toBe(200);
    expect((await sessionRows())[0]!.device_id).toBe(DEVICE_A);
  });
});

describe("更新權杖輪替寬限與外洩偵測", () => {
  it("換權杖回應遺失後,60 秒內用舊權杖重送,拿到同一組新更新權杖", async () => {
    const signIn = await signInOn(DEVICE_A);
    const first = await refresh(signIn.body.refreshToken);
    const retry = await refresh(signIn.body.refreshToken);

    expect(retry.status).toBe(200);
    expect(retry.body.refreshToken).toBe(first.body.refreshToken);
    expect(retry.body.member.id).toBe(signIn.body.member.id);
    expect(retry.body.accessToken).toEqual(expect.any(String));
    // 重送拿到的權杖是有效的,而且可以繼續換。
    expect((await refresh(retry.body.refreshToken)).status).toBe(200);
  });

  it("寬限內重送多次都是同一組,資料庫不存明文更新權杖,只有一個工作階段", async () => {
    const signIn = await signInOn(DEVICE_A);
    const first = await refresh(signIn.body.refreshToken);
    const again = await refresh(signIn.body.refreshToken);
    const third = await refresh(signIn.body.refreshToken);

    expect(again.body.refreshToken).toBe(first.body.refreshToken);
    expect(third.body.refreshToken).toBe(first.body.refreshToken);
    const dump = JSON.stringify(await sessionRows()) + JSON.stringify((await env.DB.prepare("SELECT * FROM devices").all()).results);
    expect(dump).not.toContain(first.body.refreshToken);
    expect(dump).not.toContain(signIn.body.refreshToken);
    expect(await sessionRows()).toHaveLength(1);
  });

  it("每次輪替的新權杖都不一樣(不是固定值)", async () => {
    const signIn = await signInOn(DEVICE_A);
    const one = await refresh(signIn.body.refreshToken);
    const two = await refresh(one.body.refreshToken);

    expect(new Set([signIn.body.refreshToken, one.body.refreshToken, two.body.refreshToken]).size).toBe(3);
  });

  it("寬限外再用舊權杖:視為外洩,撤銷工作階段,連新權杖也失效", async () => {
    const signIn = await signInOn(DEVICE_A);
    const rotated = await refresh(signIn.body.refreshToken);
    await expireGrace();

    const reuse = await refresh(signIn.body.refreshToken);

    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe("invalid_refresh_token");
    expect((await sessionRows())[0]!.revoked_at).toBeGreaterThan(0);
    expect((await refresh(rotated.body.refreshToken)).status).toBe(401);
  });

  it("外洩只撤銷該工作階段,同會員其他裝置不受影響", async () => {
    const a = await signInOn(DEVICE_A);
    const b = await signInOn(DEVICE_B);
    await refresh(a.body.refreshToken);
    await expireGrace();

    await refresh(a.body.refreshToken);

    expect((await refresh(b.body.refreshToken)).status).toBe(200);
  });

  it("已撤銷的工作階段,寬限內的舊權杖也換不到", async () => {
    const signIn = await signInOn(DEVICE_A);
    const rotated = await refresh(signIn.body.refreshToken);
    await api("POST", "/v1/sessions/revoke", { body: { refreshToken: rotated.body.refreshToken } });

    expect((await refresh(signIn.body.refreshToken)).status).toBe(401);
  });

  it("工作階段已過期,寬限內的舊權杖也換不到", async () => {
    const signIn = await signInOn(DEVICE_A);
    await refresh(signIn.body.refreshToken);
    await env.DB.prepare("UPDATE sessions SET expires_at = ?").bind(Date.now() - 1).run();

    expect((await refresh(signIn.body.refreshToken)).status).toBe(401);
  });

  it("輪替設定寬限到期時間約 60 秒後", async () => {
    const signIn = await signInOn(DEVICE_A);
    const before = Date.now();
    await refresh(signIn.body.refreshToken);

    const [row] = await sessionRows();
    expect(row!.grace_until).toBeGreaterThanOrEqual(before + 60_000);
    expect(row!.grace_until).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  it("從沒發過的權杖仍是 401,而且不會撤銷任何工作階段", async () => {
    await signInOn(DEVICE_A);

    expect((await refresh("never-issued")).status).toBe(401);
    expect((await sessionRows())[0]!.revoked_at).toBeNull();
  });
});

describe("GET /v1/members/me/sessions", () => {
  it("列出自己未撤銷的工作階段,標出目前這個", async () => {
    const a = await signInOn(DEVICE_A);
    await signInOn(DEVICE_B);
    await env.DB.prepare("UPDATE devices SET name = 'Ray 的 iPad', model = 'iPad' WHERE id = ?").bind(DEVICE_B).run();

    const list = await api("GET", "/v1/members/me/sessions", { accessToken: a.body.accessToken });

    expect(list.status).toBe(200);
    expect(list.body.sessions).toHaveLength(2);
    const current = list.body.sessions.find((s: any) => s.deviceId === DEVICE_A);
    const other = list.body.sessions.find((s: any) => s.deviceId === DEVICE_B);
    expect(current).toMatchObject({ id: expect.any(String), current: true, deviceName: null, createdAt: expect.any(String), lastActiveAt: expect.any(String), expiresAt: expect.any(String) });
    expect(other).toMatchObject({ current: false, deviceName: "Ray 的 iPad", deviceModel: "iPad" });
    expect(JSON.stringify(list.body)).not.toContain("hash");
  });

  it("輪替後 session id 不變,目前這個仍標為 current", async () => {
    const signIn = await signInOn(DEVICE_A);
    const rotated = await refresh(signIn.body.refreshToken);

    const list = await api("GET", "/v1/members/me/sessions", { accessToken: rotated.body.accessToken });

    expect(list.body.sessions).toHaveLength(1);
    expect(list.body.sessions[0].current).toBe(true);
  });

  it("不列別的會員的、已撤銷的、已過期的", async () => {
    const mine = await signInOn(DEVICE_A, "google-1");
    await signInOn(DEVICE_B, "google-2");
    await signInOn("33333333-3333-4333-8333-333333333333", "google-1");
    await env.DB.prepare("UPDATE sessions SET revoked_at = 1 WHERE device_id = '33333333-3333-4333-8333-333333333333'").run();
    await signInOn("44444444-4444-4444-8444-444444444444", "google-1");
    await env.DB.prepare("UPDATE sessions SET expires_at = 1 WHERE device_id = '44444444-4444-4444-8444-444444444444'").run();

    const list = await api("GET", "/v1/members/me/sessions", { accessToken: mine.body.accessToken });

    expect(list.body.sessions.map((s: any) => s.deviceId)).toEqual([DEVICE_A]);
  });

  it("沒帶存取權杖 401;工作階段已被撤銷後,同一個存取權杖也 401", async () => {
    const signIn = await signInOn(DEVICE_A);
    expect((await api("GET", "/v1/members/me/sessions")).status).toBe(401);

    await api("POST", "/v1/sessions/revoke", { body: { refreshToken: signIn.body.refreshToken } });

    const list = await api("GET", "/v1/members/me/sessions", { accessToken: signIn.body.accessToken });
    expect(list.status).toBe(401);
    expect(list.body.error.code).toBe("invalid_access_token");
  });
});

describe("DELETE /v1/members/me/sessions/{id}", () => {
  async function sessionIdOf(accessToken: string, deviceId: string): Promise<string> {
    const list = await api("GET", "/v1/members/me/sessions", { accessToken });
    return list.body.sessions.find((s: any) => s.deviceId === deviceId).id;
  }

  it("撤銷自己另一支裝置的工作階段:204,那支裝置的更新權杖失效,目前這個不受影響", async () => {
    const a = await signInOn(DEVICE_A);
    const b = await signInOn(DEVICE_B);
    const id = await sessionIdOf(a.body.accessToken, DEVICE_B);

    const revoked = await api("DELETE", `/v1/members/me/sessions/${id}`, { accessToken: a.body.accessToken });

    expect(revoked.status).toBe(204);
    expect((await refresh(b.body.refreshToken)).status).toBe(401);
    expect((await refresh(a.body.refreshToken)).status).toBe(200);
    const list = await api("GET", "/v1/members/me/sessions", { accessToken: a.body.accessToken });
    expect(list.body.sessions.map((s: any) => s.deviceId)).toEqual([DEVICE_A]);
  });

  it("不能用它撤銷目前這個工作階段(要用登出):409 cannot_revoke_current_session", async () => {
    const a = await signInOn(DEVICE_A);
    const id = await sessionIdOf(a.body.accessToken, DEVICE_A);

    const response = await api("DELETE", `/v1/members/me/sessions/${id}`, { accessToken: a.body.accessToken });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("cannot_revoke_current_session");
    expect((await refresh(a.body.refreshToken)).status).toBe(200);
  });

  it("別的會員的工作階段:404 session_not_found,而且沒被撤銷", async () => {
    const mine = await signInOn(DEVICE_A, "google-1");
    const theirs = await signInOn(DEVICE_B, "google-2");
    const theirId = await sessionIdOf(theirs.body.accessToken, DEVICE_B);

    const response = await api("DELETE", `/v1/members/me/sessions/${theirId}`, { accessToken: mine.body.accessToken });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("session_not_found");
    expect((await refresh(theirs.body.refreshToken)).status).toBe(200);
  });

  it("不存在的 id:404;已撤銷的:204(冪等);沒帶權杖:401", async () => {
    const a = await signInOn(DEVICE_A);
    await signInOn(DEVICE_B);
    const id = await sessionIdOf(a.body.accessToken, DEVICE_B);

    expect((await api("DELETE", "/v1/members/me/sessions/nope", { accessToken: a.body.accessToken })).status).toBe(404);
    expect((await api("DELETE", `/v1/members/me/sessions/${id}`)).status).toBe(401);
    expect((await api("DELETE", `/v1/members/me/sessions/${id}`, { accessToken: a.body.accessToken })).status).toBe(204);
    expect((await api("DELETE", `/v1/members/me/sessions/${id}`, { accessToken: a.body.accessToken })).status).toBe(204);
  });

  it("沒帶 deviceId 的舊 app 登入,也能被列出與撤銷", async () => {
    const modern = await signInOn(DEVICE_A);
    const legacy = await signInOn(undefined);
    const list = await api("GET", "/v1/members/me/sessions", { accessToken: modern.body.accessToken });
    const legacyEntry = list.body.sessions.find((s: any) => !s.current);

    expect((await api("DELETE", `/v1/members/me/sessions/${legacyEntry.id}`, { accessToken: modern.body.accessToken })).status).toBe(204);
    expect((await refresh(legacy.body.refreshToken)).status).toBe(401);
  });
});

describe("舊登入流程相容", () => {
  it("signInWithApple／signInWithGoogle 不帶 deviceId 仍可登入", async () => {
    expect((await signInWithApple("apple-1")).status).toBe(200);
    expect((await signInWithGoogle("google-9")).status).toBe(200);
  });
});
