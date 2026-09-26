/**
 * A tenant brand, and the palette it produces when laid over the canonical one.
 *
 * The brand is the `brand` block of `nimblebrain.json`. The runtime validates it
 * at config load and serves it at `GET /v1/brand`; the web client merges it at
 * boot. Both call {@link mergePalette}, so the palette the runtime checked for
 * contrast is exactly the palette the shell paints.
 *
 * Colours override the canonical palette by token name, in the same
 * `[light, dark]` shape `palette.ts` uses. Radius overrides the radius scale.
 * Fonts override the stacks. Nothing else in the palette is overridable.
 *
 * Leaf module: no DOM, no React. The runtime imports it without `web/`
 * dependencies installed.
 */

import { contrastRatio } from "./contrast.ts";
import type { ColorPalette, ColorToken, ExtColorToken } from "./contrast-pairs.ts";
import { colors, extOnlyColors, fonts, type Pair, radiusScale } from "./palette.ts";

export type FontRole = keyof typeof fonts;

export type RadiusStep = "xs" | "sm" | "md" | "lg" | "xl";

/**
 * The translucent tints are computed from their source token, never set: a tint
 * that stopped tracking its source is the drift `contrast.test.ts` guards.
 */
type DerivedTint = "foreground-tint" | "destructive-tint";

/** A colour token a brand may set. */
export type BrandColorToken = Exclude<ColorToken, DerivedTint> | ExtColorToken;

/** One woff2 file and the weight (or variable range) it covers. */
export interface BrandFontFace {
  url: string;
  /** CSS `font-weight` descriptor: `"400"`, or a variable range `"400 700"`. */
  weight?: string;
}

/**
 * One typeface role, as written in `nimblebrain.json`. `url` + `weight` names a
 * single face (the usual shape for a variable font); `faces` names several
 * static ones. The two are mutually exclusive. A role with neither must name a
 * font the visitor already has — a system font.
 */
export interface BrandFont {
  /** The CSS `font-family` value, fallbacks included. */
  stack: string;
  /** The family name the faces are declared under. Required with `url` or `faces`. */
  family?: string;
  url?: string;
  weight?: string;
  faces?: BrandFontFace[];
}

/** One typeface role as served: faces normalised to a list, never `url`/`weight`. */
export interface ResolvedBrandFont {
  stack: string;
  family?: string;
  faces?: BrandFontFace[];
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
  colors?: Partial<Record<BrandColorToken, Pair>>;
  fonts?: Partial<Record<FontRole, BrandFont>>;
  radius?: Partial<Record<RadiusStep, string>>;
}

/** The brand as `GET /v1/brand` serves it: validated, fonts normalised. */
export interface ResolvedBrand extends Omit<Brand, "fonts"> {
  fonts?: Partial<Record<FontRole, ResolvedBrandFont>>;
}

/** The full overridable palette: colours, stacks, and radius scale. */
export interface Palette extends ColorPalette {
  fonts: Record<FontRole, string>;
  radiusScale: Record<keyof typeof radiusScale, string>;
}

const WHITE = "#ffffff";
const BLACK = "#000000";

/** White or black, whichever reads better on `base`. */
function readableOn(base: string): string {
  return contrastRatio(WHITE, base) >= contrastRatio(BLACK, base) ? WHITE : BLACK;
}

/** `rgba(r, g, b, 0.1)` of a `#rrggbb` source — the spelling `palette.ts` uses. */
function tintOf(hex: string): string {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, 0.1)`;
}

/**
 * Lay `brand` over the canonical palette.
 *
 * A `<x>-foreground` the brand omits, where the brand sets `<x>`, is derived
 * per mode as white or black, whichever has the higher contrast against the
 * new base. The canonical foreground was chosen for the canonical base and
 * says nothing about the brand's. The translucent tints are recomputed from
 * their merged source. With no brand, the result equals the canonical palette.
 */
export function mergePalette(brand?: Pick<Brand, "colors" | "fonts" | "radius">): Palette {
  const brandColors = (brand?.colors ?? {}) as Partial<Record<string, Pair>>;
  const merged = overlay(colors, brandColors) as Record<ColorToken, Pair>;
  deriveForegrounds(merged, brandColors);
  merged["foreground-tint"] = [tintOf(merged.foreground[0]), tintOf(merged.foreground[1])];
  merged["destructive-tint"] = [tintOf(merged.destructive[0]), tintOf(merged.destructive[1])];

  const stacks: Partial<Record<string, string>> = {};
  for (const [role, font] of Object.entries(brand?.fonts ?? {})) {
    if (font) stacks[role] = font.stack;
  }
  const radii: Partial<Record<string, string>> = {};
  for (const [step, value] of Object.entries(brand?.radius ?? {})) {
    radii[`--border-radius-${step}`] = value;
  }

  return {
    colors: merged,
    extOnlyColors: overlay(extOnlyColors, brandColors) as Record<ExtColorToken, Pair>,
    fonts: overlay(fonts, stacks) as Record<FontRole, string>,
    radiusScale: overlay(radiusScale, radii) as Record<keyof typeof radiusScale, string>,
  };
}

/** `base` with each of its own keys replaced where `over` sets one. Keys `base` lacks are ignored. */
function overlay<T>(base: Readonly<Record<string, T>>, over: Partial<Record<string, T>>) {
  const out: Record<string, T> = { ...base };
  for (const key of Object.keys(base)) {
    const value = over[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Fill each `<x>-foreground` the brand omits, where it sets `<x>`, with white or black. */
function deriveForegrounds(
  merged: Record<ColorToken, Pair>,
  brandColors: Partial<Record<string, Pair>>,
): void {
  for (const name of Object.keys(merged) as ColorToken[]) {
    if (!name.endsWith("-foreground") || brandColors[name]) continue;
    const base = brandColors[name.replace(/-foreground$/, "")];
    if (base) merged[name] = [readableOn(base[0]), readableOn(base[1])];
  }
}
