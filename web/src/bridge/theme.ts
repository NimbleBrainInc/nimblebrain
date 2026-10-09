/**
 * Theme token map — the ext-apps projection of the canonical palette, plus the
 * bridge theme protocol helpers.
 *
 * Values are NOT defined here. They derive from `web/src/theme/palette.ts` via
 * `paletteToExtAppsTokens` so the shell (`index.css`) and the iframe-injected
 * tokens share one source of truth. Tokens follow the MCP ext-apps spec
 * (2026-01-26) where a standard equivalent exists; NimbleBrain-specific
 * extension tokens use the `--nb-` prefix.
 */

import { paletteToExtAppsTokens } from "../theme/projections.ts";

export type ThemeMode = "light" | "dark";
export type ThemeTokens = Record<string, string>;

export const LIGHT_TOKENS: ThemeTokens = paletteToExtAppsTokens("light");

export const DARK_TOKENS: ThemeTokens = paletteToExtAppsTokens("dark");

export function getThemeTokens(mode: ThemeMode): ThemeTokens {
  return mode === "dark" ? DARK_TOKENS : LIGHT_TOKENS;
}

/**
 * Allowlist of CSS variable keys that the ext-apps spec's `hostContext.styles.variables`
 * field accepts. Mirrors `McpUiStyleVariableKey` from
 * `@modelcontextprotocol/ext-apps` (spec 2026-01-26). Strict clients like
 * Reboot's `@reboot-dev/reboot-react` (via ext-apps SDK) validate against this
 * set and reject unknown keys, so anything the host sends there must be in here.
 *
 * Everything the host emits that is *not* in this set (the `--nb-*`
 * extensions, plus NimbleBrain's own additions to spec-shaped families:
 * `--color-text-accent`, and the `3xs`/`2xs`/`base` steps of the type scale)
 * never crosses `styles.variables`. Where it goes depends on whether it varies
 * with the mode: see {@link getModeExtensionTokens} and
 * {@link buildThemeStyleBlock}. Stated as the rule rather than a list: an
 * enumeration here silently mis-classifies the next token added.
 *
 * If the spec's variable enum grows, add entries here.
 */
const SPEC_ALLOWED_KEYS = new Set<string>([
  "--color-background-primary",
  "--color-background-secondary",
  "--color-background-tertiary",
  "--color-background-inverse",
  "--color-background-ghost",
  "--color-background-info",
  "--color-background-danger",
  "--color-background-success",
  "--color-background-warning",
  "--color-background-disabled",
  "--color-text-primary",
  "--color-text-secondary",
  "--color-text-tertiary",
  "--color-text-inverse",
  "--color-text-ghost",
  "--color-text-info",
  "--color-text-danger",
  "--color-text-success",
  "--color-text-warning",
  "--color-text-disabled",
  "--color-border-primary",
  "--color-border-secondary",
  "--color-border-tertiary",
  "--color-border-inverse",
  "--color-border-ghost",
  "--color-border-info",
  "--color-border-danger",
  "--color-border-success",
  "--color-border-warning",
  "--color-border-disabled",
  "--color-ring-primary",
  "--color-ring-secondary",
  "--color-ring-inverse",
  "--color-ring-info",
  "--color-ring-danger",
  "--color-ring-success",
  "--color-ring-warning",
  "--font-sans",
  "--font-mono",
  "--font-weight-normal",
  "--font-weight-medium",
  "--font-weight-semibold",
  "--font-weight-bold",
  "--font-text-xs-size",
  "--font-text-sm-size",
  "--font-text-md-size",
  "--font-text-lg-size",
  "--font-heading-xs-size",
  "--font-heading-sm-size",
  "--font-heading-md-size",
  "--font-heading-lg-size",
  "--font-heading-xl-size",
  "--font-heading-2xl-size",
  "--font-heading-3xl-size",
  "--font-text-xs-line-height",
  "--font-text-sm-line-height",
  "--font-text-md-line-height",
  "--font-text-lg-line-height",
  "--font-heading-xs-line-height",
  "--font-heading-sm-line-height",
  "--font-heading-md-line-height",
  "--font-heading-lg-line-height",
  "--font-heading-xl-line-height",
  "--font-heading-2xl-line-height",
  "--font-heading-3xl-line-height",
  "--border-radius-xs",
  "--border-radius-sm",
  "--border-radius-md",
  "--border-radius-lg",
  "--border-radius-xl",
  "--border-radius-full",
  "--border-width-regular",
  "--shadow-hairline",
  "--shadow-sm",
  "--shadow-md",
  "--shadow-lg",
]);

/**
 * Subset of the theme tokens that are valid to send over the ext-apps
 * `hostContext.styles.variables` protocol field. Filters out NB-extension
 * tokens (`--nb-*`) and any that don't match the spec's enum.
 */
export function getSpecThemeTokens(mode: ThemeMode): ThemeTokens {
  const all = getThemeTokens(mode);
  const filtered: ThemeTokens = {};
  for (const [key, value] of Object.entries(all)) {
    if (SPEC_ALLOWED_KEYS.has(key)) filtered[key] = value;
  }
  return filtered;
}

/**
 * The tokens outside the spec's enum whose value differs between light and
 * dark: today `--color-text-accent` and the processing pair.
 *
 * A token that varies with the mode has to travel on a channel the host can
 * update when the mode changes. The srcdoc style block is written once, at
 * mount, and an iframe stays mounted across a theme toggle, so these go out as
 * the `ai.nimblebrain/styles` host-context extension instead
 * (`HOST_STYLES_EXTENSION`), on `ui/initialize` and on every
 * `host-context-changed`, where `@nimblebrain/synapse` applies them inline like
 * the spec's variables.
 *
 * Derived by comparing the two modes rather than listed, so a token added to
 * the palette lands on the right channel without an edit here.
 */
export function getModeExtensionTokens(mode: ThemeMode): ThemeTokens {
  const out: ThemeTokens = {};
  for (const [key, value] of Object.entries(getThemeTokens(mode))) {
    if (!SPEC_ALLOWED_KEYS.has(key) && LIGHT_TOKENS[key] !== DARK_TOKENS[key]) out[key] = value;
  }
  return out;
}

/**
 * The `<style>` block written into the app document's `<head>` at mount.
 *
 * It holds every token except the ones {@link getModeExtensionTokens} carries.
 * It is unlayered, so it outranks an SDK's `@layer` defaults, and only an
 * inline value beats it. A spec key here is a first-paint seed that any spec
 * client overwrites inline from `styles.variables` on every theme change. A
 * mode-varying non-spec key would be overwritten only by a client that reads
 * the extension; in every other client it would stay at the mount's mode for
 * the life of the frame, so it is left out, and such a client renders its own
 * default instead. What remains outside the spec is mode-independent (the
 * extra type-scale steps, `--nb-font-heading`), so it cannot go stale.
 */
export function buildThemeStyleBlock(mode: ThemeMode): string {
  const modeExtension = getModeExtensionTokens(mode);
  const declarations = Object.entries(getThemeTokens(mode))
    .filter(([key]) => !(key in modeExtension))
    .map(([key, value]) => `  ${key}: ${value};`)
    .join("\n");

  // `color-scheme` is what the browser draws its own parts with: scrollbars, form
  // controls, the canvas behind a transparent body. Without it an app in dark mode
  // gets a dark page with light scrollbars. Here it is only the first-paint seed:
  // the frame is sandboxed, so the host cannot update it after a toggle.
  // `@nimblebrain/synapse` keeps it current, setting it inline from
  // `hostContext.theme` at the handshake and on every `host-context-changed`. An
  // app on another client keeps the mount's mode for these parts.
  return `<style>
:root {
  color-scheme: ${mode};
${declarations}
}
*, *::before, *::after {
  box-sizing: border-box;
}
body {
  margin: 0;
  font-family: var(--font-sans);
  background: var(--color-background-primary);
  color: var(--color-text-primary);
}
</style>`;
}

export function getHostThemeMode(): ThemeMode {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}
