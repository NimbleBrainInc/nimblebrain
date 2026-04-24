import { describe, test, expect } from "bun:test";
import {
  injectThemeStyles,
  injectCSP,
  buildCSP,
} from "../../../web/src/bridge/iframe.ts";

const FULL_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Test App</title>
</head>
<body>
  <p>Hello</p>
</body>
</html>`;

const NO_HEAD_HTML = `<div>fragment content</div>`;

describe("injectThemeStyles", () => {
  test("inserts <style> with --color-background-primary into HTML with <head>", () => {
    const result = injectThemeStyles(FULL_HTML, "light");
    expect(result).toContain("<style>");
    expect(result).toContain("--color-background-primary");
    // Style tag should appear after <head>
    const headIdx = result.indexOf("<head>");
    const styleIdx = result.indexOf("<style>");
    expect(styleIdx).toBeGreaterThan(headIdx);
  });

  test("works on HTML without <head> by prepending", () => {
    const result = injectThemeStyles(NO_HEAD_HTML, "light");
    expect(result).toContain("<style>");
    expect(result).toContain("--color-background-primary");
    // Style tag should be at the start
    expect(result.indexOf("<style>")).toBe(0);
    // Original content preserved
    expect(result).toContain("<div>fragment content</div>");
  });

  test("light mode contains light token values", () => {
    const result = injectThemeStyles(FULL_HTML, "light");
    expect(result).toContain("--color-background-primary: #faf9f7;");
    expect(result).toContain("--color-text-accent: #0055FF;");
    expect(result).toContain("--color-text-primary: #171717;");
  });

  test("dark mode contains dark token values", () => {
    const result = injectThemeStyles(FULL_HTML, "dark");
    expect(result).toContain("--color-background-primary: #0a0a09;");
    expect(result).toContain("--color-text-accent: #3b8eff;");
    expect(result).toContain("--color-text-primary: #e5e5e5;");
  });

  test("preserves original HTML content", () => {
    const result = injectThemeStyles(FULL_HTML, "light");
    expect(result).toContain("<title>Test App</title>");
    expect(result).toContain("<p>Hello</p>");
  });
});

describe("injectThemeStyles + injectCSP don't clobber each other", () => {
  test("theme first, then CSP — both present", () => {
    const themed = injectThemeStyles(FULL_HTML, "dark");
    const csp = buildCSP();
    const result = injectCSP(themed, csp);

    expect(result).toContain("<style>");
    expect(result).toContain("--color-background-primary");
    expect(result).toContain('http-equiv="Content-Security-Policy"');
    expect(result).toContain("<title>Test App</title>");
  });

  test("CSP first, then theme — both present", () => {
    const csp = buildCSP({ connectDomains: ["https://example.com"] });
    const withCsp = injectCSP(FULL_HTML, csp);
    const result = injectThemeStyles(withCsp, "light");

    expect(result).toContain("<style>");
    expect(result).toContain("--color-background-primary");
    expect(result).toContain('http-equiv="Content-Security-Policy"');
    expect(result).toContain("https://example.com");
  });

  test("both injections on fragment HTML (no <head>)", () => {
    const themed = injectThemeStyles(NO_HEAD_HTML, "light");
    const csp = buildCSP();
    const result = injectCSP(themed, csp);

    expect(result).toContain("<style>");
    expect(result).toContain("--color-background-primary");
    expect(result).toContain('http-equiv="Content-Security-Policy"');
    expect(result).toContain("<div>fragment content</div>");
  });
});
