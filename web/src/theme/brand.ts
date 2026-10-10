/**
 * A tenant brand, and the palette it produces when laid over the canonical one.
 *
 * The brand is the `brand` block of `nimblebrain.json`. The runtime validates it
 * at config load and serves it at `GET /v1/brand`; the web client merges it at
 * boot. Both call {@link mergePalette}, so the palette the runtime checked for
 * contrast is exactly the palette the shell paints.
 *
 * A brand sets the accent (`primary`) and focus ring (`ring`) as `[light, dark]`
 * pairs, the shape `palette.ts` uses, and the `sans`, `heading` and `reading`
 * stacks. Every other token, the mono stack and the radius scale stay canonical.
 *
 * Leaf module: no DOM, no React. The runtime imports it without `web/`
 * dependencies installed.
 */

import { contrastRatio } from "./contrast.ts";
import type { ColorPalette } from "./contrast-pairs.ts";
import { colors, extOnlyColors, fonts, type Pair } from "./palette.ts";

/** A typeface role of the canonical palette. */
export type FontRole = keyof typeof fonts;

/** The colour tokens a brand may set. */
export const BRAND_COLOR_TOKENS = ["primary", "ring"] as const;
export type BrandColorToken = (typeof BRAND_COLOR_TOKENS)[number];

/** The typeface roles a brand may set. */
export const BRAND_FONT_ROLES = ["sans", "heading", "reading"] as const;
export type BrandFontRole = (typeof BRAND_FONT_ROLES)[number];

/** A colour theme setting: a fixed mode, or `system` to follow the OS. */
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

/** The brand as `GET /v1/brand` serves it: validated, and holding only the keys above. */
export type ResolvedBrand = Brand;

/** The full overridable palette: colours and stacks. */
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
 * Lay `brand` over the canonical palette.
 *
 * `primary-foreground` follows a brand `primary`: per mode, white or black,
 * whichever has the higher contrast against the new accent. The canonical
 * foreground was chosen for the canonical accent and says nothing about the
 * brand's. Only the tokens and roles a brand may set are read; anything else
 * on the object is ignored. With no brand, the result equals the canonical
 * palette.
 */
export function mergePalette(brand?: Pick<Brand, "colors" | "fonts">): Palette {
  const merged: Record<string, Pair> = { ...colors };
  for (const token of BRAND_COLOR_TOKENS) {
    const pair = brand?.colors?.[token];
    if (pair !== undefined) merged[token] = pair;
  }
  const primary = brand?.colors?.primary;
  if (primary) merged["primary-foreground"] = [readableOn(primary[0]), readableOn(primary[1])];

  const stacks: Record<string, string> = { ...fonts };
  for (const role of BRAND_FONT_ROLES) {
    const font = brand?.fonts?.[role];
    if (font !== undefined) stacks[role] = font.stack;
  }

  return {
    colors: merged as ColorPalette["colors"],
    extOnlyColors: { ...extOnlyColors },
    fonts: stacks as Record<FontRole, string>,
  };
}
