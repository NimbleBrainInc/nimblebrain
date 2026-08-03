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

/**
 * Font stacks. `sans` and `heading` are one family — hierarchy comes from
 * weight and size, not from a display/text style split. `reading` is the
 * exception and is scoped to agent prose in chat, the only surface where
 * reading beats scanning; it is a screen-text serif, never a display serif.
 * `sans`/`heading`/`reading` are served via Google Fonts, `mono` via Fontsource.
 */
export const fonts = {
  sans: "'Hanken Grotesk', system-ui, sans-serif",
  heading: "'Hanken Grotesk', system-ui, sans-serif",
  reading: "'Newsreader', Georgia, serif",
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
  background: ["#ffffff", "#000000"],
  foreground: ["#09090b", "#fafafa"],
  card: ["#ffffff", "#0e0e10"],
  "card-foreground": ["#09090b", "#fafafa"],
  popover: ["#ffffff", "#0e0e10"],
  "popover-foreground": ["#09090b", "#fafafa"],
  // NimbleBrain Blue. The single accent: every primary action, focus ring, and
  // live state. There is no second accent hue; status colours are the only
  // other hues in the interface.
  primary: ["#315EDB", "#6a8fe4"],
  "primary-foreground": ["#ffffff", "#000000"],
  secondary: ["#f4f4f5", "#161618"],
  "secondary-foreground": ["#09090b", "#fafafa"],
  muted: ["#f4f4f5", "#161618"],
  "muted-foreground": ["#5c5c66", "#9b9ba4"],
  accent: ["#f4f4f5", "#161618"],
  "accent-foreground": ["#09090b", "#fafafa"],
  destructive: ["#c02a24", "#f0736a"],
  "destructive-foreground": ["#ffffff", "#000000"],
  // Translucent 10% tints of `foreground` and `destructive`, used as the chat
  // bubble fill and the failed-tool-call ground. They are alpha values rather
  // than `color-mix(… 10%, transparent)` because Tailwind emits every
  // `color-mix()` in a colour property as a pair: the real value behind an
  // `@supports` test, and an unguarded FIRST OPERAND for browsers that fail it
  // — dropping both the percentage and the transparency. That fallback is
  // emitted after any fallback we declare ourselves, so it cannot be
  // pre-empted, and it resolves to the same value as the text painted on top:
  // 1.000:1. `rgba()` gets no such pair, and being translucent it still
  // composites over whichever surface the element lands on, which is the whole
  // reason the tint was mixed rather than fixed.
  //
  // The channels must track their source token. `contrast.test.ts` asserts that.
  "foreground-tint": ["rgba(9, 9, 11, 0.1)", "rgba(250, 250, 250, 0.1)"],
  "destructive-tint": ["rgba(192, 42, 36, 0.1)", "rgba(240, 115, 106, 0.1)"],
  border: ["#e4e4e7", "#232326"],
  input: ["#e4e4e7", "#232326"],
  ring: ["#315EDB", "#6a8fe4"],
  success: ["#0f7a4f", "#3fbf85"],
  warning: ["#8a5f0a", "#e0aa3c"],
  processing: ["#6d3ecf", "#a68bfa"],
  "processing-light": ["#f0ecfd", "#161234"],
  "info-light": ["#eaf0ff", "#0b1a33"],
  // Skill-scope tones for the Context Ledger — one hue per tier (org /
  // workspace / user / connector; the wire value for the connector tier is
  // still `bundle`). Shell-only (no ext-apps projection); shape and
  // label carry the distinction too, so color never encodes it alone. Every
  // one clears 3:1 against `card` in both modes (WCAG 1.4.11) — they carry
  // information, so they are not decorative. They are also deliberately
  // distinct from `primary` and from every status hue: a tier that renders in
  // the warning amber or the success green reads as a status, not a scope.
  "scope-org": ["#1d4ed8", "#7aa2f7"],
  "scope-workspace": ["#0e7490", "#4dd0e1"],
  "scope-user": ["#7c3aed", "#b79bfc"],
  "scope-connector": ["#a13d0f", "#f0894f"],
  sidebar: ["#fafafa", "#08080a"],
  "sidebar-foreground": ["#5c5c66", "#9b9ba4"],
  "sidebar-border": ["#e4e4e7", "#232326"],
  "sidebar-hover": ["#f4f4f5", "#0e0e10"],
} as const satisfies Record<string, Pair>;

/**
 * Values used only by the ext-apps token projection (no clean shadcn-name
 * equivalent in `index.css`). Kept here so the palette is the full union and
 * the ext-apps projection never hardcodes a value.
 */
export const extOnlyColors = {
  "background-tertiary": ["#f4f4f5", "#161618"],
  // Ext-apps only: `paletteToRootCss` emits `colors`, so the shell never sees
  // these. They reach embedded iframes via `paletteToExtAppsTokens`, which is
  // the only place they meet, and `contrast.test.ts` checks exactly that pair.
  "text-tertiary": ["#6b6b73", "#82828c"],
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
