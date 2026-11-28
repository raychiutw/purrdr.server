import { ApiError } from "./http";

/// 通知種類清單(purrdr.server#39、ADR-0016):種類存在 `push_kinds` 資料表,註冊與修改配對時以它為準。
/// 新增種類只要在資料表加一列(migration),不必改程式。

export type PushKindView = {
  code: string;
  name: { en: string; "zh-Hant": string };
  description: { en: string; "zh-Hant": string };
  defaultOn: boolean;
  transports: string[];
  minServiceVersion: string | null;
  minPluginVersion: string | null;
  order: number;
};

type KindRow = {
  code: string;
  name_en: string;
  name_zh: string;
  description_en: string;
  description_zh: string;
  default_on: number;
  transports: string;
  min_service_version: string | null;
  min_plugin_version: string | null;
  sort_order: number;
};

/// 沒帶 `kinds` 的新配對(舊版 app)只收「需要你」,加上「今日已達上限」(舊版 app 本來就收得到這則通知)。
export const LEGACY_DEFAULT_KINDS: readonly string[] = ["blocked", "daily_limit_reached"];

function invalid(message: string): ApiError {
  return new ApiError(400, "invalid_request", message);
}

/// GET /v1/push-kinds:依順序、不含停用的種類。
export async function listKinds(env: Env): Promise<PushKindView[]> {
  const { results } = await env.DB.prepare(
    `SELECT code, name_en, name_zh, description_en, description_zh, default_on, transports, min_service_version, min_plugin_version, sort_order
     FROM push_kinds WHERE disabled = 0 ORDER BY sort_order, code`,
  ).all<KindRow>();
  return results.map((row) => ({
    code: row.code,
    name: { en: row.name_en, "zh-Hant": row.name_zh },
    description: { en: row.description_en, "zh-Hant": row.description_zh },
    defaultOn: row.default_on === 1,
    transports: parseStringArray(row.transports),
    minServiceVersion: row.min_service_version,
    minPluginVersion: row.min_plugin_version,
    order: row.sort_order,
  }));
}

function parseStringArray(text: string): string[] {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/// 目前可用(未停用)的種類代號。
export async function activeKindCodes(env: Env): Promise<Set<string>> {
  const { results } = await env.DB.prepare("SELECT code FROM push_kinds WHERE disabled = 0").all<{ code: string }>();
  return new Set(results.map((row) => row.code));
}

/// 請求裡的 `kinds`:要是字串陣列,而且每一種都在清單裡(未知或已停用 → 400);去重後存成 JSON 字串。
/// `skipDisabled`(註冊配對用):已知但停用的代號略過、其餘照存,舊 app 的註冊不會整個失敗;未知代號仍 400。
export async function readKinds(env: Env, value: unknown, options: { skipDisabled?: boolean } = {}): Promise<string> {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw invalid("kinds must be an array of notification kind codes.");
  }
  const active = await activeKindCodes(env);
  let accepted: string[] = value;
  if (options.skipDisabled === true) {
    const { results } = await env.DB.prepare("SELECT code FROM push_kinds").all<{ code: string }>();
    const known = new Set(results.map((row) => row.code));
    const unknown = value.find((code) => !known.has(code));
    if (unknown !== undefined) {
      throw invalid(`Unsupported kind: ${unknown}.`);
    }
    accepted = value.filter((code) => active.has(code));
  }
  const unsupported = accepted.find((code) => !active.has(code));
  if (unsupported !== undefined) {
    throw invalid(`Unsupported kind: ${unsupported}.`);
  }
  return JSON.stringify([...new Set(accepted)]);
}

/// D1 存的是 JSON 字串;只留清單裡還可用的種類,舊資料或手改的值不會讓推播出錯。
export function storedKinds(text: string, active: Set<string>): string[] {
  return parseStringArray(text).filter((code) => active.has(code));
}
