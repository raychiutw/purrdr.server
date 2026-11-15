import { exchangeAuthorizationCode, revokeAppleToken } from "./apple";
import { ApiError, errorResponse, json, readJson, requireString } from "./http";
import { parseProvider, verifyIdToken, type Provider, type VerifiedIdentity } from "./identity";
import {
  absorbIdentity,
  addIdentity,
  createMember,
  deleteMember,
  hasDataBlockingMerge,
  identitiesOf,
  memberIdFor,
  memberView,
  refreshIdentity,
  removeIdentity,
} from "./members";
import { registerPairing, revokePairing, sendPush } from "./push";
import { handleAppStoreNotification, submitAppStoreTransaction, subscriptionView } from "./subscriptions";
import { authenticate, issueTokens, revokeRefreshToken, rotateRefreshToken } from "./tokens";

/// Purrdr 後台(ADR-0004、ADR-0007)。API 一覽見 README.md。
export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      if (error instanceof ApiError) return errorResponse(error);
      console.error(error);
      return errorResponse(new ApiError(500, "internal_error", "Something went wrong."));
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);
  const key = `${request.method} ${pathname}`;
  const pairingPath = /^DELETE \/v1\/members\/me\/push-pairings\/([^/]+)$/.exec(key);
  if (pairingPath) {
    await revokePairing(env, await authenticate(env, request), decodeURIComponent(pairingPath[1]!));
    return new Response(null, { status: 204 });
  }
  switch (key) {
    case "POST /v1/sessions":
      return signIn(request, env);
    case "POST /v1/sessions/refresh": {
      const { memberId, tokens } = await rotateRefreshToken(env, requireString(await readJson(request), "refreshToken"));
      return json({ ...tokens, member: await memberView(env, memberId) });
    }
    case "POST /v1/sessions/revoke":
      await revokeRefreshToken(env, requireString(await readJson(request), "refreshToken"));
      return new Response(null, { status: 204 });
    case "GET /v1/members/me":
      return json({ member: await memberView(env, await authenticate(env, request)) });
    case "DELETE /v1/members/me":
      return removeMember(request, env);
    case "POST /v1/members/me/identities":
      return linkIdentity(request, env);
    case "DELETE /v1/members/me/identities/apple":
      return unlinkIdentity(request, env, "apple");
    case "DELETE /v1/members/me/identities/google":
      return unlinkIdentity(request, env, "google");
    case "GET /v1/members/me/subscription":
      return json({ subscription: await subscriptionView(env, await authenticate(env, request)) });
    case "POST /v1/members/me/subscription/app-store": {
      const memberId = await authenticate(env, request);
      const signedTransaction = requireString(await readJson(request), "signedTransaction");
      return json({ subscription: await submitAppStoreTransaction(env, memberId, signedTransaction) });
    }
    case "POST /v1/app-store/notifications":
      await handleAppStoreNotification(env, requireString(await readJson(request), "signedPayload"));
      return json({ received: true });
    case "POST /v1/members/me/push-pairings":
      await registerPairing(env, await authenticate(env, request), request);
      return json({ registered: true }, 201);
    case "POST /v1/push":
      await sendPush(env, request);
      return json({ delivered: true });
    default:
      throw new ApiError(404, "not_found", "Not found.");
  }
}

/// 從 body 讀登入憑證並驗證;Sign in with Apple 另外用 authorization code 換 refresh token。
async function verifiedCredential(
  env: Env,
  body: Record<string, unknown>,
): Promise<{ identity: VerifiedIdentity; appleRefreshToken: string | null }> {
  const provider = parseProvider(body.provider);
  const identity = await verifyIdToken(env, provider, requireString(body, "idToken"), requireString(body, "nonce"));
  const appleRefreshToken =
    provider === "apple" ? await exchangeAuthorizationCode(env, requireString(body, "authorizationCode")) : null;
  return { identity, appleRefreshToken };
}

/// POST /v1/sessions:用 Apple 或 Google 登入;沒有會員就建立一個。
async function signIn(request: Request, env: Env): Promise<Response> {
  const { identity, appleRefreshToken } = await verifiedCredential(env, await readJson(request));
  let memberId = await memberIdFor(env, identity);
  const memberCreated = memberId === null;
  if (memberId === null) {
    memberId = await createMember(env, identity, appleRefreshToken);
  } else {
    await refreshIdentity(env, identity, appleRefreshToken);
  }
  const tokens = await issueTokens(env, memberId);
  return json({ ...tokens, memberCreated, member: await memberView(env, memberId) });
}

/// POST /v1/members/me/identities:連結另一種登入方式。
///
/// 這個身分已屬於另一個會員時：對方沒有訂閱也沒有同步資料就併入並刪除對方(回傳 `mergedMemberId`),
/// 否則 409 `identity_in_use`,使用者要先登入那個會員把它刪掉(ADR-0007)。
async function linkIdentity(request: Request, env: Env): Promise<Response> {
  const memberId = await authenticate(env, request);
  const body = await readJson(request);
  const provider = parseProvider(body.provider);
  const identity = await verifyIdToken(env, provider, requireString(body, "idToken"), requireString(body, "nonce"));

  const owner = await memberIdFor(env, identity);
  if (owner === memberId) return json({ member: await memberView(env, memberId), mergedMemberId: null });
  if ((await identitiesOf(env, memberId)).some((existing) => existing.provider === provider)) {
    throw new ApiError(409, "provider_already_linked", "This member already has this sign-in method. Unlink it first.");
  }
  if (owner !== null && (await hasDataBlockingMerge(env, owner))) {
    throw identityInUse();
  }

  const appleRefreshToken =
    provider === "apple" ? await exchangeAuthorizationCode(env, requireString(body, "authorizationCode")) : null;
  if (owner === null) {
    await addIdentity(env, memberId, identity, appleRefreshToken);
    return json({ member: await memberView(env, memberId), mergedMemberId: null });
  }

  // 對方其餘的身分會跟著對方一起刪掉;其中的 Apple 身分先撤銷(盡力而為，失敗不擋合併)。
  const dropped = (await identitiesOf(env, owner)).filter((other) => other.provider !== provider || other.subject !== identity.subject);
  if (!(await absorbIdentity(env, memberId, owner, identity, appleRefreshToken))) throw identityInUse();
  for (const other of dropped) {
    if (other.apple_refresh_token) await revokeAppleToken(env, other.apple_refresh_token);
  }
  return json({ member: await memberView(env, memberId), mergedMemberId: owner });
}

function identityInUse(): ApiError {
  return new ApiError(
    409,
    "identity_in_use",
    "This sign-in method belongs to another member with a subscription or synced hosts. Sign in with it and delete that member first.",
  );
}

/// DELETE /v1/members/me/identities/{provider}:解除連結，至少保留一種登入方式。
async function unlinkIdentity(request: Request, env: Env, provider: Provider): Promise<Response> {
  const memberId = await authenticate(env, request);
  const identities = await identitiesOf(env, memberId);
  const target = identities.find((identity) => identity.provider === provider);
  if (!target) throw new ApiError(404, "identity_not_linked", "This sign-in method isn't linked.");
  if (identities.length === 1) {
    throw new ApiError(409, "last_identity", "Keep at least one sign-in method.");
  }
  await removeIdentity(env, memberId, provider);
  if (target.apple_refresh_token) await revokeAppleToken(env, target.apple_refresh_token);
  return json({ member: await memberView(env, memberId) });
}

/// DELETE /v1/members/me:刪除會員。先撤銷 Sign in with Apple 權杖(Apple 規定),成功才刪資料;
/// 撤銷失敗回 502 `apple_revoke_failed`,資料不動，讓使用者重試。Apple 訂閱不會因此取消，由 app 提醒。
async function removeMember(request: Request, env: Env): Promise<Response> {
  const memberId = await authenticate(env, request);
  for (const identity of await identitiesOf(env, memberId)) {
    if (identity.apple_refresh_token && !(await revokeAppleToken(env, identity.apple_refresh_token))) {
      throw new ApiError(502, "apple_revoke_failed", "Couldn't reach Apple to finish deleting. Try again later.");
    }
  }
  await deleteMember(env, memberId);
  return new Response(null, { status: 204 });
}
