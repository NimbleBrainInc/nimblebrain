import { describe, expect, test } from "bun:test";
import { buildCSP, createAppIframe } from "../iframe.ts";

describe("createAppIframe sandbox", () => {
  function sandboxTokens(): string[] {
    const iframe = createAppIframe("<p>hi</p>", "test-app");
    return (iframe.getAttribute("sandbox") ?? "").split(/\s+/).filter(Boolean);
  }

  // Security regression pin: with `srcdoc`, `allow-same-origin` would make the
  // third-party app frame same-origin with the host — a full sandbox escape
  // (read window.parent, ride the session cookie, remove its own sandbox).
  test("does NOT grant allow-same-origin (app runs in an opaque origin)", () => {
    expect(sandboxTokens()).not.toContain("allow-same-origin");
  });

  test("still grants allow-scripts (the app is an interactive UI)", () => {
    expect(sandboxTokens()).toContain("allow-scripts");
  });
});

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
    const csp = buildCSP({
      connectDomains: ["https://api.example.com", "https://cdn.example.com"],
    });
    expect(csp).toContain("connect-src https://api.example.com https://cdn.example.com");
  });

  test("returns connect-src 'none' when no domains provided", () => {
    const csp = buildCSP();
    expect(csp).toContain("connect-src 'none'");
  });

  test("returns connect-src 'none' for empty domains array", () => {
    const csp = buildCSP({ connectDomains: [] });
    expect(csp).toContain("connect-src 'none'");
  });
});
