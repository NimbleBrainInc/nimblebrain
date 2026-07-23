/**
 * Canonical brand palette — the single source of truth for the host's theme.
 *
 * Every value the shell renders (web/src/index.css `:root`/`.dark`) and every
 * value injected into embedded-app iframes (web/src/bridge/theme.ts) derives
 * from this module. Change a color here once → the shell re-themes AND every
 * iframe app updates. Do not hand-define palette values anywhere else.
 *
 * Color values are stored as `[light, dark]` tuples. Non-color design-token
 * scales (type, weights, radii) are mode-independent; shadows differ by mode.
 *
 * This is a leaf module: no DOM, no React, no import from `bridge/theme.ts`.
 */

export type Mode = "light" | "dark";

/** `[light, dark]` value pair. */
export type Pair = readonly [light: string, dark: string];

/** Pick the value for a mode from a `[light, dark]` pair. */
export function pick(pair: Pair, mode: Mode): string {
  return mode === "dark" ? pair[1] : pair[0];
}

/** Font stacks. `sans` and `heading` are served via Fontshare, `mono` via Fontsource. */
export const fonts = {
  sans: "'Satoshi', system-ui, sans-serif",
  heading: "'Erode', Georgia, serif",
  mono: "'JetBrains Mono Variable', ui-monospace, SFMono-Regular, monospace",
} as const;

/** Layout constants (mode-independent; `:root` only). */
export const layout = {
  "--sidebar-width": "240px",
  "--sidebar-width-collapsed": "64px",
} as const;

/**
 * shadcn semantic colors, in `index.css` `:root`/`.dark` order. These are the
 * values the Tailwind `@theme inline` block aliases as `--color-*`.
 */
export const colors = {
  background: ["#faf9f7", "#0a0a09"],
  foreground: ["#171717", "#e5e5e5"],
  card: ["#ffffff", "#141413"],
  "card-foreground": ["#171717", "#e5e5e5"],
  popover: ["#ffffff", "#141413"],
  "popover-foreground": ["#171717", "#e5e5e5"],
  primary: ["#0055FF", "#3b8eff"],
  "primary-foreground": ["#ffffff", "#0a0a09"],
  secondary: ["#f8f7f5", "#1c1c1b"],
  "secondary-foreground": ["#171717", "#e5e5e5"],
  muted: ["#f8f7f5", "#1c1c1b"],
  "muted-foreground": ["#737373", "#a3a3a3"],
  accent: ["#f8f7f5", "#1c1c1b"],
  "accent-foreground": ["#171717", "#e5e5e5"],
  destructive: ["#dc2626", "#f87171"],
  border: ["#e5e5e5", "#262626"],
  input: ["#e5e5e5", "#262626"],
  ring: ["#0055FF", "#3b8eff"],
  success: ["#059669", "#34d399"],
  "success-foreground": ["#ffffff", "#0a0a09"],
  warning: ["#f59e0b", "#fbbf24"],
  "warning-foreground": ["#ffffff", "#0a0a09"],
  // Brand attention accent — the app's "look here" color: the chat FAB, selected
  // states (e.g. ProfileTab), and ambient notices (e.g. the update prompt).
  // Prefer this over `primary` (blue) for attention in the warm theme. Soft
  // surfaces: `warm-light`, or the badge pattern `bg-warm/10 text-warm`.
  warm: ["#d4620a", "#f59542"],
  "warm-hover": ["#b8540a", "#fb923c"],
  "warm-foreground": ["#ffffff", "#0a0a09"],
  "warm-light": ["#fef5ee", "#2a1a08"],
  processing: ["#7c3aed", "#a78bfa"],
  "processing-foreground": ["#ffffff", "#0a0a09"],
  "processing-light": ["#f3eeff", "#1a0f2e"],
  "info-light": ["#eef4ff", "#0c1a33"],
  // Skill-scope tones for the Context Ledger — one hue per tier (org /
  // workspace / user / bundle). Shell-only (no ext-apps projection); shape and
  // label carry the distinction too, so color never encodes it alone.
  "scope-org": ["#2563eb", "#60a5fa"],
  "scope-workspace": ["#059669", "#34d399"],
  "scope-user": ["#7c3aed", "#a78bfa"],
  "scope-bundle": ["#b45309", "#fbbf24"],
  "chart-1": ["#0055FF", "#3b8eff"],
  "chart-2": ["#059669", "#34d399"],
  "chart-3": ["#f59e0b", "#fbbf24"],
  "chart-4": ["#737373", "#a3a3a3"],
  "chart-5": ["#a3a3a3", "#525252"],
  sidebar: ["#f8f7f5", "#0f0f0e"],
  "sidebar-foreground": ["#737373", "#a3a3a3"],
  "sidebar-primary": ["#0055FF", "#3b8eff"],
  "sidebar-primary-foreground": ["#ffffff", "#ffffff"],
  // NOTE: shadcn-default BLUE (#eff6ff) — NOT the warm sidebar's accent; the name
  // misleads. Don't use it for sidebar surfaces in the warm theme. Neutral fills:
  // `sidebar-foreground/5`–`/10` (see NavItem); accented ones: `warm` (above).
  "sidebar-accent": ["#eff6ff", "#172554"],
  "sidebar-accent-foreground": ["#0055FF", "#3b8eff"],
  "sidebar-border": ["#e5e5e5", "#262626"],
  "sidebar-ring": ["#0055FF", "#3b8eff"],
  "sidebar-hover": ["#faf9f7", "#141413"],
} as const satisfies Record<string, Pair>;

/**
 * Values used only by the ext-apps token projection (no clean shadcn-name
 * equivalent in `index.css`). Kept here so the palette is the full union and
 * the ext-apps projection never hardcodes a value.
 */
export const extOnlyColors = {
  "background-tertiary": ["#f3f2ef", "#1c1c1b"],
  "text-tertiary": ["#a3a3a3", "#737373"],
} as const satisfies Record<string, Pair>;

/**
 * Mode-independent typography scale. Consumed two ways:
 *   - the shell `:root` (via `paletteToRootCss`), aliased into Tailwind's
 *     `--text-*` namespace in `index.css` so components use `text-2xs`…`text-lg`
 *     instead of hand-set `text-[11px]`.
 *   - the ext-apps iframe token map (via `paletteToExtAppsTokens`).
 *
 * `xs`–`lg` match Tailwind's default sizes (now single-sourced here). `2xs`/`3xs`
 * are the sub-`xs` steps the dense shell needs (sidebar rows, counts, metadata),
 * collapsing the prior ad-hoc `text-[9px]`…`text-[11px]` values onto the scale.
 */
export const typeScale = {
  "--font-weight-normal": "400",
  "--font-weight-medium": "500",
  "--font-weight-semibold": "600",
  "--font-weight-bold": "700",
  "--font-text-3xs-size": "0.625rem",
  "--font-text-3xs-line-height": "0.875rem",
  "--font-text-2xs-size": "0.6875rem",
  "--font-text-2xs-line-height": "1rem",
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
} as const;

/** Mode-independent layout scale (ext-apps token names → value). */
export const radiusScale = {
  "--border-radius-xs": "0.25rem",
  "--border-radius-sm": "0.5rem",
  "--border-radius-md": "0.75rem",
  "--border-radius-lg": "1rem",
  "--border-radius-xl": "1.5rem",
  "--border-width-regular": "1px",
} as const;

/** Mode-dependent effect tokens (ext-apps token names → value). */
export const shadows = {
  light: {
    "--shadow-hairline": "0 0 0 1px rgba(0,0,0,0.06)",
    "--shadow-sm": "0 1px 2px rgba(0,0,0,0.05)",
    "--shadow-md": "0 4px 6px -1px rgba(0,0,0,0.1)",
    "--shadow-lg": "0 10px 15px -3px rgba(0,0,0,0.1)",
  },
  dark: {
    "--shadow-hairline": "0 0 0 1px rgba(255,255,255,0.06)",
    "--shadow-sm": "0 1px 2px rgba(0,0,0,0.3)",
    "--shadow-md": "0 4px 6px -1px rgba(0,0,0,0.4)",
    "--shadow-lg": "0 10px 15px -3px rgba(0,0,0,0.4)",
  },
} as const satisfies Record<Mode, Record<string, string>>;
