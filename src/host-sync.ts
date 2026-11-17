import { ApiError, readJson } from "./http";
import { requireActiveSubscription } from "./subscriptions";

/// 主機同步(#30、ADR-0007):會員各裝置共用的主機清單。
///
/// - app 送出這支裝置還沒同步的變更(新增／修改／刪除),後台套用後回傳會員目前的整份清單與刪除紀錄。
/// - 以單一主機為單位最後修改者勝：比 app 端的修改時間(`modifiedAt`),新的才取代舊的;一樣新時保留已存的。
/// - 刪除留紀錄：之後同一個 id 的上傳一律忽略，還沒同步到刪除的裝置傳不回來。
/// - 只收白名單欄位，多一個欄位整個請求 400:私鑰、密碼(或任何不在清單上的東西)進不來。
/// - 要有效的 Purrdr Plus(讀取也是)。
/// - HTTPS 主機(#63)只回給請求帶 `connectionMethods` 含 `https` 的 app;舊版 app 看不到，以免整個同步解析失敗。

export type SyncedHostView = {
  id: string;
  name: string;
  address: string;
  port: number;
  username: string;
  connectionMethod: ConnectionMethod;
  hostKeyFingerprint: string | null;
  /// 只有 HTTPS 主機有。
  hostServiceAddress?: string;
  modifiedAt: string;
};

type ConnectionMethod = "tailscale_ssh" | "openssh" | "https";

type Row = {
  host_id: string;
  name: string | null;
  address: string | null;
  port: number | null;
  username: string | null;
  connection_method: ConnectionMethod | null;
  host_key_fingerprint: string | null;
  host_service_address: string | null;
  modified_at: number;
  deleted_at: number | null;
};

type Upsert = {
  id: string;
  name: string;
  address: string;
  port: number;
  username: string;
  connectionMethod: ConnectionMethod;
  hostKeyFingerprint: string | null;
  hostServiceAddress: string | null;
  modifiedAt: number;
};

type Change = ({ kind: "upsert" } & Upsert) | { kind: "delete"; id: string };

/// 一次最多幾筆變更(主機清單很短;擋住異常大的請求)。
export const MAX_CHANGES = 200;

/// POST /v1/members/me/hosts/sync:套用這支裝置的變更，回傳會員目前的主機清單與刪除紀錄。
export async function syncHosts(env: Env, memberId: string, request: Request, now = Date.now()) {
  await requireActiveSubscription(env, memberId, now);
  const body = await readJson(request);
  onlyFields(body, ["changes", "connectionMethods"]);
  if (!Array.isArray(body.changes)) throw invalid("changes must be an array.");
  const understood = understoodMethods(body.connectionMethods);
  if (body.changes.length > MAX_CHANGES) throw invalid(`At most ${MAX_CHANGES} changes per request.`);
  // 先全部檢查過才寫入：任何一筆不合法，整個請求不動資料。
  const changes = body.changes.map((change) => parseChange(change, now));
  if (changes.length > 0) {
    await env.DB.batch(changes.map((change) => statement(env, memberId, change, now)));
  }
  return hostsOf(env, memberId, understood);
}

/// app 看得懂的連線方式。沒帶是 HTTPS 之前的舊版 app。
function understoodMethods(value: unknown): ReadonlySet<string> {
  if (value === undefined) return LEGACY_CONNECTION_METHODS;
  if (!Array.isArray(value) || !value.every((method) => typeof method === "string")) {
    throw invalid("connectionMethods must be an array of strings.");
  }
  return new Set(value);
}

function statement(env: Env, memberId: string, change: Change, now: number): D1PreparedStatement {
  if (change.kind === "delete") {
    // 刪除留紀錄：欄位清空，只留 id 與時間。已刪除的不再更新。
    return env.DB.prepare(
      `INSERT INTO synced_hosts (member_id, host_id, modified_at, deleted_at, updated_at) VALUES (?1, ?2, ?3, ?3, ?3)
       ON CONFLICT (member_id, host_id) DO UPDATE SET
         name = NULL, address = NULL, port = NULL, username = NULL, connection_method = NULL, host_key_fingerprint = NULL,
         host_service_address = NULL, modified_at = ?3, deleted_at = ?3, updated_at = ?3
       WHERE synced_hosts.deleted_at IS NULL`,
    ).bind(memberId, change.id, now);
  }
  // 最後修改者勝：比已存的新才取代;已刪除的主機不復活。
  return env.DB.prepare(
    `INSERT INTO synced_hosts (member_id, host_id, name, address, port, username, connection_method, host_key_fingerprint,
       modified_at, updated_at, host_service_address)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
     ON CONFLICT (member_id, host_id) DO UPDATE SET
       name = ?3, address = ?4, port = ?5, username = ?6, connection_method = ?7, host_key_fingerprint = ?8,
       modified_at = ?9, updated_at = ?10, host_service_address = ?11
     WHERE synced_hosts.deleted_at IS NULL AND synced_hosts.modified_at < ?9`,
  ).bind(
    memberId, change.id, change.name, change.address, change.port, change.username, change.connectionMethod,
    change.hostKeyFingerprint, change.modifiedAt, now, change.hostServiceAddress,
  );
}

async function hostsOf(env: Env, memberId: string, understood: ReadonlySet<string>): Promise<{ hosts: SyncedHostView[]; deletedHostIds: string[] }> {
  const { results } = await env.DB.prepare("SELECT * FROM synced_hosts WHERE member_id = ? ORDER BY host_id").bind(memberId).all<Row>();
  const hosts: SyncedHostView[] = [];
  const deletedHostIds: string[] = [];
  for (const row of results) {
    if (row.deleted_at !== null) {
      deletedHostIds.push(row.host_id);
      continue;
    }
    if (!understood.has(row.connection_method!)) continue;
    const host: SyncedHostView = {
      id: row.host_id,
      name: row.name!,
      address: row.address!,
      port: row.port!,
      username: row.username!,
      connectionMethod: row.connection_method!,
      hostKeyFingerprint: row.host_key_fingerprint,
      modifiedAt: new Date(row.modified_at).toISOString(),
    };
    if (row.host_service_address !== null) host.hostServiceAddress = row.host_service_address;
    hosts.push(host);
  }
  return { hosts, deletedHostIds };
}

// MARK: - 檢查

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/// SHA-256 的標準 base64、不補等號(與 `ssh-keygen -lf` 的 `SHA256:` 之後相同)。
const FINGERPRINT = /^[A-Za-z0-9+/]{43}$/;
const LEGACY_CONNECTION_METHODS: ReadonlySet<string> = new Set(["tailscale_ssh", "openssh"]);
const CONNECTION_METHODS: ReadonlySet<string> = new Set(["tailscale_ssh", "openssh", "https"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/// 欄位白名單：同步內容永遠只有這些(主機名稱、位址與埠、使用者名稱、連線方式、host key 指紋)。
const UPSERT_FIELDS = ["id", "name", "address", "port", "username", "connectionMethod", "hostKeyFingerprint", "modifiedAt"];
/// HTTPS 主機多一個主機服務位址;裝置權杖不在白名單裡。
const HTTPS_UPSERT_FIELDS = [...UPSERT_FIELDS, "hostServiceAddress"];
const DELETE_FIELDS = ["id", "deleted"];

function parseChange(value: unknown, now: number): Change {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid("Each change must be an object.");
  const change = value as Record<string, unknown>;
  const id = change.id;
  if (typeof id !== "string" || !UUID.test(id)) throw invalid("id must be a UUID.");
  if ("deleted" in change) {
    onlyFields(change, DELETE_FIELDS);
    if (change.deleted !== true) throw invalid("deleted must be true.");
    return { kind: "delete", id: id.toLowerCase() };
  }
  const isHttps = change.connectionMethod === "https";
  onlyFields(change, isHttps ? HTTPS_UPSERT_FIELDS : UPSERT_FIELDS);
  const port = change.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) throw invalid("port must be 1–65535.");
  const method = change.connectionMethod;
  if (typeof method !== "string" || !CONNECTION_METHODS.has(method)) throw invalid("Unknown connectionMethod.");
  const fingerprint = change.hostKeyFingerprint ?? null;
  if (fingerprint !== null && (typeof fingerprint !== "string" || !FINGERPRINT.test(fingerprint))) {
    throw invalid("hostKeyFingerprint must be an unpadded SHA-256 base64.");
  }
  if (isHttps && fingerprint !== null) throw invalid("HTTPS hosts have no hostKeyFingerprint.");
  const modifiedAt = typeof change.modifiedAt === "string" && ISO_DATE.test(change.modifiedAt) ? Date.parse(change.modifiedAt) : NaN;
  if (Number.isNaN(modifiedAt)) throw invalid("modifiedAt must be an ISO 8601 time.");
  return {
    kind: "upsert",
    id: id.toLowerCase(),
    name: text(change, "name", 100),
    address: text(change, "address", 253),
    port,
    // HTTPS 主機沒有使用者名稱。
    username: isHttps ? emptyUsername(change) : text(change, "username", 64),
    connectionMethod: method as ConnectionMethod,
    hostKeyFingerprint: fingerprint as string | null,
    hostServiceAddress: isHttps ? hostServiceAddress(change.hostServiceAddress) : null,
    // 裝置時鐘跑到未來時以後台收到的時間為上限，避免那支裝置的修改永遠贏。
    modifiedAt: Math.min(modifiedAt, now),
  };
}

function emptyUsername(change: Record<string, unknown>): string {
  if (change.username !== "") throw invalid("HTTPS hosts have an empty username.");
  return "";
}

/// 與 app 的 `HostServiceAddress` 相同：https(本機測試可用 http 的 loopback),只有 scheme、主機與埠。
function hostServiceAddress(value: unknown): string {
  const problem = invalid("hostServiceAddress must be an HTTPS address.");
  if (typeof value !== "string" || value.length > 300 || /[?#]/.test(value)) throw problem;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw problem;
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  const schemeAllowed = url.protocol === "https:" || (url.protocol === "http:" && loopback);
  const onlyOrigin = url.username === "" && url.password === "" && url.pathname === "/";
  if (!schemeAllowed || !onlyOrigin || url.hostname === "") throw problem;
  return value;
}

function text(change: Record<string, unknown>, field: string, maxLength: number): string {
  const value = change[field];
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw invalid(`${field} must be 1–${maxLength} characters.`);
  }
  return value;
}

/// 多一個欄位就拒絕：同步內容進不來白名單以外的東西(私鑰、密碼…)。
function onlyFields(object: Record<string, unknown>, allowed: readonly string[]) {
  const extra = Object.keys(object).filter((key) => !allowed.includes(key));
  if (extra.length > 0) throw invalid(`Unexpected field: ${extra.join(", ")}.`);
}

function invalid(message: string): ApiError {
  return new ApiError(400, "invalid_request", message);
}
