import { describe, test, expect } from "bun:test";
import {
  LIGHT_TOKENS,
  DARK_TOKENS,
  getThemeTokens,
  buildThemeStyleBlock,
} from "../../../web/src/bridge/theme.ts";

const EXPECTED_KEYS = [
  // ext-apps spec: Colors
  "--color-background-primary",
  "--color-background-secondary",
  "--color-background-tertiary",
  "--color-text-primary",
  "--color-text-secondary",
  "--color-text-tertiary",
  "--color-text-accent",
  "--color-border-primary",
  "--color-border-secondary",
  "--color-ring-primary",
  // ext-apps spec: Typography
  "--font-sans",
  "--font-mono",
  "--font-weight-normal",
  "--font-weight-medium",
  "--font-weight-semibold",
  "--font-weight-bold",
  "--font-text-xs-size",
  "--font-text-xs-line-height",
  "--font-text-sm-size",
  "--font-text-sm-line-height",
  "--font-text-base-size",
  "--font-text-base-line-height",
  "--font-text-lg-size",
  "--font-text-lg-line-height",
  "--font-heading-sm-size",
  "--font-heading-sm-line-height",
  "--font-heading-md-size",
  "--font-heading-md-line-height",
  "--font-heading-lg-size",
  "--font-heading-lg-line-height",
  // ext-apps spec: Layout
  "--border-radius-xs",
  "--border-radius-sm",
  "--border-radius-md",
  "--border-radius-lg",
  "--border-radius-xl",
  "--border-width-regular",
  // ext-apps spec: Effects
  "--shadow-hairline",
  "--shadow-sm",
  "--shadow-md",
  "--shadow-lg",
  // NimbleBrain extensions
  "--nb-color-accent-foreground",
  "--nb-color-danger",
  "--nb-color-success",
  "--nb-color-warning",
  "--nb-font-heading",
];

describe("theme token map", () => {
  test("getThemeTokens('light') has all expected token keys", () => {
    const tokens = getThemeTokens("light");
    for (const key of EXPECTED_KEYS) {
      expect(tokens).toHaveProperty(key);
    }
  });

  test("getThemeTokens('dark') has all expected token keys", () => {
    const tokens = getThemeTokens("dark");
    for (const key of EXPECTED_KEYS) {
      expect(tokens).toHaveProperty(key);
    }
  });

  test("light and dark token maps have identical key sets", () => {
    const lightKeys = Object.keys(LIGHT_TOKENS).sort();
    const darkKeys = Object.keys(DARK_TOKENS).sort();
    expect(lightKeys).toEqual(darkKeys);
  });

  test("dark mode has different values for background, foreground, and accent", () => {
    const light = getThemeTokens("light");
    const dark = getThemeTokens("dark");

    expect(light["--color-background-primary"]).not.toBe(dark["--color-background-primary"]);
    expect(light["--color-text-primary"]).not.toBe(dark["--color-text-primary"]);
    expect(light["--color-text-accent"]).not.toBe(dark["--color-text-accent"]);
  });

  test("light token values match index.css exactly", () => {
    const tokens = getThemeTokens("light");
    expect(tokens["--color-background-primary"]).toBe("#faf9f7");
    expect(tokens["--color-text-primary"]).toBe("#171717");
    expect(tokens["--color-text-accent"]).toBe("#0055FF");
    expect(tokens["--color-border-primary"]).toBe("#e5e5e5");
    expect(tokens["--color-background-secondary"]).toBe("#ffffff");
    expect(tokens["--nb-color-danger"]).toBe("#dc2626");
    expect(tokens["--nb-color-success"]).toBe("#059669");
    expect(tokens["--nb-color-warning"]).toBe("#f59e0b");
    expect(tokens["--border-radius-sm"]).toBe("0.5rem");
  });

  test("dark token values match index.css exactly", () => {
    const tokens = getThemeTokens("dark");
    expect(tokens["--color-background-primary"]).toBe("#0a0a09");
    expect(tokens["--color-text-primary"]).toBe("#e5e5e5");
    expect(tokens["--color-text-accent"]).toBe("#3b8eff");
    expect(tokens["--color-border-primary"]).toBe("#262626");
    expect(tokens["--color-background-secondary"]).toBe("#141413");
    expect(tokens["--nb-color-danger"]).toBe("#f87171");
    expect(tokens["--nb-color-success"]).toBe("#34d399");
    expect(tokens["--nb-color-warning"]).toBe("#fbbf24");
  });

  test("all token keys use valid prefixes", () => {
    const validPrefixes = ["--color-", "--font-", "--border-", "--shadow-", "--nb-"];
    for (const key of Object.keys(LIGHT_TOKENS)) {
      expect(validPrefixes.some((p) => key.startsWith(p))).toBe(true);
    }
    for (const key of Object.keys(DARK_TOKENS)) {
      expect(validPrefixes.some((p) => key.startsWith(p))).toBe(true);
    }
  });

  test("no extra keys beyond the expected set", () => {
    const lightKeys = Object.keys(LIGHT_TOKENS);
    expect(lightKeys.length).toBe(EXPECTED_KEYS.length);
    const darkKeys = Object.keys(DARK_TOKENS);
    expect(darkKeys.length).toBe(EXPECTED_KEYS.length);
  });
});

describe("buildThemeStyleBlock", () => {
  test("light output contains <style> tag with :root block", () => {
    const block = buildThemeStyleBlock("light");
    expect(block).toStartWith("<style>");
    expect(block).toEndWith("</style>");
    expect(block).toContain(":root {");
  });

  test("light output contains correct token values", () => {
    const block = buildThemeStyleBlock("light");
    expect(block).toContain("--color-background-primary: #faf9f7;");
    expect(block).toContain("--color-text-primary: #171717;");
    expect(block).toContain("--color-text-accent: #0055FF;");
  });

  test("dark output contains dark mode values", () => {
    const block = buildThemeStyleBlock("dark");
    expect(block).toContain("--color-background-primary: #0a0a09;");
    expect(block).toContain("--color-text-primary: #e5e5e5;");
    expect(block).toContain("--color-text-accent: #3b8eff;");
  });

  test("body reset uses var() references, not hardcoded values", () => {
    const block = buildThemeStyleBlock("light");
    expect(block).toContain("font-family: var(--font-sans);");
    expect(block).toContain("background: var(--color-background-primary);");
    expect(block).toContain("color: var(--color-text-primary);");
  });

  test("includes box-sizing reset", () => {
    const block = buildThemeStyleBlock("light");
    expect(block).toContain("box-sizing: border-box;");
  });

  test("font token uses Inter system fallback", () => {
    const tokens = getThemeTokens("light");
    expect(tokens["--font-sans"]).toBe("'Inter', system-ui, sans-serif");
  });
});
