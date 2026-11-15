import { describe, expect, it } from "vitest";
import {
  DAY,
  makeChain,
  MONTHLY,
  signJws,
  submitTransaction,
  subscriptionOf,
  transaction,
  trustedChain,
  untrustedRoot,
  type Chain,
} from "./app-store";
import { generateKeyPair } from "./certificates";
import { api, signInWithApple } from "./fakes";

async function member(subject = "apple-user-1") {
  const signIn = await signInWithApple(subject);
  return { accessToken: signIn.body.accessToken as string, id: signIn.body.member.id as string };
}

describe("提交 StoreKit 交易", () => {
  it("會員提交自己購買的交易後，訂閱權限有效並記錄來源商店與到期時間", async () => {
    const me = await member();
    const expiresDate = Date.now() + 29 * DAY;

    const submit = await submitTransaction(me.accessToken, { appAccountToken: me.id, expiresDate });

    expect(submit.status).toBe(200);
    const expected = { status: "active", store: "app_store", productId: MONTHLY, expiresAt: new Date(expiresDate).toISOString() };
    expect(submit.body.subscription).toMatchObject(expected);
    expect((await subscriptionOf(me.accessToken)).body.subscription).toMatchObject(expected);
  });
});

describe("交易簽章驗證(只信任 App Store 憑證鏈)", () => {
  async function expectRejected(signedTransaction: string) {
    const me = await member();
    const submit = await api("POST", "/v1/members/me/subscription/app-store", { accessToken: me.accessToken, body: { signedTransaction } });
    expect(submit.status).toBe(400);
    expect(submit.body.error.code).toBe("invalid_transaction");
    expect((await subscriptionOf(me.accessToken)).body.subscription).toBeNull();
  }

  const valid = () => transaction({ appAccountToken: null });

  it("根憑證不是信任的那張時拒絕", async () => {
    await expectRejected(await signJws(valid(), await makeChain({ root: await untrustedRoot() })));
  });

  it("中繼憑證不是由信任的根簽發時拒絕(名稱相同、金鑰不同)", async () => {
    const trusted = await trustedChain();
    const impostor = { ...trusted.root, privateKey: (await generateKeyPair("P-384")).privateKey };
    const chain = await makeChain({ intermediate: { issuer: impostor } });
    await expectRejected(await signJws(valid(), { ...chain, root: trusted.root }));
  });

  it("葉憑證不是由中繼簽發時拒絕", async () => {
    const trusted = await trustedChain();
    const other = await makeChain();
    // 葉憑證來自另一條鏈(由另一張中繼簽)。
    await expectRejected(await signJws(valid(), { ...trusted, leaf: other.leaf }));
  });

  it("JWS 不是用葉憑證的私鑰簽的時拒絕", async () => {
    await expectRejected(await signJws(valid(), undefined, (await generateKeyPair("P-256")).privateKey));
  });

  it("payload 被改過時拒絕", async () => {
    const [header, , signature] = (await signJws(valid())).split(".");
    const forged = btoa(JSON.stringify({ ...valid(), expiresDate: Date.now() + 3650 * DAY })).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    await expectRejected(`${header}.${forged}.${signature}`);
  });

  it("葉憑證缺少 App Store 收據簽章的 OID 時拒絕", async () => {
    await expectRejected(await signJws(valid(), await makeChain({ leaf: { markers: [] } })));
  });

  it("中繼憑證缺少 Apple WWDR 的 OID 時拒絕", async () => {
    await expectRejected(await signJws(valid(), await makeChain({ intermediate: { markers: [] } })));
  });

  it("簽章時憑證已過期時拒絕", async () => {
    const chain: Chain = await makeChain({ leaf: { notBefore: new Date(Date.now() - 400 * DAY), notAfter: new Date(Date.now() - 300 * DAY) } });
    await expectRejected(await signJws(valid(), chain));
  });

  it("x5c 少一張時拒絕", async () => {
    const jws = await signJws(valid());
    const [header, payload, signature] = jws.split(".");
    const decoded = JSON.parse(atob(header!.replace(/-/g, "+").replace(/_/g, "/")));
    decoded.x5c = decoded.x5c.slice(0, 2);
    const shortened = btoa(JSON.stringify(decoded)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    await expectRejected(`${shortened}.${payload}.${signature}`);
  });

  it("別的 app 的交易拒絕", async () => {
    await expectRejected(await signJws(transaction({ appAccountToken: null, bundleId: "com.example.other" })));
  });

  it("StoreKit 設定檔(Xcode 環境)的交易拒絕", async () => {
    await expectRejected(await signJws(transaction({ appAccountToken: null, environment: "Xcode" })));
  });

  it("不是 Purrdr Plus 的商品拒絕", async () => {
    await expectRejected(await signJws(transaction({ appAccountToken: null, productId: "com.raychiu.purrdr.tip" })));
  });
});
