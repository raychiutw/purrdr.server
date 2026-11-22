import { describe, expect, it } from "vitest";
import { maskEmail } from "../src/mask-email";

describe("遮蔽 email", () => {
  it.each([
    ["ray@example.com", "r***@example.com"],
    ["Ray.Chiu+tag@Example.COM", "R***@Example.COM"],
    ["a@b.co", "a***@b.co"],
  ])("%s → %s", (email, masked) => {
    expect(maskEmail(email)).toBe(masked);
  });

  it("沒有 email 或不像 email 時回 null,不洩漏原文", () => {
    expect(maskEmail(null)).toBeNull();
    expect(maskEmail("")).toBeNull();
    expect(maskEmail("no-at-sign")).toBeNull();
    expect(maskEmail("@example.com")).toBeNull();
    expect(maskEmail("ray@")).toBeNull();
  });
});
