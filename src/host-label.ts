import { ApiError } from "./http";

/// 配對的電腦名稱與主機圖示(purrdr.server#39、ADR-0016)。只存名稱、系統圖示代號與顏色,不存位址、IP 或任何連線資訊。

export const MAX_HOST_NAME_LENGTH = 64;
/// SF Symbol 代號:字母、數字與 `.`。
const ICON_SYMBOL = /^[A-Za-z0-9.]{1,64}$/;
/// 顏色:`#RRGGBB` 或短名稱(字母開頭、字母數字,最長 32 字元,例如 `blue`)。
const ICON_COLOR = /^(#[0-9A-Fa-f]{6}|[A-Za-z][A-Za-z0-9]{0,31})$/;

export type HostIcon = { symbol: string; color: string };

function invalid(message: string): ApiError {
  return new ApiError(400, "invalid_request", message);
}

/// 選填的顯示名稱:控制字元(含換行、跳格、Unicode 行／段分隔符)換成空白後修掉頭尾,剩下空的當成沒有名稱;
/// 最長 `max` 個字元(以 code point 計)。不是字串或太長回 400。沒帶回 `undefined`。
export function readLabel(value: unknown, field: string, max: number): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw invalid(`${field} must be a string.`);
  }
  const cleaned = value.replace(/[\p{Cc}\u2028\u2029]+/gu, " ").trim();
  if ([...cleaned].length > max) {
    throw invalid(`${field} is too long.`);
  }
  return cleaned === "" ? null : cleaned;
}

/// 請求裡的 `icon`:`{ symbol, color }`(兩個都要);沒帶回 `undefined`,`null` 表示清掉。
export function readIcon(value: unknown): HostIcon | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw invalid("icon must be an object with symbol and color.");
  }
  const { symbol, color } = value as Record<string, unknown>;
  if (typeof symbol !== "string" || !ICON_SYMBOL.test(symbol)) {
    throw invalid("icon.symbol must be an SF Symbol name (letters, digits and dots, up to 64 characters).");
  }
  if (typeof color !== "string" || !ICON_COLOR.test(color)) {
    throw invalid("icon.color must be #RRGGBB or a short color name.");
  }
  return { symbol, color };
}

export function iconView(symbol: string | null, color: string | null): HostIcon | null {
  return symbol === null || color === null ? null : { symbol, color };
}
