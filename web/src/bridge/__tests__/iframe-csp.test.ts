import { describe, expect, it, mock, spyOn } from "bun:test";
import { buildCSP, isValidCspDomain } from "../iframe.ts";

describe("buildCSP", () => {
  it("with no options, returns the strict default (no network, no frames)", () => {
    const csp = buildCSP();
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-src blob:");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("default-src 'none'");
  });

  it("adds connect-src when connectDomains provided", () => {
    const csp = buildCSP({ connectDomains: ["http://x", "wss://y"] });
    expect(csp).toContain("connect-src http://x wss://y");
  });

  it("adds frame-src entries alongside blob: when frameDomains provided", () => {
    const csp = buildCSP({ frameDomains: ["http://x"] });
    expect(csp).toContain("frame-src blob: http://x");
  });

  it("extends all resource-src directives when resourceDomains provided", () => {
    const csp = buildCSP({ resourceDomains: ["http://cdn"] });
    // Each of script/style/img/font gets the domain appended
    expect(csp).toMatch(/script-src[^;]*http:\/\/cdn/);
    expect(csp).toMatch(/style-src[^;]*http:\/\/cdn/);
    expect(csp).toMatch(/img-src[^;]*http:\/\/cdn/);
    expect(csp).toMatch(/font-src[^;]*http:\/\/cdn/);
  });

  it("sets base-uri from baseUriDomains when provided", () => {
    const csp = buildCSP({ baseUriDomains: ["http://b"] });
    expect(csp).toContain("base-uri http://b");
  });

  it("combines multiple declarations in a single CSP", () => {
    const csp = buildCSP({
      connectDomains: ["http://a"],
      frameDomains: ["http://b"],
      resourceDomains: ["http://c"],
      baseUriDomains: ["http://d"],
    });
    expect(csp).toContain("connect-src http://a");
    expect(csp).toContain("frame-src blob: http://b");
    expect(csp).toMatch(/script-src[^;]*http:\/\/c/);
    expect(csp).toContain("base-uri http://d");
  });
});

describe("isValidCspDomain", () => {
  it("accepts valid http/https/ws/wss URLs", () => {
    expect(isValidCspDomain("http://localhost:9991")).toBe(true);
    expect(isValidCspDomain("https://api.example.com")).toBe(true);
    expect(isValidCspDomain("ws://localhost:9991")).toBe(true);
    expect(isValidCspDomain("wss://realtime.service.com")).toBe(true);
    expect(isValidCspDomain("https://*.example.com")).toBe(true); // wildcard subdomain
    expect(isValidCspDomain("https://api.example.com/path")).toBe(true);
  });

  it("rejects CSP-directive injection attempts", () => {
    // Semicolons split directives — classic injection vector
    expect(isValidCspDomain("https://x; script-src *")).toBe(false);
    // Spaces are source-list separators
    expect(isValidCspDomain("https://x https://evil.com")).toBe(false);
    // Quotes escape the `<meta content="...">` attribute
    expect(isValidCspDomain('https://x" onerror=alert(1)')).toBe(false);
    expect(isValidCspDomain("https://x' self")).toBe(false);
  });

  it("rejects CSP keywords and wildcards that relax the policy", () => {
    expect(isValidCspDomain("*")).toBe(false);
    expect(isValidCspDomain("'unsafe-inline'")).toBe(false);
    expect(isValidCspDomain("'unsafe-eval'")).toBe(false);
    expect(isValidCspDomain("'self'")).toBe(false);
    expect(isValidCspDomain("'none'")).toBe(false);
  });

  it("rejects unsupported schemes", () => {
    expect(isValidCspDomain("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(isValidCspDomain("blob:foo")).toBe(false);
    expect(isValidCspDomain("javascript:alert(1)")).toBe(false);
    expect(isValidCspDomain("file:///etc/passwd")).toBe(false);
  });

  it("rejects empty / non-string inputs", () => {
    expect(isValidCspDomain("")).toBe(false);
    expect(isValidCspDomain(undefined as unknown as string)).toBe(false);
  });
});

describe("buildCSP rejects malicious declarations", () => {
  it("drops a server declaration that tries to inject a second directive", () => {
    // Silence the expected `[iframe-csp] dropping invalid ...` warning so the
    // test output stays clean; the rejection itself is what we're asserting.
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const csp = buildCSP({
        connectDomains: ["https://legit.example.com", "https://x; script-src *"],
      });
      // Legit entry survives; injection entry is dropped
      expect(csp).toContain("connect-src https://legit.example.com");
      expect(csp).not.toContain("script-src *");
      // And a warning fires so operators see the misconfiguration
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("produces a fully-defaulted CSP when every declared domain is invalid", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const csp = buildCSP({
        connectDomains: ["*", "'unsafe-inline'", "data:text/html"],
        frameDomains: ["*"],
        resourceDomains: ["javascript:alert(1)"],
      });
      // All rejected → directives collapse to strict defaults
      expect(csp).toContain("connect-src 'none'");
      expect(csp).toContain("frame-src blob:"); // no extras
      expect(csp).not.toContain("javascript:");
    } finally {
      warn.mockRestore();
    }
  });
});
