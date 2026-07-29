import { describe, test, expect } from "bun:test";
import {
  LIGHT_TOKENS,
  DARK_TOKENS,
  getThemeTokens,
  buildThemeStyleBlock,
} from "../../../web/src/bridge/theme.ts";

/**
 * What the injected map must CONTAIN is asserted where it can stay true on its
 * own: `test/unit/bundles/theme-token-names.test.ts` checks the emitted set
 * against the published docs in both directions, and against every token the
 * themed trees read. A hand-written copy of the key list lived here and had to
 * be edited by hand whenever the projection grew — the fourth instance of that
 * shape in this area, after `theming.mdx`, this module's own docblock,
 * `projections.ts`, and `palette.test.ts`'s `REQUIRED_KEYS`. This file keeps
 * what only it can say: the two modes agree, the prefixes are legal, and the
 * style block is well-formed.
 */

describe("theme token map", () => {
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

  test("all token keys use valid prefixes", () => {
    const validPrefixes = ["--color-", "--font-", "--border-", "--shadow-", "--nb-"];
    for (const key of Object.keys(LIGHT_TOKENS)) {
      expect(validPrefixes.some((p) => key.startsWith(p))).toBe(true);
    }
    for (const key of Object.keys(DARK_TOKENS)) {
      expect(validPrefixes.some((p) => key.startsWith(p))).toBe(true);
    }
  });

});

describe("buildThemeStyleBlock", () => {
  test("wraps the declarations in a <style> tag with a :root block", () => {
    const block = buildThemeStyleBlock("light");
    expect(block).toContain("<style");
    expect(block).toContain(":root {");
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

  test("font token uses the Hanken Grotesk system fallback", () => {
    const tokens = getThemeTokens("light");
    expect(tokens["--font-sans"]).toBe("'Hanken Grotesk', system-ui, sans-serif");
  });
});
