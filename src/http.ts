/// 錯誤一律回 `{ "error": { "code", "message" } }`;`code` 是給 app 判斷的穩定字串，`message` 只給人看。
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** 額外的回應 header(例如 429 的 `retry-after`)。 */
    readonly headers: Record<string, string> = {},
    /** 額外的結構化內容(例如合併確認的摘要),放在回應的 `error.details`。 */
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...headers, "cache-control": "no-store" } });
}

export function errorResponse(error: ApiError): Response {
  const body = { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) };
  return json({ error: body }, error.status, error.headers);
}

/// 讀 JSON body,並確認是物件。
export async function readJson(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ApiError(400, "invalid_request", "Request body must be JSON.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ApiError(400, "invalid_request", "Request body must be a JSON object.");
  }
  return body as Record<string, unknown>;
}

export function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new ApiError(400, "invalid_request", `Missing field: ${field}.`);
  }
  return value;
}

export function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ApiError(400, "invalid_request", `Field ${field} must be a string.`);
  }
  return value;
}
