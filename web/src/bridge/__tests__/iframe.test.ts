import { describe, expect, test } from "bun:test";
import { buildCSP } from "../iframe.ts";

describe("buildCSP", () => {
  test("does not contain unsafe-eval", () => {
    const csp = buildCSP();
    expect(csp).not.toContain("unsafe-eval");
  });

  test("contains unsafe-inline for bridge communication", () => {
    const csp = buildCSP();
    expect(csp).toContain("'unsafe-inline'");
  });

  test("includes connect domains when provided", () => {
    const csp = buildCSP(["https://api.example.com", "https://cdn.example.com"]);
    expect(csp).toContain("connect-src https://api.example.com https://cdn.example.com");
  });

  test("returns connect-src 'none' when no domains provided", () => {
    const csp = buildCSP();
    expect(csp).toContain("connect-src 'none'");
  });

  test("returns connect-src 'none' for empty domains array", () => {
    const csp = buildCSP([]);
    expect(csp).toContain("connect-src 'none'");
  });
});
