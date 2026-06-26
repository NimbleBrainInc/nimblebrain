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
  colors,
  extOnlyColors,
  fonts,
  layout,
  type Mode,
  pick,
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
 * (`--background`, `--sidebar-*`, `--chart-*`, `--border-radius-*`,
 * `--font-text-*`, `--nb-shadow-*`, …). `:root` also carries the
 * mode-independent layout constants, radius scale, type scale, and fonts;
 * `.dark` redefines colors and shadows (both mode-dependent), the rest cascade
 * from `:root`.
 */
export function paletteToRootCss(): string {
  const names = Object.keys(colors) as (keyof typeof colors)[];

  const lightDecls = names.map((n) => `  --${n}: ${pick(colors[n], "light")};`);
  for (const [k, v] of Object.entries(layout)) lightDecls.push(`  ${k}: ${v};`);
  // Radius scale — the ONE radius source, shared with the iframe apps. Emitted
  // as `--border-radius-*` (the ext-apps / synapse-ui names) and aliased to
  // Tailwind's `--radius-*` in index.css, so the shell and the apps round
  // equivalent elements identically.
  for (const [k, v] of Object.entries(radiusScale)) lightDecls.push(`  ${k}: ${v};`);
  // Type scale is mode-independent — :root only, aliased to Tailwind `--text-*`
  // in index.css. Same single-source path as colors/radius/layout.
  for (const [k, v] of Object.entries(typeScale)) lightDecls.push(`  ${k}: ${v};`);
  // Font stacks — single-sourced into the shell as `--nb-font-*`, aliased to
  // Tailwind's `--font-*` in index.css (the shell previously restated these as
  // literals). Mode-independent, :root only.
  for (const [k, v] of Object.entries(fonts)) lightDecls.push(`  --nb-font-${k}: ${v};`);
  // Shadows — mode-dependent, so emitted into both :root and .dark. Renamed to
  // `--nb-shadow-*` (Tailwind owns the `--shadow-*` key) and aliased to it in
  // index.css. The shell shares the design system's shadow ramp the iframe apps
  // already use; the shell-only `shadow-xl`/`2xl` (modals) keep Tailwind's
  // values — the ramp tops out at `lg` in the shared design system.
  const shadowDecl = (k: string, v: string) => `  ${k.replace("--shadow-", "--nb-shadow-")}: ${v};`;
  for (const [k, v] of Object.entries(shadows.light)) lightDecls.push(shadowDecl(k, v));

  const darkDecls = names.map((n) => `  --${n}: ${pick(colors[n], "dark")};`);
  for (const [k, v] of Object.entries(shadows.dark)) darkDecls.push(shadowDecl(k, v));

  return `:root {\n${lightDecls.join("\n")}\n}\n\n.dark {\n${darkDecls.join("\n")}\n}\n`;
}
