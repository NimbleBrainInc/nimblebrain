import { describe, expect, test } from "bun:test";
import { getSpecThemeTokens } from "../../bridge/theme.ts";
import { paletteToExtAppsTokens, paletteToRootCss } from "../projections.ts";

/**
 * The ext-apps token maps exactly as `bridge/theme.ts` emitted them BEFORE the
 * palette dedup, hand-transcribed here as an independent fixture. The new
 * projection must reproduce these byte-for-byte except for the documented
 * deltas applied below — this is the no-visual-change guarantee for embedded
 * apps.
 */
const LEGACY_LIGHT: Record<string, string> = {
  "--color-background-primary": "#faf9f7",
  "--color-background-secondary": "#ffffff",
  "--color-background-tertiary": "#f3f2ef",
  "--color-text-primary": "#171717",
  "--color-text-secondary": "#737373",
  "--color-text-tertiary": "#a3a3a3",
  "--color-text-accent": "#0055FF",
  "--color-border-primary": "#e5e5e5",
  "--color-border-secondary": "#e5e5e5",
  "--color-ring-primary": "#0055FF",
  "--font-sans": "'Inter', system-ui, sans-serif",
  "--font-mono": "'JetBrains Mono Variable', ui-monospace, SFMono-Regular, monospace",
  "--font-weight-normal": "400",
  "--font-weight-medium": "500",
  "--font-weight-semibold": "600",
  "--font-weight-bold": "700",
  "--font-text-xs-size": "0.75rem",
  "--font-text-xs-line-height": "1rem",
  "--font-text-sm-size": "0.875rem",
  "--font-text-sm-line-height": "1.25rem",
  "--font-text-base-size": "1rem",
  "--font-text-base-line-height": "1.5rem",
  "--font-text-lg-size": "1.125rem",
  "--font-text-lg-line-height": "1.75rem",
  "--font-heading-sm-size": "1.25rem",
  "--font-heading-sm-line-height": "1.75rem",
  "--font-heading-md-size": "1.5rem",
  "--font-heading-md-line-height": "2rem",
  "--font-heading-lg-size": "2rem",
  "--font-heading-lg-line-height": "2.5rem",
  "--border-radius-xs": "0.25rem",
  "--border-radius-sm": "0.5rem",
  "--border-radius-md": "0.75rem",
  "--border-radius-lg": "1rem",
  "--border-radius-xl": "1.5rem",
  "--border-width-regular": "1px",
  "--shadow-hairline": "0 0 0 1px rgba(0,0,0,0.06)",
  "--shadow-sm": "0 1px 2px rgba(0,0,0,0.05)",
  "--shadow-md": "0 4px 6px -1px rgba(0,0,0,0.1)",
  "--shadow-lg": "0 10px 15px -3px rgba(0,0,0,0.1)",
  "--nb-color-accent-foreground": "#ffffff",
  "--nb-color-danger": "#dc2626",
  "--nb-color-success": "#059669",
  "--nb-color-warning": "#f59e0b",
  "--nb-font-heading": "'Erode', Georgia, 'Times New Roman', serif",
};

const LEGACY_DARK: Record<string, string> = {
  "--color-background-primary": "#0a0a09",
  "--color-background-secondary": "#141413",
  "--color-background-tertiary": "#1c1c1b",
  "--color-text-primary": "#e5e5e5",
  "--color-text-secondary": "#a3a3a3",
  "--color-text-tertiary": "#737373",
  "--color-text-accent": "#3b8eff",
  "--color-border-primary": "#262626",
  "--color-border-secondary": "#262626",
  "--color-ring-primary": "#3b8eff",
  "--font-sans": "'Inter', system-ui, sans-serif",
  "--font-mono": "'JetBrains Mono Variable', ui-monospace, SFMono-Regular, monospace",
  "--font-weight-normal": "400",
  "--font-weight-medium": "500",
  "--font-weight-semibold": "600",
  "--font-weight-bold": "700",
  "--font-text-xs-size": "0.75rem",
  "--font-text-xs-line-height": "1rem",
  "--font-text-sm-size": "0.875rem",
  "--font-text-sm-line-height": "1.25rem",
  "--font-text-base-size": "1rem",
  "--font-text-base-line-height": "1.5rem",
  "--font-text-lg-size": "1.125rem",
  "--font-text-lg-line-height": "1.75rem",
  "--font-heading-sm-size": "1.25rem",
  "--font-heading-sm-line-height": "1.75rem",
  "--font-heading-md-size": "1.5rem",
  "--font-heading-md-line-height": "2rem",
  "--font-heading-lg-size": "2rem",
  "--font-heading-lg-line-height": "2.5rem",
  "--border-radius-xs": "0.25rem",
  "--border-radius-sm": "0.5rem",
  "--border-radius-md": "0.75rem",
  "--border-radius-lg": "1rem",
  "--border-radius-xl": "1.5rem",
  "--border-width-regular": "1px",
  "--shadow-hairline": "0 0 0 1px rgba(255,255,255,0.06)",
  "--shadow-sm": "0 1px 2px rgba(0,0,0,0.3)",
  "--shadow-md": "0 4px 6px -1px rgba(0,0,0,0.4)",
  "--shadow-lg": "0 10px 15px -3px rgba(0,0,0,0.4)",
  "--nb-color-accent-foreground": "#0a0a09",
  "--nb-color-danger": "#f87171",
  "--nb-color-success": "#34d399",
  "--nb-color-warning": "#fbbf24",
  "--nb-font-heading": "'Erode', Georgia, 'Times New Roman', serif",
};

/** Documented, intended deltas vs. the legacy maps (see SPEC_REFERENCE §"Intended deltas"). */
const SATOSHI = "'Satoshi', system-ui, sans-serif";
const ERODE = "'Erode', Georgia, serif"; // canonical shell value; drops the unused 'Times New Roman' fallback
const ADDED_LIGHT = {
  "--nb-color-warm": "#d4620a",
  "--nb-color-warm-light": "#fef5ee",
  "--nb-color-processing": "#7c3aed",
  "--nb-color-processing-light": "#f3eeff",
  "--nb-color-info-light": "#eef4ff",
};
const ADDED_DARK = {
  "--nb-color-warm": "#f59542",
  "--nb-color-warm-light": "#2a1a08",
  "--nb-color-processing": "#a78bfa",
  "--nb-color-processing-light": "#1a0f2e",
  "--nb-color-info-light": "#0c1a33",
};
/**
 * Net-new sub-`xs` type steps (mode-independent) added for the dense shell.
 * They ride into the ext-apps token map via `...typeScale`, so the exact-match
 * fixtures above gain them in both modes.
 */
const ADDED_TYPE_STEPS = {
  "--font-text-3xs-size": "0.625rem",
  "--font-text-3xs-line-height": "0.875rem",
  "--font-text-2xs-size": "0.6875rem",
  "--font-text-2xs-line-height": "1rem",
};

describe("paletteToExtAppsTokens — no visual change except documented deltas", () => {
  test("light map = legacy light + (Satoshi, simplified heading, added brand semantics)", () => {
    const expected = {
      ...LEGACY_LIGHT,
      "--font-sans": SATOSHI,
      "--nb-font-heading": ERODE,
      ...ADDED_TYPE_STEPS,
      ...ADDED_LIGHT,
    };
    expect(paletteToExtAppsTokens("light")).toEqual(expected);
  });

  test("dark map = legacy dark + the same deltas", () => {
    const expected = {
      ...LEGACY_DARK,
      "--font-sans": SATOSHI,
      "--nb-font-heading": ERODE,
      ...ADDED_TYPE_STEPS,
      ...ADDED_DARK,
    };
    expect(paletteToExtAppsTokens("dark")).toEqual(expected);
  });

  test("the stale Inter font is gone in both modes", () => {
    expect(paletteToExtAppsTokens("light")["--font-sans"]).not.toContain("Inter");
    expect(paletteToExtAppsTokens("dark")["--font-sans"]).toContain("Satoshi");
  });
});

describe("getSpecThemeTokens — protocol boundary", () => {
  test("excludes every NB extension and keeps spec keys", () => {
    const spec = getSpecThemeTokens("light");
    for (const key of Object.keys(spec)) {
      expect(key.startsWith("--nb-")).toBe(false);
    }
    // representative spec keys survive the filter
    expect(spec["--color-background-primary"]).toBe("#faf9f7");
    expect(spec["--font-sans"]).toContain("Satoshi");
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
      "--background: #faf9f7;",
      "--primary: #0055FF;",
      "--warm: #d4620a;",
      "--processing: #7c3aed;",
      "--sidebar-accent: #eff6ff;",
      "--chart-1: #0055FF;",
      "--sidebar-width: 240px;",
    ]) {
      expect(rootBlock).toContain(decl);
    }
  });

  test("dark block redefines colors but not radius/layout (those cascade)", () => {
    expect(darkBlock).toContain("--background: #0a0a09;");
    expect(darkBlock).toContain("--primary: #3b8eff;");
    expect(darkBlock).toContain("--warm: #f59542;");
    expect(darkBlock).toContain("--processing: #a78bfa;");
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
    expect(rootBlock).toContain("--nb-font-sans: 'Satoshi', system-ui, sans-serif;");
    expect(rootBlock).toContain("--nb-font-heading: 'Erode', Georgia, serif;");
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
