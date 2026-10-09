import { describe, expect, test } from "bun:test";
import { buildCSP, injectCSP, injectThemeStyles } from "../../../web/src/bridge/iframe.ts";

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
    expect(result).toContain("--color-background-primary: #ffffff;");
    expect(result).toContain("--color-text-primary: #09090b;");
  });

  test("dark mode contains dark token values", () => {
    const result = injectThemeStyles(FULL_HTML, "dark");
    expect(result).toContain("--color-background-primary: #000000;");
    expect(result).toContain("--color-text-primary: #fafafa;");
  });

  test("leaves out the non-spec tokens that vary with the mode", () => {
    // They travel on the `ai.nimblebrain/styles` host-context extension, which
    // follows a toggle. In this write-once block they would outrank an SDK's
    // defaults at the mount's mode for the life of the frame.
    for (const mode of ["light", "dark"] as const) {
      const result = injectThemeStyles(FULL_HTML, mode);
      expect(result).not.toContain("--color-text-accent");
      expect(result).not.toContain("--nb-color-processing");
    }
  });

  test("lands before the app's own head content, so the app's :root wins", () => {
    // Equal-specificity unlayered rules resolve by document order. The host's
    // block must come first so an app's own `:root` overrides it; the SDK's
    // theming docs state this order as the reason that works.
    const app = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>:root { --color-background-primary: red; }</style></head><body></body></html>`;
    for (const html of [
      injectThemeStyles(app, "light"),
      injectCSP(injectThemeStyles(app, "light"), buildCSP()),
    ]) {
      const hostBlock = html.indexOf("color-scheme: light");
      expect(hostBlock).toBeGreaterThan(html.indexOf("<head>"));
      expect(hostBlock).toBeLessThan(html.indexOf('<meta charset="utf-8">'));
      expect(hostBlock).toBeLessThan(html.indexOf("--color-background-primary: red"));
    }
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
