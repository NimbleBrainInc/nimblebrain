import { describe, expect, it } from "bun:test";
import { buildCSP } from "../iframe.ts";

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
