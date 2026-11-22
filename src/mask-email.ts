/// 遮蔽 email 給「屬於其他會員」「合併確認」這類回應用:只留第一個字元與網域,例如 `r***@example.com`。
/// 沒有 email 或格式不對回 null(不洩漏原文)。
export function maskEmail(email: string | null): string | null {
  if (email === null) {
    return null;
  }
  const at = email.lastIndexOf("@");
  if (at < 1 || at === email.length - 1) {
    return null;
  }
  return `${email[0]}***${email.slice(at)}`;
}
