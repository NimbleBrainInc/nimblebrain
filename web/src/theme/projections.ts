/**
 * Pure projections of a palette into the two representations the host needs:
 *
 *  - {@link paletteToExtAppsTokens} → the MCP ext-apps token map injected into
 *    embedded-app iframes (consumed by `bridge/theme.ts`).
 *  - {@link paletteToRootCss} → the `:root`/`.dark` CSS blocks the shell renders
 *    from (generated into `tokens.generated.css`, imported by `index.css`).
 *
 * Both take the palette to project and default to the canonical one. The
 * generator calls them with the default; the browser entry calls them with a
 * tenant's brand merged over it (`brand.ts`). Colours, fonts and the radius
 * scale come from the argument; the type scale, shadows and layout constants
 * are not brand-overridable and always come from `palette.ts`.
 *
 * No DOM, no side effects. Given the palette, return data.
 */

import type { Palette } from "./brand.ts";
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

/** The canonical palette in the shape a brand merge produces. */
export const canonicalPalette: Palette = { colors, extOnlyColors, fonts, radiusScale };

/**
 * Build the ext-apps token map for a mode.
 *
 * Spec keys follow the MCP ext-apps contract. Anything with no spec equivalent
 * rides as a `--nb-*` extension — the prefix *is* the rule, so there is no list
 * to keep in step: `--nb-*` keys are injected into the iframe's style block and
 * filtered off the protocol boundary by `getSpecThemeTokens`. (Note the
 * converse does not hold: a few spec-shaped keys are also filtered, because
 * NimbleBrain emits more of a family than the spec enumerates. `theme.ts` has
 * that rule.)
 */
export function paletteToExtAppsTokens(
  mode: Mode,
  palette: Palette = canonicalPalette,
): Record<string, string> {
  const c = (name: keyof typeof colors) => pick(palette.colors[name], mode);
  const ext = (name: keyof typeof extOnlyColors) => pick(palette.extOnlyColors[name], mode);

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
    "--font-sans": palette.fonts.sans,
    "--font-mono": palette.fonts.mono,
    ...typeScale,

    // ── ext-apps spec: Layout ──
    ...palette.radiusScale,

    // ── ext-apps spec: Effects ──
    ...shadows[mode],

    // ── NimbleBrain extensions (no ext-apps spec equivalent) ──
    "--nb-color-accent-foreground": c("primary-foreground"),
    "--nb-color-danger": c("destructive"),
    "--nb-color-danger-foreground": c("destructive-foreground"),
    "--nb-color-success": c("success"),
    "--nb-color-warning": c("warning"),
    "--nb-color-processing": c("processing"),
    "--nb-color-processing-light": c("processing-light"),
    "--nb-color-info-light": c("info-light"),
    "--nb-font-heading": palette.fonts.heading,
  };
}

/**
 * Build the shell's `:root` (light) and `.dark` (dark) CSS blocks. The values
 * and selectors match what Tailwind v4's `@theme inline` already references
 * (`--background`, `--sidebar-*`, `--border-radius-*`,
 * `--font-text-*`, `--nb-shadow-*`, …). `:root` also carries the
 * mode-independent layout constants, radius scale, type scale, and fonts;
 * `.dark` redefines colors and shadows (both mode-dependent), the rest cascade
 * from `:root`.
 */
export function paletteToRootCss(palette: Palette = canonicalPalette): string {
  const names = Object.keys(palette.colors) as (keyof typeof colors)[];

  const lightDecls = names.map((n) => `  --${n}: ${pick(palette.colors[n], "light")};`);
  for (const [k, v] of Object.entries(layout)) lightDecls.push(`  ${k}: ${v};`);
  // Radius scale — the ONE radius source, shared with the iframe apps. Emitted
  // as `--border-radius-*` (the ext-apps / synapse-ui names) and aliased to
  // Tailwind's `--radius-*` in index.css, so the shell and the apps round
  // equivalent elements identically.
  for (const [k, v] of Object.entries(palette.radiusScale)) lightDecls.push(`  ${k}: ${v};`);
  // Type scale is mode-independent — :root only, aliased to Tailwind `--text-*`
  // in index.css. Same single-source path as colors/radius/layout.
  for (const [k, v] of Object.entries(typeScale)) lightDecls.push(`  ${k}: ${v};`);
  // Font stacks — single-sourced into the shell as `--nb-font-*`, aliased to
  // Tailwind's `--font-*` in index.css (the shell previously restated these as
  // literals). Mode-independent, :root only.
  for (const [k, v] of Object.entries(palette.fonts)) lightDecls.push(`  --nb-font-${k}: ${v};`);
  // Shadows — mode-dependent, so emitted into both :root and .dark. Renamed to
  // `--nb-shadow-*` (Tailwind owns the `--shadow-*` key) and aliased to it in
  // index.css. The shell shares the design system's shadow ramp the iframe apps
  // already use; the shell-only `shadow-xl`/`2xl` (modals) keep Tailwind's
  // values — the ramp tops out at `lg` in the shared design system.
  const shadowDecl = (k: string, v: string) => `  ${k.replace("--shadow-", "--nb-shadow-")}: ${v};`;
  for (const [k, v] of Object.entries(shadows.light)) lightDecls.push(shadowDecl(k, v));

  const darkDecls = names.map((n) => `  --${n}: ${pick(palette.colors[n], "dark")};`);
  for (const [k, v] of Object.entries(shadows.dark)) darkDecls.push(shadowDecl(k, v));

  return `:root {\n${lightDecls.join("\n")}\n}\n\n.dark {\n${darkDecls.join("\n")}\n}\n`;
}
