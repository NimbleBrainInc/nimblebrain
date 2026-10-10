/**
 * The tenant brand: the `brand` block of `nimblebrain.json`, validated once at
 * config load and read by everything that shows the product's name, colour or
 * mark to a person.
 *
 * The type and the palette merge live in `web/src/theme/brand.ts`, beside the
 * palette they override, because the web client merges the same block at boot.
 * This module owns what only the runtime does with it: reject a brand whose
 * merged palette fails a contrast pair, keep only the keys the schema defines,
 * and hand the result to its readers.
 *
 * An absent brand is NimbleBrain: {@link resolvedBrand} is `{}` and
 * {@link brandName} is {@link DEFAULT_BRAND_NAME}.
 */

import {
  BRAND_COLOR_TOKENS,
  BRAND_FONT_ROLES,
  type Brand,
  type BrandFont,
  mergePalette,
  type ResolvedBrand,
} from "../../web/src/theme/brand.ts";
import { contrastRatio } from "../../web/src/theme/contrast.ts";
import { contrastChecks } from "../../web/src/theme/contrast-pairs.ts";

export type {
  Brand,
  BrandColorToken,
  BrandFont,
  BrandFontRole,
  ResolvedBrand,
  ThemeSetting,
} from "../../web/src/theme/brand.ts";

export const DEFAULT_BRAND_NAME = "NimbleBrain";

/** A `brand` block the runtime refuses to boot with. */
export class BrandConfigError extends Error {
  constructor(message: string) {
    super(`Invalid brand in config: ${message}`);
    this.name = "BrandConfigError";
  }
}

const HEX = /^#[0-9A-Fa-f]{6}$/;
const WOFF2_URL = /^https?:\/\/[^\s"'()<>]+\.woff2(\?[^\s"'()<>]*)?$/;

let current: ResolvedBrand = {};

/**
 * Validate `config.brand`, install it as the process's brand, and return it.
 *
 * Runs the full contrast pair set from `contrast-pairs.ts` against the brand
 * merged over the canonical palette, in both modes, and throws
 * {@link BrandConfigError} naming the first failing pair and its ratio. Keys
 * the schema does not define are dropped, as the config loader reports them:
 * an unknown key is warned about and ignored, never served. An absent brand
 * installs `{}`. Idempotent: calling it again with the same config
 * installs the same value.
 */
export function loadBrand(config: { brand?: Brand }): ResolvedBrand {
  const brand = config.brand;
  if (!brand) {
    current = {};
    return current;
  }
  const resolved = resolveBrand(brand);
  assertContrast(resolved);
  current = resolved;
  return current;
}

/** The installed brand, as `GET /v1/brand.js` serves it. `{}` when none is configured. */
export function resolvedBrand(): ResolvedBrand {
  return current;
}

/** The product name a person reads. */
export function brandName(): string {
  return current.name ?? DEFAULT_BRAND_NAME;
}

const BRAND_NAME_TOKEN = /\{\{brand\.name\}\}/g;

/**
 * Replace `{{brand.name}}` in first-party text. Only for text the platform
 * ships (the vendored core skills, the default identity): a tenant-authored
 * skill is not templated, so the literal reaches the model as written.
 */
export function renderBrandName(text: string, name: string = brandName()): string {
  return text.replace(BRAND_NAME_TOKEN, () => name);
}

/** The client identity sent in OAuth dynamic client registration (RFC 7591). */
export interface OAuthClientIdentity {
  name: string;
  clientUri?: string;
  logoUri?: string;
}

/** The identity an unbranded deployment registers with. */
export const DEFAULT_OAUTH_CLIENT_IDENTITY: OAuthClientIdentity = {
  name: DEFAULT_BRAND_NAME,
  clientUri: "https://nimblebrain.ai",
  // The 128px raster rather than the SVG: several identity providers refuse to
  // render an SVG `logo_uri`. The mark is transparent and reads on both light
  // and dark consent screens.
  logoUri: "https://static.nimblebrain.ai/logos/nimblebrain/light-128.png",
};

/**
 * The name, homepage and logo a vendor's consent screen shows for this
 * platform. A branded deployment sends only its own values — a brand that
 * names itself but sets no homepage sends none, rather than NimbleBrain's.
 */
export function oauthClientIdentity(): OAuthClientIdentity {
  if (current.name === undefined) return DEFAULT_OAUTH_CLIENT_IDENTITY;
  return {
    name: current.name,
    ...(current.homepageUrl ? { clientUri: current.homepageUrl } : {}),
    ...(current.logo?.raster ? { logoUri: current.logo.raster } : {}),
  };
}

/** `brand` holding only the keys the schema defines, each checked. */
function resolveBrand(brand: Brand): ResolvedBrand {
  return {
    ...pick(brand, ["name", "homepageUrl", "favicon", "defaultTheme"]),
    ...(brand.logo ? { logo: pick(brand.logo, ["light", "dark", "mark", "raster"]) } : {}),
    ...(brand.colors ? { colors: resolveColors(brand.colors) } : {}),
    ...(brand.fonts ? { fonts: resolveFonts(brand.fonts) } : {}),
  };
}

/** The keys of `obj` named in `keys` that are set. */
function pick<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Pick<T, K> {
  const out: Partial<Pick<T, K>> = {};
  for (const key of keys) if (obj[key] !== undefined) out[key] = obj[key];
  return out as Pick<T, K>;
}

function resolveColors(colors: NonNullable<Brand["colors"]>): NonNullable<Brand["colors"]> {
  const out: NonNullable<Brand["colors"]> = {};
  for (const token of BRAND_COLOR_TOKENS) {
    const pair = colors[token];
    if (pair === undefined) continue;
    const ok = Array.isArray(pair) && pair.length === 2 && pair.every((v) => HEX.test(v));
    if (!ok) throw new BrandConfigError(`colors.${token} must be [light, dark] as #rrggbb`);
    out[token] = pair;
  }
  return out;
}

function resolveFonts(fonts: NonNullable<Brand["fonts"]>): NonNullable<Brand["fonts"]> {
  const out: NonNullable<Brand["fonts"]> = {};
  for (const role of BRAND_FONT_ROLES) {
    const font = fonts[role];
    if (font) out[role] = resolveFont(role, font);
  }
  return out;
}

function assertContrast(brand: Brand): void {
  const palette = mergePalette(brand);
  for (const mode of ["light", "dark"] as const) {
    for (const check of contrastChecks(palette, mode)) {
      const ratio = contrastRatio(check.fg, check.bg);
      if (ratio < check.min) {
        throw new BrandConfigError(
          `${mode} mode: ${check.name} is ${ratio.toFixed(2)}:1 (${check.fg} on ${check.bg}), ` +
            `below the ${check.min}:1 WCAG AA minimum`,
        );
      }
    }
  }
}

/** One role's font: a woff2 `url` declared under a `family`, or a system font. */
function resolveFont(role: string, font: BrandFont): BrandFont {
  if (font.url !== undefined) {
    if (!WOFF2_URL.test(font.url)) {
      throw new BrandConfigError(
        `fonts.${role} url ${font.url} is not a .woff2 file. A font URL names the font file ` +
          `itself; a stylesheet URL (such as Google Fonts CSS) is not accepted`,
      );
    }
    if (!font.family) {
      throw new BrandConfigError(`fonts.${role} sets a url but no family to declare it under`);
    }
  }
  return pick(
    font,
    font.url !== undefined ? ["stack", "family", "url", "weight"] : ["stack", "family"],
  );
}
