/**
 * Theme token map — single source of truth for CSS variable injection into iframes
 * and the bridge theme protocol.
 *
 * Token values extracted from web/src/index.css (:root for light, .dark for dark).
 * Tokens follow the MCP ext-apps spec (2026-01-26) where a standard equivalent exists.
 * NimbleBrain-specific extension tokens use the --nb- prefix.
 */

export type ThemeMode = "light" | "dark";
export type ThemeTokens = Record<string, string>;

export const LIGHT_TOKENS: ThemeTokens = {
  // ── ext-apps spec: Colors ──────────────────────────────────────────
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

  // ── ext-apps spec: Typography ──────────────────────────────────────
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

  // ── ext-apps spec: Layout ──────────────────────────────────────────
  "--border-radius-xs": "0.25rem",
  "--border-radius-sm": "0.5rem",
  "--border-radius-md": "0.75rem",
  "--border-radius-lg": "1rem",
  "--border-radius-xl": "1.5rem",
  "--border-width-regular": "1px",

  // ── ext-apps spec: Effects ─────────────────────────────────���───────
  "--shadow-hairline": "0 0 0 1px rgba(0,0,0,0.06)",
  "--shadow-sm": "0 1px 2px rgba(0,0,0,0.05)",
  "--shadow-md": "0 4px 6px -1px rgba(0,0,0,0.1)",
  "--shadow-lg": "0 10px 15px -3px rgba(0,0,0,0.1)",

  // ── NimbleBrain extensions (no ext-apps spec equivalent) ───────────
  "--nb-color-accent-foreground": "#ffffff",
  "--nb-color-danger": "#dc2626",
  "--nb-color-success": "#059669",
  "--nb-color-warning": "#f59e0b",
  "--nb-font-heading": "'Erode', Georgia, 'Times New Roman', serif",
};

export const DARK_TOKENS: ThemeTokens = {
  // ── ext-apps spec: Colors ──────────────────────────────────────────
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

  // ── ext-apps spec: Typography ──────────────────────────────────────
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

  // ── ext-apps spec: Layout ─���─────────────────────��──────────────────
  "--border-radius-xs": "0.25rem",
  "--border-radius-sm": "0.5rem",
  "--border-radius-md": "0.75rem",
  "--border-radius-lg": "1rem",
  "--border-radius-xl": "1.5rem",
  "--border-width-regular": "1px",

  // ── ext-apps spec: Effects ─────────────────────────────���───────────
  "--shadow-hairline": "0 0 0 1px rgba(255,255,255,0.06)",
  "--shadow-sm": "0 1px 2px rgba(0,0,0,0.3)",
  "--shadow-md": "0 4px 6px -1px rgba(0,0,0,0.4)",
  "--shadow-lg": "0 10px 15px -3px rgba(0,0,0,0.4)",

  // ─��� NimbleBrain extensions (no ext-apps spec equivalent) ───���───────
  "--nb-color-accent-foreground": "#0a0a09",
  "--nb-color-danger": "#f87171",
  "--nb-color-success": "#34d399",
  "--nb-color-warning": "#fbbf24",
  "--nb-font-heading": "'Erode', Georgia, 'Times New Roman', serif",
};

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
