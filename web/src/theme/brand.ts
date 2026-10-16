/**
 * A tenant brand, and the palette it produces when laid over the canonical one.
 *
 * The brand is the `brand` block of `nimblebrain.json`. The runtime validates it
 * at config load and serves it at `GET /v1/brand.js`; the web client merges it at
 * boot. Both call {@link mergePalette}, so the palette the runtime checked for
 * contrast is exactly the palette the shell paints.
 *
 * A brand sets up to four colors as `[light, dark]` pairs, the shape
 * `palette.ts` uses, and the `sans`, `heading` and `reading` stacks. The
 * colors are roles, not tokens: each one derives a family of tokens
 * ({@link mergePalette}), so a brand names the few colors its identity is made
 * of and the shell stays coherent around them. The mono stack and the radius
 * scale stay canonical.
 *
 * Leaf module: no DOM, no React. The runtime imports it without `web/`
 * dependencies installed.
 */

import { AA_TEXT, contrastRatio, over } from "./contrast.ts";
import type { ColorPalette, SidebarIsland } from "./contrast-pairs.ts";
import { hexToOklch, type Oklch, oklchToHex } from "./oklch.ts";
import { colors, extOnlyColors, fonts, type Pair } from "./palette.ts";

/** A typeface role of the canonical palette. */
export type FontRole = keyof typeof fonts;

/**
 * The color roles a brand may set.
 *
 * - `primary`: actions, links, accent text. Its hue also tints the neutrals.
 * - `ring`: the focus ring, usually equal to `primary`.
 * - `highlight`: the fill of the active sidebar row.
 * - `sidebar`: the sidebar ground in light mode, and the anchor of the whole
 *   dark-mode surface family.
 */
export const BRAND_COLOR_TOKENS = ["primary", "ring", "highlight", "sidebar"] as const;
export type BrandColorToken = (typeof BRAND_COLOR_TOKENS)[number];

/** The typeface roles a brand may set. */
export const BRAND_FONT_ROLES = ["sans", "heading", "reading"] as const;
export type BrandFontRole = (typeof BRAND_FONT_ROLES)[number];

/** A color theme setting: a fixed mode, or `system` to follow the OS. */
export type ThemeSetting = "light" | "dark" | "system";

/**
 * One typeface role. `url` names one woff2 file (typically a variable font)
 * declared under `family`, covering `weight`. A role without `url` must name a
 * font the visitor already has — a system font.
 */
export interface BrandFont {
  /** The CSS `font-family` value, fallbacks included. */
  stack: string;
  /** The family name the file is declared under. Required with `url`. */
  family?: string;
  url?: string;
  /** CSS `font-weight` descriptor: `"400"`, or a variable range `"400 700"`. Only with `url`. */
  weight?: string;
}

/** The `brand` block of `nimblebrain.json`. Every key optional. */
export interface Brand {
  /** Replaces "NimbleBrain" wherever a user reads the product's name. */
  name?: string;
  homepageUrl?: string;
  logo?: {
    light?: string;
    dark?: string;
    mark?: string;
    /** PNG mark for OAuth consent screens, several of which refuse SVG. */
    raster?: string;
  };
  favicon?: string;
  /** The theme a person starts in until they choose one. Absent is `system`. */
  defaultTheme?: ThemeSetting;
  colors?: Partial<Record<BrandColorToken, Pair>>;
  fonts?: Partial<Record<BrandFontRole, BrandFont>>;
}

/** The brand as `GET /v1/brand.js` serves it: validated, and holding only the keys above. */
export type ResolvedBrand = Brand;

/** The full overridable palette: colors and stacks. */
export interface Palette extends ColorPalette {
  fonts: Record<FontRole, string>;
}

const WHITE = "#ffffff";
const BLACK = "#000000";

/** White or black, whichever reads better on `base`. */
function readableOn(base: string): string {
  return contrastRatio(WHITE, base) >= contrastRatio(BLACK, base) ? WHITE : BLACK;
}

/**
 * `info-light` as a tint of `primary` over the page ground, `[light, dark]`
 * percent: the 10% / 20% of the tinted family (`contrast-pairs.ts`), which is
 * how the canonical `info-light` sits against the canonical blue.
 */
const INFO_TINT_PCT = [10, 20] as const;

type Token = keyof typeof colors | keyof typeof extOnlyColors;

/**
 * Chroma a neutral takes on toward the brand's hue, by role and mode. Lightness
 * stays canonical, so each neutral keeps its contrast; only its cast changes.
 * Surfaces and lines take a trace, text a little more, so ink reads as the
 * brand's dark color rather than gray.
 */
const NEUTRAL_TINT: readonly [tokens: Token[], light: number, dark: number][] = [
  [
    ["sidebar", "sidebar-hover", "secondary", "muted", "accent", "background-tertiary"],
    0.014,
    0.012,
  ],
  [["border", "input", "sidebar-border"], 0.02, 0.018],
  [
    [
      "foreground",
      "card-foreground",
      "popover-foreground",
      "secondary-foreground",
      "accent-foreground",
      "sidebar-active-foreground",
    ],
    0.06,
    0.012,
  ],
  [["muted-foreground", "sidebar-foreground", "text-tertiary"], 0.04, 0.03],
];

/**
 * The dark-mode surface family, as lightness steps above the brand's dark
 * `sidebar` color, which is the deepest surface. Every step keeps the
 * anchor's hue and chroma, so dark mode reads as one colored ground rather
 * than the brand's colors on black.
 */
const DARK_SURFACE_STEPS: readonly [tokens: Token[], lift: number][] = [
  [["background"], 0.03],
  [["card", "popover"], 0.05],
  [["sidebar-active"], 0.07],
  [["secondary", "muted", "accent", "background-tertiary", "sidebar-hover"], 0.095],
  [["border", "input", "sidebar-border"], 0.145],
];

/**
 * Canonical colors painted as text on the page and card grounds, alone and on
 * a 20% tint of themselves (`contrast-pairs.ts`). They were chosen for the
 * canonical near-black, so on a brand's colored dark ground each is lightened,
 * hue and chroma kept, until it clears AA there. A brand's own colors are
 * never adjusted: one that fails is rejected at load.
 */
const DARK_GROUND_TEXT: readonly Token[] = [
  "destructive",
  "success",
  "warning",
  "processing",
  "scope-org",
  "scope-workspace",
  "scope-user",
  "scope-connector",
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
];

/** `hex`, lightened in OKLCH until it reads at AA on each ground and on its own 20% tint over it. */
function liftToRead(hex: string, grounds: readonly string[]): string {
  const reads = (fg: string) =>
    grounds.every(
      (g) => contrastRatio(fg, g) >= AA_TEXT && contrastRatio(fg, over(fg, g, 20)) >= AA_TEXT,
    );
  const color = hexToOklch(hex);
  let out = hex;
  while (!reads(out) && color.l < 0.98) {
    color.l += 0.01;
    out = oklchToHex(color);
  }
  return out;
}

/** Text on the dark surface family: lightness and chroma at the anchor's hue. */
const DARK_SURFACE_TEXT: readonly [tokens: Token[], l: number, c: number][] = [
  [
    [
      "foreground",
      "card-foreground",
      "popover-foreground",
      "secondary-foreground",
      "accent-foreground",
      "sidebar-active-foreground",
    ],
    0.97,
    0.012,
  ],
  [["muted-foreground", "sidebar-foreground"], 0.8, 0.04],
  [["text-tertiary"], 0.74, 0.035],
];

/** An island's hover and border, as lightness lifts over its ground, and its text. */
const ISLAND = { hover: 0.06, border: 0.08, text: { l: 0.86, c: 0.04 } } as const;

const isPair = (v: unknown): v is Pair =>
  Array.isArray(v) &&
  v.length === 2 &&
  v.every((x) => typeof x === "string" && /^#[0-9a-f]{6}$/i.test(x));

/**
 * Chroma at which a brand color's hue counts in full. Below it the hue angle
 * grows unreliable (a gray's is rounding noise), so a derivation scales the
 * color it would add by {@link hueWeight} and a black, white or gray brand
 * leaves the neutrals as they are.
 */
const FULL_HUE_CHROMA = 0.04;

/** How far, 0 to 1, a color's hue may cast the colors derived from it. */
const hueWeight = (color: Oklch) => Math.min(1, color.c / FULL_HUE_CHROMA);

/**
 * `hex` with its lightness kept, moved toward hue `h` at chroma `c` by `weight`
 * (0 keeps it, 1 replaces its hue and chroma). The move is in OKLab, so a
 * partial one blends the two casts rather than swinging the hue angle.
 */
function recast(hex: string, h: number, c: number, weight: number): string {
  const base = hexToOklch(hex);
  const ab = (hue: number, chroma: number) => {
    const rad = (hue * Math.PI) / 180;
    return [chroma * Math.cos(rad), chroma * Math.sin(rad)] as const;
  };
  const [a0, b0] = ab(base.h, base.c);
  const [a1, b1] = ab(h, c);
  const a = a0 + (a1 - a0) * weight;
  const b = b0 + (b1 - b0) * weight;
  const hue = (Math.atan2(b, a) * 180) / Math.PI;
  return oklchToHex({ l: base.l, c: Math.hypot(a, b), h: hue < 0 ? hue + 360 : hue });
}

/**
 * Whether the light-mode sidebar is a dark island: a `sidebar` light color
 * that reads best under white text. The shell then renders the sidebar under
 * the dark palette ({@link Palette.sidebarIsland} holds its ground).
 */
export function sidebarIsIsland(brand?: Pick<Brand, "colors">): boolean {
  const ground = brand?.colors?.sidebar?.[0];
  return ground !== undefined && readableOn(ground) === WHITE;
}

/**
 * Lay `brand` over the canonical palette. Each color role derives a family:
 *
 * - `primary` sets the accent, and its hue recasts the neutrals
 *   ({@link NEUTRAL_TINT}) at their canonical lightness, so text, borders and
 *   gray surfaces carry the brand's cast. `primary-foreground` is, per mode,
 *   white or black, whichever reads better on the accent.
 * - `sidebar`'s dark color anchors dark mode: every surface is a lightness
 *   step above it ({@link DARK_SURFACE_STEPS}), and text takes its hue. Its
 *   light color is the light-mode sidebar ground; a dark one makes the
 *   sidebar an island under the dark palette ({@link sidebarIsIsland}).
 * - `highlight` fills the active sidebar row, under white or black text.
 *
 * `info-light`, the ground of info notices and the turn-pill hover, is a tint
 * of the accent over the page ground ({@link INFO_TINT_PCT}). Only the roles
 * above and the font roles are read; anything else on the object is ignored.
 * With no brand, the result equals the canonical palette.
 */
export function mergePalette(brand?: Pick<Brand, "colors" | "fonts">): Palette {
  const brandColors = brand?.colors ?? {};
  assertPairs(brandColors);
  const { primary, ring, highlight, sidebar } = brandColors;
  const modes: Modes = { light: {}, dark: {} };
  for (const [name, pair] of Object.entries({ ...colors, ...extOnlyColors })) {
    modes.light[name] = pair[0];
    modes.dark[name] = pair[1];
  }

  if (primary) applyPrimary(modes, primary);
  if (ring) set(modes, "ring", ring);
  const island = sidebar ? applySidebar(modes, sidebar) : undefined;
  if (highlight) applyHighlight(modes, highlight);
  else if (primary || sidebar) recomputeActiveRow(modes, !sidebar);
  if (primary || sidebar) recomputeInfoLight(modes);

  const pairs = (names: readonly string[]) =>
    Object.fromEntries(names.map((n) => [n, [modes.light[n], modes.dark[n]] as Pair]));
  return {
    colors: pairs(Object.keys(colors)) as ColorPalette["colors"],
    extOnlyColors: pairs(Object.keys(extOnlyColors)) as ColorPalette["extOnlyColors"],
    ...(island ? { sidebarIsland: island } : {}),
    fonts: brandStacks(brand),
  };
}

/** Throw unless every color role the brand sets is a `[light, dark]` pair of hex colors. */
function assertPairs(brandColors: NonNullable<Brand["colors"]>): void {
  for (const role of BRAND_COLOR_TOKENS) {
    const pair: unknown = brandColors[role];
    if (pair !== undefined && !isPair(pair)) {
      throw new Error(`colors.${role} is not a [light, dark] pair`);
    }
  }
}

/** The canonical stacks with the brand's roles laid over them. */
function brandStacks(brand?: Pick<Brand, "fonts">): Record<FontRole, string> {
  const stacks: Record<string, string> = { ...fonts };
  for (const role of BRAND_FONT_ROLES) {
    const font = brand?.fonts?.[role];
    if (font !== undefined) stacks[role] = font.stack;
  }
  return stacks as Record<FontRole, string>;
}

/** The palette being merged, one value per token per mode. */
interface Modes {
  light: Record<string, string>;
  dark: Record<string, string>;
}

function set(modes: Modes, token: Token, pair: Pair): void {
  modes.light[token] = pair[0];
  modes.dark[token] = pair[1];
}

const read = (map: Record<string, string>, token: Token): string => map[token] as string;

/** The accent, the text on it, and the neutrals recast to its hue. */
function applyPrimary(modes: Modes, primary: Pair): void {
  set(modes, "primary", primary);
  modes.light["primary-foreground"] = readableOn(primary[0]);
  modes.dark["primary-foreground"] = readableOn(primary[1]);
  const [light, dark] = [hexToOklch(primary[0]), hexToOklch(primary[1])];
  for (const [tokens, cLight, cDark] of NEUTRAL_TINT) {
    for (const token of tokens) {
      modes.light[token] = recast(read(modes.light, token), light.h, cLight, hueWeight(light));
      modes.dark[token] = recast(read(modes.dark, token), dark.h, cDark, hueWeight(dark));
    }
  }
}

/** The dark surface family from the dark color; the light sidebar, or its island, from the light. */
function applySidebar(modes: Modes, sidebar: Pair): SidebarIsland | undefined {
  const { dark, light } = modes;
  const anchor = hexToOklch(sidebar[1]);
  dark.sidebar = sidebar[1];
  for (const [tokens, lift] of DARK_SURFACE_STEPS) {
    for (const token of tokens) dark[token] = oklchToHex({ ...anchor, l: anchor.l + lift });
  }
  for (const [tokens, l, c] of DARK_SURFACE_TEXT) {
    for (const token of tokens)
      dark[token] = oklchToHex({ l, c: c * hueWeight(anchor), h: anchor.h });
  }
  const grounds = [read(dark, "background"), read(dark, "card")];
  for (const token of DARK_GROUND_TEXT) dark[token] = liftToRead(read(dark, token), grounds);

  const ground = hexToOklch(sidebar[0]);
  if (readableOn(sidebar[0]) === WHITE) {
    return {
      sidebar: sidebar[0],
      "sidebar-hover": oklchToHex({ ...ground, l: ground.l + ISLAND.hover }),
      "sidebar-border": oklchToHex({ ...ground, l: ground.l + ISLAND.border }),
      "sidebar-foreground": oklchToHex({
        l: ISLAND.text.l,
        c: ISLAND.text.c * hueWeight(ground),
        h: ground.h,
      }),
    };
  }
  light.sidebar = sidebar[0];
  light["sidebar-hover"] = oklchToHex({ ...ground, l: ground.l - 0.03 });
  light["sidebar-border"] = oklchToHex({ ...ground, l: ground.l - 0.07 });
  return undefined;
}

function applyHighlight(modes: Modes, highlight: Pair): void {
  set(modes, "sidebar-active", highlight);
  modes.light["sidebar-active-foreground"] = readableOn(highlight[0]);
  modes.dark["sidebar-active-foreground"] = readableOn(highlight[1]);
}

/**
 * The canonical active row is `sidebar-foreground` at 10% over `sidebar`; keep
 * that relation over a brand's recast sidebar. Dark mode keeps it too unless
 * the dark surfaces were derived, which set the row as a surface step.
 */
function recomputeActiveRow(modes: Modes, includeDark: boolean): void {
  const row = (m: Record<string, string>) =>
    over(read(m, "sidebar-foreground"), read(m, "sidebar"), 10);
  modes.light["sidebar-active"] = row(modes.light);
  if (includeDark) modes.dark["sidebar-active"] = row(modes.dark);
}

function recomputeInfoLight(modes: Modes): void {
  for (const [map, pct] of [
    [modes.light, INFO_TINT_PCT[0]],
    [modes.dark, INFO_TINT_PCT[1]],
  ] as const) {
    map["info-light"] = over(read(map, "primary"), read(map, "background"), pct);
  }
}
