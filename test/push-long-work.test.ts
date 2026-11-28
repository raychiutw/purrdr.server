import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { api, identityProviders } from "./fakes";
import { hashOf, member, pairingKey, patchPairing, push, register } from "./push-kinds-support";

/// 長時間工作完成通知(purrdr.server#40、ADR-0016):「完成」事件帶選用的 `workSeconds`,
/// 秒數達 600 且這組配對開了 `long_work_done`、沒開 `done` 時,送新的 loc-key。全部從 HTTP 入口驗證。

const done = (key: string, extra: Record<string, unknown> = {}) => ({ key, workspace: "weather-app", status: "done", pane: "w2:p1", ...extra });
const locKeys = () => identityProviders.apnsCalls.map((call) => call.payload.aps.alert["loc-key"]);

describe("種類清單", () => {
  it("有 long_work_done:預設關,ssh 需外掛 0.3.0、https 需主機服務 0.16.0", async () => {
    const me = await member();

    const response = await api("GET", "/v1/push-kinds", { accessToken: me.accessToken });

    const kind = response.body.kinds.find((item: { code: string }) => item.code === "long_work_done");
    expect(kind).toMatchObject({ defaultOn: false, transports: ["https", "ssh"], minServiceVersion: "0.16.0", minPluginVersion: "0.3.0" });
    expect(kind.name.en).toBeTruthy();
    expect(kind.name["zh-Hant"]).toBeTruthy();
  });

  it("配對的 kinds 認得新代號", async () => {
    const me = await member();
    const key = pairingKey();
    await register(me.accessToken, key);

    const patched = await patchPairing(me.accessToken, await hashOf(key), { kinds: ["long_work_done"] });

    expect(patched.status).toBe(200);
    expect(patched.body.pairing.kinds).toEqual(["long_work_done"]);
  });
});

describe("POST /v1/push 的 workSeconds", () => {
  it("秒數 ≥ 600、開了 long_work_done 沒開 done:送新的 loc-key", async () => {
    const me = await member();
    const key = pairingKey();
    await register(me.accessToken, key, { kinds: ["long_work_done"] });

    const response = await push(done(key, { workSeconds: 600 }));

    expect(response.body).toEqual({ delivered: true });
    expect(locKeys()).toEqual(["An agent finished a long task."]);
    expect(identityProviders.apnsCalls[0]!.payload.status).toBe("done");
  });

  it("秒數 599:不送 long_work_done", async () => {
    const me = await member();
    const key = pairingKey();
    await register(me.accessToken, key, { kinds: ["long_work_done"] });

    const response = await push(done(key, { workSeconds: 599 }));

    expect(response.body).toEqual({ delivered: false });
    expect(identityProviders.apnsCalls).toHaveLength(0);
  });

  it("done 開著:照常送 done,不另送 long_work_done", async () => {
    const me = await member();
    const key = pairingKey();
    await register(me.accessToken, key, { kinds: ["done", "long_work_done"] });

    const response = await push(done(key, { workSeconds: 3600 }));

    expect(response.body).toEqual({ delivered: true });
    expect(locKeys()).toEqual(["An agent finished."]);
  });

  it("沒帶秒數的舊請求只算 done:只開 long_work_done 收不到", async () => {
    const me = await member();
    const key = pairingKey();
    await register(me.accessToken, key, { kinds: ["long_work_done"] });

    const response = await push(done(key));

    expect(response.body).toEqual({ delivered: false });
    expect(identityProviders.apnsCalls).toHaveLength(0);
  });

  it("沒帶秒數、done 開著:照舊送 done", async () => {
    const me = await member();
    const key = pairingKey();
    await register(me.accessToken, key, { kinds: ["done"] });

    await push(done(key));

    expect(locKeys()).toEqual(["An agent finished."]);
  });

  it("long_work_done 被停用:不送", async () => {
    const me = await member();
    const key = pairingKey();
    await register(me.accessToken, key, { kinds: ["long_work_done"] });
    await env.DB.prepare("UPDATE push_kinds SET disabled = 1 WHERE code = 'long_work_done'").run();

    const response = await push(done(key, { workSeconds: 900 }));

    expect(response.body).toEqual({ delivered: false });
  });

  it.each([[-1], [1.5], ["900"], [null]])("workSeconds 型別或範圍不對(%j)回 400", async (value) => {
    const me = await member();
    const key = pairingKey();
    await register(me.accessToken, key, { kinds: ["long_work_done"] });

    const response = await push(done(key, { workSeconds: value }));

    expect(response.status).toBe(400);
  });

  it("其他狀態帶 workSeconds 照樣被接受,不影響(blocked 照送)", async () => {
    const me = await member();
    const key = pairingKey();
    await register(me.accessToken, key);

    const response = await push({ key, workspace: "w", status: "blocked", workSeconds: 5000 });

    expect(response.body).toEqual({ delivered: true });
    expect(locKeys()).toEqual(["An agent needs you."]);
  });
});
