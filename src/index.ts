import { exchangeAuthorizationCode, revokeAppleToken } from "./apple";
import { ApiError, errorResponse, json, readJson, requireString } from "./http";
import { parseProvider, verifyIdToken, type Provider, type VerifiedIdentity } from "./identity";
import {
  addIdentity,
  autoMergeTarget,
  createMember,
  deleteMember,
  identitiesOf,
  memberIdFor,
  memberView,
  refreshIdentity,
  removeIdentity,
} from "./members";
import { syncHosts } from "./host-sync";
import { mergeMembers, mergeSummary } from "./merge";
import { registerPairing, revokePairing, sendPush } from "./push";
import { listDevices, renameDevice, revokeDevice } from "./push-devices";
import { handleGooglePlayNotification, submitGooglePlayPurchase } from "./google-play";
import { handleAppStoreNotification, submitAppStoreTransaction, subscriptionView, transferSubscription } from "./subscriptions";
import {
  authenticate,
  authenticateSession,
  issueTokens,
  listSessions,
  parseDeviceId,
  parsePlatform,
  revokeOtherSession,
  revokeRefreshToken,
  rotateRefreshToken,
  signAccessToken,
} from "./tokens";

/// Purrdr 後台(ADR-0004、ADR-0007)。API 一覽見 README.md。
export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      if (error instanceof ApiError) {
        return errorResponse(error);
      }
      console.error(error);
      return errorResponse(new ApiError(500, "internal_error", "Something went wrong."));
    }
  },
} satisfies ExportedHandler<Env>;

/// App Store 通知來自 Apple 的伺服器、Google Play 通知來自 Pub/Sub(IP 共用且被擋會延後訂閱狀態),而且都要驗簽章或 OIDC token，不限流。
const RATE_LIMIT_EXEMPT = new Set(["POST /v1/app-store/notifications", "POST /v1/google-play/notifications"]);
const RATE_LIMIT_PERIOD_SECONDS = 60;

/// 每個 IP 60 秒最多 60 次(#2)。沒有 `CF-Connecting-IP` 只會是本機(Cloudflare 一律會帶),不限流。
async function enforceIpRateLimit(request: Request, env: Env, key: string): Promise<void> {
  const ip = request.headers.get("cf-connecting-ip");
  if (!ip || RATE_LIMIT_EXEMPT.has(key)) {
    return;
  }
  const { success } = await env.IP_RATE_LIMITER.limit({ key: ip });
  if (!success) {
    throw new ApiError(429, "rate_limited", "Too many requests. Try again later.", { "retry-after": `${RATE_LIMIT_PERIOD_SECONDS}` });
  }
}

/// 路徑片段解碼;壞的 escape(例如 `%E0%A4%A`)回 400 而不是 500。
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new ApiError(400, "invalid_request", "Malformed path.");
  }
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  const key = `${request.method} ${pathname}`;
  await enforceIpRateLimit(request, env, key);
  const pairingPath = /^DELETE \/v1\/members\/me\/push-pairings\/([^/]+)$/.exec(key);
  if (pairingPath) {
    await revokePairing(env, await authenticate(env, request), decodeSegment(pairingPath[1]!));
    return new Response(null, { status: 204 });
  }
  const devicePath = /^(DELETE|PATCH) \/v1\/members\/me\/push-devices\/([^/]+)$/.exec(key);
  if (devicePath?.[1] === "DELETE") {
    await revokeDevice(env, await authenticate(env, request), decodeSegment(devicePath[2]!));
    return new Response(null, { status: 204 });
  }
  if (devicePath?.[1] === "PATCH") {
    const memberId = await authenticate(env, request);
    return json({ device: await renameDevice(env, memberId, decodeSegment(devicePath[2]!), request, url.searchParams.get("currentDeviceId")) });
  }
  const sessionPath = /^DELETE \/v1\/members\/me\/sessions\/([^/]+)$/.exec(key);
  if (sessionPath) {
    const { memberId, sessionId } = await authenticateSession(env, request);
    await revokeOtherSession(env, memberId, sessionId, decodeSegment(sessionPath[1]!));
    return new Response(null, { status: 204 });
  }
  switch (key) {
    case "GET /v1/members/me/sessions": {
      const { memberId, sessionId } = await authenticateSession(env, request);
      return json({ sessions: await listSessions(env, memberId, sessionId) });
    }
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
    case "POST /v1/members/me/identities/merge":
      return confirmMerge(request, env);
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
    case "POST /v1/members/me/subscription/google-play": {
      const memberId = await authenticate(env, request);
      const body = await readJson(request);
      return json({ subscription: await submitGooglePlayPurchase(env, memberId, requireString(body, "purchaseToken"), requireString(body, "productId")) });
    }
    case "POST /v1/members/me/subscription/transfer": {
      const memberId = await authenticate(env, request);
      const signedTransaction = requireString(await readJson(request), "signedTransaction");
      return json(await transferSubscription(env, memberId, signedTransaction));
    }
    case "POST /v1/members/me/hosts/sync":
      return json(await syncHosts(env, await authenticate(env, request), request));
    case "POST /v1/app-store/notifications":
      await handleAppStoreNotification(env, requireString(await readJson(request), "signedPayload"));
      return json({ received: true });
    case "POST /v1/google-play/notifications":
      await handleGooglePlayNotification(env, request);
      return json({ received: true });
    case "POST /v1/members/me/push-pairings":
      await registerPairing(env, await authenticate(env, request), request);
      return json({ registered: true }, 201);
    case "GET /v1/members/me/push-devices": {
      const memberId = await authenticate(env, request);
      return json({ devices: await listDevices(env, memberId, url.searchParams.get("currentDeviceId")) });
    }
    case "POST /v1/push":
      return json({ delivered: await sendPush(env, request) });
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
///
/// 新身分的 email 已驗證且非私密轉寄、另一個會員有相同的已驗證 email(不分大小寫)時,歸到那個會員並新增這個身分
/// (`autoLinked: true`);規則見 `autoMergeTarget`。選填 `deviceId`(app Keychain 的 UUID)與 `platform`(ios|android,預設 ios)。
/// 選填 `createMember`(布林,預設 true):帶 false 是「只登入」,查無會員(含沒有可自動合併的對象)時回 404 `member_not_found`、不建立任何資料。
async function signIn(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const mayCreateMember = parseCreateMember(body.createMember);
  const deviceId = parseDeviceId(body.deviceId);
  const platform = parsePlatform(body.platform);
  const { identity, appleRefreshToken } = await verifiedCredential(env, body);
  let memberId = await memberIdFor(env, identity);
  let memberCreated = false;
  let autoLinked = false;
  if (memberId !== null) {
    await refreshIdentity(env, identity, appleRefreshToken);
  } else {
    const target = await autoMergeTarget(env, identity);
    if (target === null) {
      if (!mayCreateMember) {
        throw new ApiError(404, "member_not_found", "No member for this account. Join first.");
      }
      memberId = await createMember(env, identity, appleRefreshToken);
      memberCreated = true;
    } else {
      await addIdentity(env, target, identity, appleRefreshToken);
      memberId = target;
      autoLinked = true;
    }
  }
  const tokens = await issueTokens(env, memberId, deviceId, platform);
  return json({ ...tokens, memberCreated, autoLinked, member: await memberView(env, memberId) });
}

/// 登入 body 選填的 `createMember`:沒帶(或 undefined)視為 true;不是布林 400。
function parseCreateMember(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (typeof value !== "boolean") {
    throw new ApiError(400, "invalid_request", "createMember must be a boolean.");
  }
  return value;
}

/// 連結與確認合併共用:驗證憑證(不換 Apple authorization code,確定要做才換),回傳這個身分目前屬於誰。
async function linkingCredential(request: Request, env: Env) {
  const { memberId, sessionId } = await authenticateSession(env, request);
  const body = await readJson(request);
  const provider = parseProvider(body.provider);
  const identity = await verifyIdToken(env, provider, requireString(body, "idToken"), requireString(body, "nonce"));
  const exchange = async () => (provider === "apple" ? exchangeAuthorizationCode(env, requireString(body, "authorizationCode")) : null);
  return { memberId, sessionId, provider, identity, owner: await memberIdFor(env, identity), exchange };
}

/// POST /v1/members/me/identities:連結另一種登入方式。
///
/// 這個身分已屬於另一個會員時不直接合併:回 409 `merge_required`,`error.details` 是兩個會員的摘要
/// (見 `mergeSummary`),由使用者確認後再呼叫 `POST /v1/members/me/identities/merge`。
async function linkIdentity(request: Request, env: Env): Promise<Response> {
  const { memberId, provider, identity, owner, exchange } = await linkingCredential(request, env);
  if (owner === memberId) {
    return json({ member: await memberView(env, memberId), mergedMemberId: null });
  }
  if ((await identitiesOf(env, memberId)).some((existing) => existing.provider === provider)) {
    throw new ApiError(409, "provider_already_linked", "This member already has this sign-in method. Unlink it first.");
  }
  if (owner !== null) {
    throw new ApiError(
      409,
      "merge_required",
      "This sign-in method belongs to another member. Confirm to merge the two members.",
      {},
      await mergeSummary(env, memberId, owner),
    );
  }
  await addIdentity(env, memberId, identity, await exchange());
  return json({ member: await memberView(env, memberId), mergedMemberId: null });
}

/// POST /v1/members/me/identities/merge:確認合併(body 同連結,要重新帶憑證)。規則見 `mergeMembers`。
/// 回 `{ member, mergedMemberId, accessToken, accessTokenExpiresAt }`:留下的可能是對方,原本的存取權杖屬於被刪的會員,
/// 所以回應附留下會員的新存取權杖;更新權杖不變。
async function confirmMerge(request: Request, env: Env): Promise<Response> {
  const { memberId, sessionId, provider, identity, owner, exchange } = await linkingCredential(request, env);
  if (owner === null || owner === memberId) {
    throw new ApiError(409, "no_merge_needed", "This sign-in method doesn't belong to another member.");
  }
  // 與連結一致:目前會員已有這個提供者時拒絕,否則合併會悄悄丟掉其中一個(可能是剛驗證的那個,Apple authorization code 也已消耗)。
  if ((await identitiesOf(env, memberId)).some((existing) => existing.provider === provider)) {
    throw new ApiError(409, "provider_already_linked", "This member already has this sign-in method. Unlink it first.");
  }
  const { survivorId, mergedMemberId } = await mergeMembers(env, memberId, owner, identity, exchange);
  return json({ ...(await signAccessToken(env, survivorId, sessionId)), member: await memberView(env, survivorId), mergedMemberId });
}

/// DELETE /v1/members/me/identities/{provider}:解除連結，至少保留一種登入方式。
async function unlinkIdentity(request: Request, env: Env, provider: Provider): Promise<Response> {
  const memberId = await authenticate(env, request);
  const identities = await identitiesOf(env, memberId);
  const target = identities.find((identity) => identity.provider === provider);
  if (!target) {
    throw new ApiError(404, "identity_not_linked", "This sign-in method isn't linked.");
  }
  if (identities.length === 1) {
    throw new ApiError(409, "last_identity", "Keep at least one sign-in method.");
  }
  await removeIdentity(env, memberId, provider);
  if (target.apple_refresh_token) {
    await revokeAppleToken(env, target.apple_refresh_token);
  }
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
