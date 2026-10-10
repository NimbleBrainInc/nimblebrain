/**
 * The tenant brand in the browser: read it, paint it.
 *
 * The runtime serves the deployment's `brand` block as `GET /v1/brand.js`,
 * already validated for contrast. index.html loads that script before the app
 * bundle, so `window.__NB_BRAND__` holds the brand (`{}` when there is none)
 * by the time {@link bootBrand} runs, and the first render paints branded.
 * This module lays it over the canonical palette with the same
 * {@link mergePalette} the runtime validated, and applies the result everywhere
 * the product shows itself:
 *
 *  - a `<style id="nb-brand">` redefining the shell's tokens, plus one
 *    `@font-face` per brand font file;
 *  - `document.title` and the favicon links;
 *  - the iframe token maps and the iframe font channel, so embedded apps paint
 *    the brand too;
 *  - the brand store, which `Logo` and the few strings that name the product
 *    read through {@link useBrand}.
 *
 * The brand is fixed for the life of the page. **Failure is canonical**: a
 * script that failed to load leaves `window.__NB_BRAND__` undefined, and a
 * value that is not an object, or that the merge cannot read, paints the
 * default rather than half a brand.
 */

import { type BrandFontSpec, fontFaceRule, registerBrandFonts } from "./bridge/fonts";
import { setThemePalette } from "./bridge/theme";
import { mergePalette, type ResolvedBrand } from "./theme/brand";
import { paletteToRootCss } from "./theme/projections";

declare global {
  interface Window {
    /** Assigned by `/v1/brand.js`, loaded before the bundle. */
    __NB_BRAND__?: unknown;
  }
}

/** The product name when no brand names one. */
export const DEFAULT_BRAND_NAME = "NimbleBrain";

const STYLE_ID = "nb-brand";

let current: ResolvedBrand = {};

/** The applied brand. `{}` is canonical. */
export function getBrand(): ResolvedBrand {
  return current;
}

/** The applied brand. It is applied before the first render and never changes after. */
export function useBrand(): ResolvedBrand {
  return current;
}

/** The product name a person reads. */
export function useBrandName(): string {
  return useBrand().name ?? DEFAULT_BRAND_NAME;
}

/** Apply the brand `/v1/brand.js` assigned, or canonical when there is none to apply. */
export function bootBrand(): void {
  const value = window.__NB_BRAND__;
  applyBrand(isBrand(value) ? value : {});
}

function isBrand(value: unknown): value is ResolvedBrand {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Paint `brand`, or canonical if it cannot be painted. `{}` is canonical. */
export function applyBrand(brand: ResolvedBrand): void {
  try {
    paint(brand);
    current = brand;
  } catch (err) {
    console.warn("[brand] could not apply the brand; using the default", err);
    paint({});
    current = {};
  }
}

function paint(brand: ResolvedBrand): void {
  const palette = mergePalette(brand);
  const faces = brandFaces(brand);
  const overrides = brand.colors || brand.fonts;

  let style = document.getElementById(STYLE_ID);
  if (overrides) {
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
    }
    const rules = faces.map((f) => fontFaceRule(f.family, f.url, f.weight));
    style.textContent = [...rules, paletteToRootCss(palette)].join("\n");
    // Last in <head>, after the stylesheet it overrides: same selectors, later wins.
    document.head.appendChild(style);
  } else {
    style?.remove();
  }

  setThemePalette(palette);
  registerBrandFonts(faces);
  setTitle(brand.name);
  setFavicon(brand.favicon);
}

/** The `@font-face` each brand role with a file declares, one per distinct family, URL and weight. */
function brandFaces(brand: ResolvedBrand): BrandFontSpec[] {
  const out = new Map<string, BrandFontSpec>();
  for (const font of Object.values(brand.fonts ?? {})) {
    if (!font?.family || !font.url) continue;
    const spec: BrandFontSpec = {
      family: font.family,
      url: font.url,
      ...(font.weight ? { weight: font.weight } : {}),
    };
    out.set(`${spec.family}\n${spec.url}\n${spec.weight ?? ""}`, spec);
  }
  return [...out.values()];
}

// ── Title and favicon ───────────────────────────────────────────────────────

function setTitle(name: string | undefined): void {
  document.title = name ?? DEFAULT_BRAND_NAME;
}

/**
 * Point every favicon link at the brand's image. With none, index.html's links
 * stay as shipped.
 */
function setFavicon(url: string | undefined): void {
  if (!url) return;
  for (const el of document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')) {
    // One brand image replaces every size; the canonical type and sizes
    // describe the canonical files, not it.
    el.setAttribute("href", url);
    el.removeAttribute("type");
    el.removeAttribute("sizes");
  }
}
