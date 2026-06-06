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
 * set and reject unknown keys, so anything the host sends must be in here.
 *
 * NB extensions (`--nb-*`) and out-of-spec tokens (`--color-text-accent`,
 * `--font-text-base-*`) are still injected into the iframe's inline `<style>`
 * block by `buildThemeStyleBlock` — they just don't cross the protocol
 * boundary. Iframe content that needs them uses them as local CSS vars.
 *
 * If the spec's variable enum grows, add entries here. TypeScript catches the
 * need via the `satisfies` check below — any key absent from
 * `McpUiStyleVariableKey` becomes a compile error.
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

export function buildThemeStyleBlock(mode: ThemeMode): string {
  const tokens = getThemeTokens(mode);
  const declarations = Object.entries(tokens)
    .map(([key, value]) => `  ${key}: ${value};`)
    .join("\n");

  return `<style>
:root {
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
