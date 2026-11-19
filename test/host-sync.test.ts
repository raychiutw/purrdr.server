import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DAY, submitTransaction } from "./app-store";
import { api, signInWithApple } from "./fakes";

/// 主機同步(#30、ADR-0007):會員各裝置共用主機清單;以單一主機為單位最後修改者勝;刪除留紀錄;私鑰與密碼永不上傳。

async function member(subject = "apple-user-1") {
  const signIn = await signInWithApple(subject);
  return { accessToken: signIn.body.accessToken as string, id: signIn.body.member.id as string };
}

async function subscriber(subject = "apple-user-1") {
  const me = await member(subject);
  const submit = await submitTransaction(me.accessToken, { appAccountToken: me.id, originalTransactionId: `original-${subject}` });
  expect(submit.status).toBe(200);
  return me;
}

const STUDIO_ID = "6f1c2a4e-3b7d-4c8e-9a10-2b3c4d5e6f70";
const LINUX_ID = "0a1b2c3d-4e5f-4061-8a7b-9c0d1e2f3a4b";

function studio(overrides: Record<string, unknown> = {}) {
  return {
    id: STUDIO_ID,
    name: "Studio Mac",
    address: "studio-mac",
    port: 22,
    username: "ray",
    connectionMethod: "tailscale_ssh",
    hostKeyFingerprint: "nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8",
    modifiedAt: "2026-11-01T08:00:00.000Z",
    ...overrides,
  };
}

function sync(accessToken: string, changes: unknown[]) {
  return api("POST", "/v1/members/me/hosts/sync", { accessToken, body: { changes } });
}

describe("主機同步需要 Purrdr Plus", () => {
  it("沒有訂閱的會員：拒絕(403 subscription_required),什麼都不存", async () => {
    const me = await member();

    const response = await sync(me.accessToken, [studio()]);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("subscription_required");
    const { results } = await env.DB.prepare("SELECT * FROM synced_hosts").all();
    expect(results).toEqual([]);
  });

  it("訂閱已到期的會員：拒絕(連讀取也不行)", async () => {
    const me = await member();
    const now = Date.now();
    await submitTransaction(me.accessToken, { appAccountToken: me.id, purchaseDate: now - 40 * DAY, expiresDate: now - 10 * DAY });

    const response = await sync(me.accessToken, []);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("subscription_required");
  });

  it("沒有存取權杖：401", async () => {
    const response = await api("POST", "/v1/members/me/hosts/sync", { body: { changes: [] } });
    expect(response.status).toBe(401);
  });
});

describe("同步主機清單", () => {
  it("一支裝置上傳的主機，另一支裝置同步時拿到同樣的欄位", async () => {
    const me = await subscriber();

    const upload = await sync(me.accessToken, [studio()]);
    expect(upload.status).toBe(200);

    const otherDevice = await sync(me.accessToken, []);
    expect(otherDevice.status).toBe(200);
    expect(otherDevice.body).toEqual({ hosts: [studio()], deletedHostIds: [] });
  });

  it("只同步自己的主機：另一個會員看不到", async () => {
    const me = await subscriber("apple-user-1");
    const other = await subscriber("apple-user-2");
    await sync(me.accessToken, [studio()]);

    const response = await sync(other.accessToken, []);

    expect(response.body).toEqual({ hosts: [], deletedHostIds: [] });
  });

  it("沒有 host key 指紋的主機(還沒確認過)也可以同步", async () => {
    const me = await subscriber();

    const response = await sync(me.accessToken, [studio({ hostKeyFingerprint: null })]);

    expect(response.body.hosts).toEqual([studio({ hostKeyFingerprint: null })]);
  });
});

describe("衝突：以單一主機為單位最後修改者勝", () => {
  it("較晚的修改取代較早的", async () => {
    const me = await subscriber();
    await sync(me.accessToken, [studio({ name: "Studio Mac", modifiedAt: "2026-11-01T08:00:00.000Z" })]);

    const response = await sync(me.accessToken, [studio({ name: "Studio", modifiedAt: "2026-11-02T08:00:00.000Z" })]);

    expect(response.body.hosts).toEqual([studio({ name: "Studio", modifiedAt: "2026-11-02T08:00:00.000Z" })]);
  });

  it("較早的修改晚到(離線裝置)時不蓋掉較新的，回傳的是較新的那份", async () => {
    const me = await subscriber();
    await sync(me.accessToken, [studio({ name: "Renamed on iPad", modifiedAt: "2026-11-03T08:00:00.000Z" })]);

    const response = await sync(me.accessToken, [studio({ name: "Old name from iPhone", modifiedAt: "2026-11-02T08:00:00.000Z" })]);

    expect(response.body.hosts).toEqual([studio({ name: "Renamed on iPad", modifiedAt: "2026-11-03T08:00:00.000Z" })]);
  });

  it("修改時間相同時保留已存的", async () => {
    const me = await subscriber();
    await sync(me.accessToken, [studio({ name: "First" })]);

    const response = await sync(me.accessToken, [studio({ name: "Second" })]);

    expect(response.body.hosts[0].name).toBe("First");
  });

  it("以單一主機為單位：同一次同步裡，一台被較新的取代，另一台照常新增", async () => {
    const me = await subscriber();
    await sync(me.accessToken, [studio({ name: "Newer", modifiedAt: "2026-11-05T08:00:00.000Z" })]);
    const linux = studio({ id: LINUX_ID, name: "Linux box", address: "100.64.0.9", port: 2222, connectionMethod: "openssh" });

    const response = await sync(me.accessToken, [studio({ name: "Older", modifiedAt: "2026-11-04T08:00:00.000Z" }), linux]);

    expect(response.body.hosts).toEqual([linux, studio({ name: "Newer", modifiedAt: "2026-11-05T08:00:00.000Z" })]);
  });

  it("裝置時鐘跑到未來時，修改時間以後台收到的時間為上限(不會永遠贏)", async () => {
    const me = await subscriber();
    const before = Date.now();

    const response = await sync(me.accessToken, [studio({ modifiedAt: "2099-01-01T00:00:00.000Z" })]);

    const modifiedAt = Date.parse(response.body.hosts[0].modifiedAt);
    expect(modifiedAt).toBeGreaterThanOrEqual(before);
    expect(modifiedAt).toBeLessThanOrEqual(Date.now());
  });
});

describe("刪除留紀錄、不被同步回來", () => {
  it("刪除後，其他裝置同步時拿到刪除紀錄，清單裡沒有那台主機", async () => {
    const me = await subscriber();
    await sync(me.accessToken, [studio()]);

    await sync(me.accessToken, [{ id: STUDIO_ID, deleted: true }]);
    const otherDevice = await sync(me.accessToken, []);

    expect(otherDevice.body).toEqual({ hosts: [], deletedHostIds: [STUDIO_ID] });
  });

  it("還沒同步到刪除的裝置再上傳那台主機(即使修改時間較晚)也不會復活", async () => {
    const me = await subscriber();
    await sync(me.accessToken, [studio()]);
    await sync(me.accessToken, [{ id: STUDIO_ID, deleted: true }]);
    // 修改時間確實晚於刪除(刪除紀錄的時間是後台收到的時間)。
    await new Promise((resolve) => setTimeout(resolve, 20));

    const stale = await sync(me.accessToken, [studio({ name: "Edited offline", modifiedAt: new Date().toISOString() })]);

    expect(stale.status).toBe(200);
    expect(stale.body).toEqual({ hosts: [], deletedHostIds: [STUDIO_ID] });
  });

  it("刪除從沒上傳過的主機也留紀錄(之後上傳一樣忽略)", async () => {
    const me = await subscriber();

    await sync(me.accessToken, [{ id: STUDIO_ID, deleted: true }]);
    const response = await sync(me.accessToken, [studio()]);

    expect(response.body).toEqual({ hosts: [], deletedHostIds: [STUDIO_ID] });
  });

  it("刪除紀錄只留 id 與時間，主機名稱與位址都清掉", async () => {
    const me = await subscriber();
    await sync(me.accessToken, [studio()]);

    await sync(me.accessToken, [{ id: STUDIO_ID, deleted: true }]);

    const row = await env.DB.prepare("SELECT name, address, port, username, connection_method, host_key_fingerprint FROM synced_hosts").first();
    expect(row).toEqual({ name: null, address: null, port: null, username: null, connection_method: null, host_key_fingerprint: null });
  });
});

describe("隱私：只收白名單欄位，私鑰與密碼永不上傳", () => {
  it.each([
    ["password", { password: "hunter2" }],
    ["privateKey", { privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----" }],
    ["passphrase", { passphrase: "secret" }],
    ["authentication", { authentication: "password" }],
  ])("帶了 %s 欄位：整個請求 400,什麼都不存", async (_, extra) => {
    const me = await subscriber();

    const response = await sync(me.accessToken, [studio(extra)]);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("invalid_request");
    const { results } = await env.DB.prepare("SELECT * FROM synced_hosts").all();
    expect(results).toEqual([]);
  });

  it("刪除也只收 id 與 deleted", async () => {
    const me = await subscriber();

    const response = await sync(me.accessToken, [{ id: STUDIO_ID, deleted: true, password: "hunter2" }]);

    expect(response.status).toBe(400);
  });

  it("body 除了 changes 不收其他欄位", async () => {
    const me = await subscriber();

    const response = await api("POST", "/v1/members/me/hosts/sync", { accessToken: me.accessToken, body: { changes: [], secrets: {} } });

    expect(response.status).toBe(400);
  });
});

describe("欄位檢查", () => {
  it.each([
    ["id 不是 UUID", { id: "host-1" }],
    ["名稱空白", { name: "  " }],
    ["名稱太長", { name: "x".repeat(101) }],
    ["位址空白", { address: "" }],
    ["位址太長", { address: "a".repeat(254) }],
    ["埠超出範圍", { port: 70000 }],
    ["埠不是整數", { port: "22" }],
    ["使用者空白", { username: "" }],
    ["使用者太長", { username: "u".repeat(65) }],
    ["不認得的連線方式", { connectionMethod: "telnet" }],
    ["指紋不像 SHA-256 base64", { hostKeyFingerprint: "not a fingerprint!" }],
    ["修改時間不是時間", { modifiedAt: "yesterday" }],
    ["缺修改時間", { modifiedAt: undefined }],
  ])("%s:400", async (_, overrides) => {
    const me = await subscriber();

    const response = await sync(me.accessToken, [studio(overrides)]);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("invalid_request");
  });

  it("一次最多 200 筆變更", async () => {
    const me = await subscriber();
    const changes = Array.from({ length: 201 }, () => ({ id: crypto.randomUUID(), deleted: true }));

    const response = await sync(me.accessToken, changes);

    expect(response.status).toBe(400);
  });
});

describe("HTTPS 主機(#63、#250):以 address＋port 同步主機服務位址，裝置權杖永不上傳", () => {
  const HTTPS_ID = "1d2e3f40-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

  function httpsStudio(overrides: Record<string, unknown> = {}) {
    return {
      id: HTTPS_ID,
      name: "Studio HTTPS",
      address: "studio.tail1234.ts.net",
      port: 443,
      username: "",
      connectionMethod: "https",
      hostKeyFingerprint: null,
      modifiedAt: "2026-11-01T08:00:00.000Z",
      ...overrides,
    };
  }

  function syncSupportingHttps(accessToken: string, changes: unknown[]) {
    return api("POST", "/v1/members/me/hosts/sync", {
      accessToken,
      body: { changes, connectionMethods: ["tailscale_ssh", "openssh", "https"] },
    });
  }

  it("支援 HTTPS 的裝置上傳 HTTPS 主機，另一支支援 HTTPS 的裝置拿到同樣的欄位", async () => {
    const me = await subscriber();

    const upload = await syncSupportingHttps(me.accessToken, [httpsStudio(), studio()]);
    expect(upload.status).toBe(200);

    const otherDevice = await syncSupportingHttps(me.accessToken, []);
    expect(otherDevice.body).toEqual({ hosts: [httpsStudio(), studio()], deletedHostIds: [] });
  });

  it("舊版 app(請求沒有 connectionMethods)看不到 HTTPS 主機，SSH 主機照舊", async () => {
    const me = await subscriber();
    await syncSupportingHttps(me.accessToken, [httpsStudio(), studio()]);

    const oldApp = await sync(me.accessToken, []);

    expect(oldApp.status).toBe(200);
    expect(oldApp.body).toEqual({ hosts: [studio()], deletedHostIds: [] });
  });

  it("HTTPS 主機刪除後，刪除紀錄照常給所有裝置", async () => {
    const me = await subscriber();
    await syncSupportingHttps(me.accessToken, [httpsStudio()]);
    await syncSupportingHttps(me.accessToken, [{ id: HTTPS_ID, deleted: true }]);

    const oldApp = await sync(me.accessToken, []);

    expect(oldApp.body).toEqual({ hosts: [], deletedHostIds: [HTTPS_ID] });
  });

  it.each([
    ["deviceToken", { deviceToken: "purrdr-device-token-1" }],
    ["token", { token: "purrdr-device-token-1" }],
    ["pairingCode", { pairingCode: "K7QM-2XPA" }],
  ])("HTTPS 主機帶了 %s 欄位：整個請求 400,什麼都不存", async (_, extra) => {
    const me = await subscriber();

    const response = await syncSupportingHttps(me.accessToken, [httpsStudio(extra)]);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("invalid_request");
    const { results } = await env.DB.prepare("SELECT * FROM synced_hosts").all();
    expect(results).toEqual([]);
  });

  it.each([
    ["帶了 hostServiceAddress(埠只以 port 為準)", { hostServiceAddress: "https://studio.tail1234.ts.net:8443" }],
    ["address 帶 scheme", { address: "https://studio.tail1234.ts.net" }],
    ["address 帶埠", { address: "studio.tail1234.ts.net:8443" }],
    ["address 帶路徑", { address: "studio.tail1234.ts.net/v1/ws" }],
    ["address 帶帳密", { address: "user@studio.tail1234.ts.net" }],
    ["address 帶 query", { address: "studio.tail1234.ts.net?token=abc" }],
    ["HTTPS 主機帶 host key 指紋", { hostKeyFingerprint: "nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8" }],
  ])("%s:400", async (_, overrides) => {
    const me = await subscriber();

    const response = await syncSupportingHttps(me.accessToken, [httpsStudio(overrides)]);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("invalid_request");
  });

  it("HTTPS 主機的埠只在 port:8443 原樣存回，回應沒有 hostServiceAddress", async () => {
    const me = await subscriber();
    const custom = httpsStudio({ port: 8443 });

    await syncSupportingHttps(me.accessToken, [custom]);
    const otherDevice = await syncSupportingHttps(me.accessToken, []);

    expect(otherDevice.body.hosts).toEqual([custom]);
    expect(otherDevice.body.hosts[0]).not.toHaveProperty("hostServiceAddress");
  });

  it("本機測試用的 127.0.0.1 位址也收(app 接受的位址都要收，否則整個同步失敗)", async () => {
    const me = await subscriber();
    const local = httpsStudio({ address: "127.0.0.1", port: 47820 });

    const response = await syncSupportingHttps(me.accessToken, [local]);

    expect(response.status).toBe(200);
    expect(response.body.hosts).toEqual([local]);
  });

  it("SSH 主機不收主機服務位址", async () => {
    const me = await subscriber();

    const response = await syncSupportingHttps(me.accessToken, [studio({ hostServiceAddress: "https://studio.tail1234.ts.net" })]);

    expect(response.status).toBe(400);
  });

  it("connectionMethods 不是字串陣列：400", async () => {
    const me = await subscriber();

    const response = await api("POST", "/v1/members/me/hosts/sync", {
      accessToken: me.accessToken,
      body: { changes: [], connectionMethods: "https" },
    });

    expect(response.status).toBe(400);
  });

  it("舊版 app 把 HTTPS 主機改成 SSH(較新的修改)時取代，之後兩種 app 都看到 SSH 版本", async () => {
    const me = await subscriber();
    await syncSupportingHttps(me.accessToken, [httpsStudio()]);
    const asSSH = studio({ id: HTTPS_ID, modifiedAt: "2026-11-02T08:00:00.000Z" });

    const oldApp = await sync(me.accessToken, [asSSH]);

    expect(oldApp.body.hosts).toEqual([asSSH]);
    const newApp = await syncSupportingHttps(me.accessToken, []);
    expect(newApp.body.hosts).toEqual([asSSH]);
  });

  it("HTTPS 主機也帶主機圖示(#243)", async () => {
    const me = await subscriber();

    const response = await syncSupportingHttps(me.accessToken, [httpsStudio({ icon: "cloud" })]);

    expect(response.body.hosts).toEqual([httpsStudio({ icon: "cloud" })]);
  });
});

describe("主機圖示(#243):跟著主機同步;舊版 app 不帶圖示時保留已存的", () => {
  it("新版 app 上傳的圖示，另一支裝置同步時拿到", async () => {
    const me = await subscriber();
    await sync(me.accessToken, [studio({ icon: "macMini" })]);

    const otherDevice = await sync(me.accessToken, []);

    expect(otherDevice.body.hosts).toEqual([studio({ icon: "macMini" })]);
  });

  it("「無」也同步(存成 none)", async () => {
    const me = await subscriber();

    const response = await sync(me.accessToken, [studio({ icon: "none" })]);

    expect(response.body.hosts).toEqual([studio({ icon: "none" })]);
  });

  it("沒有圖示的主機(舊版 app 上傳)回應不帶 icon 欄位", async () => {
    const me = await subscriber();

    const response = await sync(me.accessToken, [studio()]);

    expect(response.body.hosts[0]).not.toHaveProperty("icon");
  });

  it("舊版 app 修改主機(沒帶圖示)時不清掉新版 app 設的圖示", async () => {
    const me = await subscriber();
    await sync(me.accessToken, [studio({ icon: "rack" })]);

    const response = await sync(me.accessToken, [studio({ name: "Renamed on old app", modifiedAt: "2026-11-02T08:00:00.000Z" })]);

    expect(response.body.hosts).toEqual([studio({ name: "Renamed on old app", modifiedAt: "2026-11-02T08:00:00.000Z", icon: "rack" })]);
  });

  it("較新的修改換掉圖示;較舊的修改不換", async () => {
    const me = await subscriber();
    await sync(me.accessToken, [studio({ icon: "rack", modifiedAt: "2026-11-02T08:00:00.000Z" })]);

    await sync(me.accessToken, [studio({ icon: "cloud", modifiedAt: "2026-11-01T08:00:00.000Z" })]);
    const response = await sync(me.accessToken, [studio({ icon: "laptop", modifiedAt: "2026-11-03T08:00:00.000Z" })]);

    expect(response.body.hosts).toEqual([studio({ icon: "laptop", modifiedAt: "2026-11-03T08:00:00.000Z" })]);
  });

  it("較新版 app 加的圖示(後台不認得名稱)照樣存、照樣回，由 app 決定怎麼顯示", async () => {
    const me = await subscriber();

    const response = await sync(me.accessToken, [studio({ icon: "robotArm" })]);

    expect(response.body.hosts).toEqual([studio({ icon: "robotArm" })]);
  });

  it("刪除時圖示一起清掉", async () => {
    const me = await subscriber();
    await sync(me.accessToken, [studio({ icon: "rack" })]);

    await sync(me.accessToken, [{ id: STUDIO_ID, deleted: true }]);

    const row = await env.DB.prepare("SELECT icon FROM synced_hosts WHERE host_id = ?").bind(STUDIO_ID).first();
    expect(row).toEqual({ icon: null });
  });

  it.each([
    ["不是字串", 3],
    ["空字串", ""],
    ["太長", "a".repeat(33)],
    ["有空白", "mac mini"],
  ])("圖示%s:400", async (_, icon) => {
    const me = await subscriber();

    const response = await sync(me.accessToken, [studio({ icon })]);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("invalid_request");
  });
});
