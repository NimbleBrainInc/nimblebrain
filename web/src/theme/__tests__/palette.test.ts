import { describe, expect, test } from "bun:test";
import { getSpecThemeTokens } from "../../bridge/theme.ts";
import { paletteToExtAppsTokens, paletteToRootCss } from "../projections.ts";

/**
 * These tests guard the projection, not a snapshot of it.
 *
 * The previous version froze the entire pre-dedup token map and asserted
 * byte-for-byte reproduction plus a list of intended deltas. That guaranteed
 * "nothing changed since the dedup", which stopped being the useful question
 * the moment the brand deliberately changed — and a fifty-value fixture is only
 * an independent check until someone regenerates it from the source it exists
 * to verify.
 *
 * What is worth guarding instead:
 *   - STRUCTURE: every key the ext-apps bridge promises is present in both modes.
 *   - BOUNDARY: `getSpecThemeTokens` filters NB extensions off the wire.
 *   - ANCHORS: the handful of load-bearing brand values, asserted literally, so
 *     an accidental change is loud and a deliberate one is a visible diff.
 *   - CASCADE: mode-independent scales are emitted once, not in both blocks.
 *
 * Contrast is guarded separately in `contrast.test.ts`, which computes ratios
 * rather than comparing against a copy — the one check here that cannot be
 * made circular.
 */

/** Load-bearing values. Small enough to maintain, meaningful enough to catch an accident. */
const ANCHORS = {
  light: {
    "--color-background-primary": "#ffffff",
    "--color-text-primary": "#09090b",
    "--color-text-accent": "#0055FF",
    "--color-ring-primary": "#0055FF",
    "--color-border-primary": "#e4e4e7",
    "--font-sans": "'Hanken Grotesk', system-ui, sans-serif",
    "--nb-font-heading": "'Hanken Grotesk', system-ui, sans-serif",
  },
  dark: {
    "--color-background-primary": "#000000",
    "--color-text-primary": "#fafafa",
    "--color-text-accent": "#4d90ff",
    "--color-ring-primary": "#4d90ff",
    "--color-border-primary": "#232326",
  },
} as const;

/** Every key the bridge contract promises an embedded app. */
const REQUIRED_KEYS = [
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
  "--font-sans",
  "--font-mono",
  "--nb-font-heading",
  "--border-radius-xs",
  "--border-radius-sm",
  "--border-radius-md",
  "--border-radius-lg",
  "--border-radius-xl",
  "--border-width-regular",
  "--shadow-hairline",
  "--shadow-sm",
  "--shadow-md",
  "--shadow-lg",
] as const;

describe("paletteToExtAppsTokens — structure and anchors", () => {
  for (const mode of ["light", "dark"] as const) {
    test(`${mode} map carries every key the bridge promises`, () => {
      const map = paletteToExtAppsTokens(mode);
      for (const key of REQUIRED_KEYS) expect(map[key]).toBeTruthy();
    });

    test(`${mode} map carries the brand anchors`, () => {
      const map = paletteToExtAppsTokens(mode);
      for (const [key, value] of Object.entries(ANCHORS[mode])) {
        expect(map[key]).toBe(value);
      }
    });
  }

  test("both modes emit the same key set — no mode-only tokens", () => {
    expect(Object.keys(paletteToExtAppsTokens("light")).sort()).toEqual(
      Object.keys(paletteToExtAppsTokens("dark")).sort(),
    );
  });

  test("the retired terracotta accent is gone; blue is the only brand hue", () => {
    for (const mode of ["light", "dark"] as const) {
      const keys = Object.keys(paletteToExtAppsTokens(mode));
      expect(keys.some((k) => k.includes("warm"))).toBe(false);
    }
  });

  test("no stale Inter in either mode", () => {
    for (const mode of ["light", "dark"] as const) {
      expect(JSON.stringify(paletteToExtAppsTokens(mode))).not.toContain("Inter");
    }
  });
});

describe("getSpecThemeTokens — protocol boundary", () => {
  test("excludes every NB extension and keeps spec keys", () => {
    const spec = getSpecThemeTokens("light");
    for (const key of Object.keys(spec)) {
      expect(key.startsWith("--nb-")).toBe(false);
    }
    // representative spec keys survive the filter
    expect(spec["--color-background-primary"]).toBe("#ffffff");
    expect(spec["--font-sans"]).toContain("Hanken Grotesk");
    // out-of-spec tokens are injected into the iframe but do NOT cross the boundary
    expect(spec["--color-text-accent"]).toBeUndefined();
    // the newly-added brand semantics do NOT cross the boundary
    expect(spec["--nb-color-processing"]).toBeUndefined();
  });
});

describe("paletteToRootCss — shell :root/.dark match current values", () => {
  const css = paletteToRootCss();
  const darkAt = css.indexOf(".dark {");
  const rootBlock = css.slice(0, darkAt);
  const darkBlock = css.slice(darkAt);

  test("light :root carries the current brand values", () => {
    for (const decl of [
      "--background: #ffffff;",
      "--primary: #0055FF;",
      "--primary-light: #eaf0ff;",
      "--processing: #6d3ecf;",
      "--chart-1: #0055FF;",
      "--sidebar-width: 240px;",
    ]) {
      expect(rootBlock).toContain(decl);
    }
  });

  test("dark block redefines colors but not radius/layout (those cascade)", () => {
    expect(darkBlock).toContain("--background: #000000;");
    expect(darkBlock).toContain("--primary: #4d90ff;");
    expect(darkBlock).toContain("--processing: #a68bfa;");
    expect(darkBlock).not.toContain("--radius:");
    expect(darkBlock).not.toContain("--sidebar-width:");
  });

  test("light :root carries the type scale (aliased to Tailwind --text-* in index.css)", () => {
    expect(rootBlock).toContain("--font-text-3xs-size: 0.625rem;");
    expect(rootBlock).toContain("--font-text-2xs-size: 0.6875rem;");
    expect(rootBlock).toContain("--font-text-xs-size: 0.75rem;");
  });

  test("dark block does not redefine the type scale (mode-independent, cascades)", () => {
    expect(darkBlock).not.toContain("--font-text-");
  });

  test("light :root carries the font stacks (aliased to Tailwind --font-* in index.css)", () => {
    expect(rootBlock).toContain("--nb-font-sans: 'Hanken Grotesk', system-ui, sans-serif;");
    expect(rootBlock).toContain("--nb-font-heading: 'Hanken Grotesk', system-ui, sans-serif;");
    expect(rootBlock).toContain("--nb-font-reading: 'Newsreader', Georgia, serif;");
    expect(rootBlock).toContain("--nb-font-mono: 'JetBrains Mono Variable'");
  });

  test("dark block does not redefine the font stacks (mode-independent, cascades)", () => {
    expect(darkBlock).not.toContain("--nb-font-");
  });

  test("light :root carries the radius scale (aliased to Tailwind --radius-* in index.css)", () => {
    expect(rootBlock).toContain("--border-radius-xs: 0.25rem;");
    expect(rootBlock).toContain("--border-radius-sm: 0.5rem;");
    expect(rootBlock).toContain("--border-radius-md: 0.75rem;");
    expect(rootBlock).toContain("--border-radius-lg: 1rem;");
  });

  test("dark block does not redefine the radius scale (mode-independent, cascades)", () => {
    expect(darkBlock).not.toContain("--border-radius-");
  });

  test("shadow ramp lands in :root (light) and .dark (mode-dependent), aliased to --shadow-* in index.css", () => {
    expect(rootBlock).toContain("--nb-shadow-sm: 0 1px 2px rgba(0,0,0,0.05);");
    expect(rootBlock).toContain("--nb-shadow-lg: 0 10px 15px -3px rgba(0,0,0,0.1);");
    // shadows are mode-dependent, so .dark carries its own values
    expect(darkBlock).toContain("--nb-shadow-sm: 0 1px 2px rgba(0,0,0,0.3);");
  });

  test("the --radius base is no longer emitted (vestigial after the radius convergence)", () => {
    expect(rootBlock).not.toContain("--radius:");
  });
});
