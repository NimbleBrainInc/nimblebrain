/**
 * Pure projections of the canonical {@link palette} into the two
 * representations the host needs:
 *
 *  - {@link paletteToExtAppsTokens} → the MCP ext-apps token map injected into
 *    embedded-app iframes (consumed by `bridge/theme.ts`).
 *  - {@link paletteToRootCss} → the `:root`/`.dark` CSS blocks the shell renders
 *    from (generated into `tokens.generated.css`, imported by `index.css`).
 *
 * No DOM, no side effects. Given the palette, return data.
 */

import {
  type Mode,
  colors,
  extOnlyColors,
  fonts,
  layout,
  pick,
  radiusBase,
  radiusScale,
  shadows,
  typeScale,
} from "./palette.ts";

/**
 * Build the ext-apps token map for a mode. Mirrors the historical
 * `LIGHT_TOKENS`/`DARK_TOKENS` exactly, with two intentional deltas vs. the
 * pre-dedup `theme.ts`:
 *   1. `--font-sans` is Satoshi (was the stale `Inter`).
 *   2. brand-semantic `--nb-color-warm{,-light}` / `--nb-color-processing{,-light}`
 *      / `--nb-color-info-light` are added (no ext-apps spec key exists, so they
 *      ride as `--nb-*` extensions — injected into the iframe, filtered from the
 *      protocol boundary by `getSpecThemeTokens`).
 */
export function paletteToExtAppsTokens(mode: Mode): Record<string, string> {
  const c = (name: keyof typeof colors) => pick(colors[name], mode);
  const ext = (name: keyof typeof extOnlyColors) => pick(extOnlyColors[name], mode);

  return {
    // ── ext-apps spec: Colors ──
    "--color-background-primary": c("background"),
    "--color-background-secondary": c("card"),
    "--color-background-tertiary": ext("background-tertiary"),
    "--color-text-primary": c("foreground"),
    "--color-text-secondary": c("muted-foreground"),
    "--color-text-tertiary": ext("text-tertiary"),
    "--color-text-accent": c("primary"),
    "--color-border-primary": c("border"),
    "--color-border-secondary": c("border"),
    "--color-ring-primary": c("ring"),

    // ── ext-apps spec: Typography ──
    "--font-sans": fonts.sans,
    "--font-mono": fonts.mono,
    ...typeScale,

    // ── ext-apps spec: Layout ──
    ...radiusScale,

    // ── ext-apps spec: Effects ──
    ...shadows[mode],

    // ── NimbleBrain extensions (no ext-apps spec equivalent) ──
    "--nb-color-accent-foreground": c("primary-foreground"),
    "--nb-color-danger": c("destructive"),
    "--nb-color-success": c("success"),
    "--nb-color-warning": c("warning"),
    "--nb-color-warm": c("warm"),
    "--nb-color-warm-light": c("warm-light"),
    "--nb-color-processing": c("processing"),
    "--nb-color-processing-light": c("processing-light"),
    "--nb-color-info-light": c("info-light"),
    "--nb-font-heading": fonts.heading,
  };
}

/**
 * Build the shell's `:root` (light) and `.dark` (dark) CSS blocks. The values
 * and selectors match what Tailwind v4's `@theme inline` already references
 * (`--background`, `--sidebar-*`, `--chart-*`, `--radius`, `--font-text-*`, …).
 * `:root` also carries the mode-independent layout constants, base radius, and
 * type scale; `.dark` redefines colors only (the rest cascade from `:root`).
 */
export function paletteToRootCss(): string {
  const names = Object.keys(colors) as (keyof typeof colors)[];

  const lightDecls = names.map((n) => `  --${n}: ${pick(colors[n], "light")};`);
  lightDecls.push(`  --radius: ${radiusBase};`);
  for (const [k, v] of Object.entries(layout)) lightDecls.push(`  ${k}: ${v};`);
  // Type scale is mode-independent — :root only, aliased to Tailwind `--text-*`
  // in index.css. Same single-source path as colors/radius/layout.
  for (const [k, v] of Object.entries(typeScale)) lightDecls.push(`  ${k}: ${v};`);
  // Font stacks — single-sourced into the shell as `--nb-font-*`, aliased to
  // Tailwind's `--font-*` in index.css (the shell previously restated these as
  // literals). Mode-independent, :root only.
  for (const [k, v] of Object.entries(fonts)) lightDecls.push(`  --nb-font-${k}: ${v};`);

  const darkDecls = names.map((n) => `  --${n}: ${pick(colors[n], "dark")};`);

  return `:root {\n${lightDecls.join("\n")}\n}\n\n.dark {\n${darkDecls.join("\n")}\n}\n`;
}
