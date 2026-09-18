/**
 * The tenant brand in the browser: fetch it, cache it, paint it.
 *
 * The runtime serves the deployment's `brand` block at `GET /v1/brand`, already
 * validated for contrast (`{}` when there is none). This module lays it over the
 * canonical palette with the same {@link mergePalette} the runtime validated,
 * and applies the result everywhere the product shows itself:
 *
 *  - a `<style id="nb-brand">` redefining the shell's tokens, plus one
 *    `@font-face` per brand face;
 *  - `document.title` and the favicon links;
 *  - the iframe token maps and the iframe font channel, so embedded apps paint
 *    the brand too;
 *  - the brand store, which `Logo` and the few strings that name the product
 *    read through {@link useBrand}.
 *
 * **Boot order.** {@link bootBrand} applies the last brand this browser saw
 * (localStorage) synchronously, then fetches the current one. With a cached
 * brand the first render paints branded at once and the fetch only corrects
 * it; without one, the first render waits for the fetch, bounded by
 * {@link FIRST_PAINT_WAIT_MS} so a slow server cannot hold the shell blank. A
 * fetch that lands after that still applies. `{}` from the server is an
 * answer, not a failure: it clears the cache and restores the canonical look.
 *
 * **Failure is canonical.** A fetch that fails keeps whatever is applied — the
 * cached brand, which was the server's own answer last time, or canonical. A
 * brand that cannot be applied (a cache written by an older client, a body the
 * merge cannot read) falls back to canonical rather than half-painting.
 */

import { useSyncExternalStore } from "react";
import { type BrandFontSpec, fontFaceRule, registerBrandFonts } from "./bridge/fonts";
import { setThemePalette } from "./bridge/theme";
import { mergePalette, type ResolvedBrand } from "./theme/brand";
import { paletteToRootCss } from "./theme/projections";

/** The product name when no brand names one. */
export const DEFAULT_BRAND_NAME = "NimbleBrain";

/** localStorage key holding the last brand the server answered with. */
export const BRAND_CACHE_KEY = "nb_brand";

const STYLE_ID = "nb-brand";

/** How long the first render waits for an uncached brand. */
export const FIRST_PAINT_WAIT_MS = 1500;

/** How long the fetch itself may run before it is abandoned. */
const FETCH_TIMEOUT_MS = 10_000;

const BRAND_URL = `${import.meta.env?.VITE_API_BASE ?? ""}/v1/brand`;

let current: ResolvedBrand = {};
let currentJson = "{}";
const listeners = new Set<() => void>();

/** The applied brand. `{}` is canonical. */
export function getBrand(): ResolvedBrand {
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The applied brand, re-rendering when it changes. */
export function useBrand(): ResolvedBrand {
  return useSyncExternalStore(subscribe, getBrand, getBrand);
}

/** The product name a person reads. */
export function useBrandName(): string {
  return useBrand().name ?? DEFAULT_BRAND_NAME;
}

export interface BootBrandOptions {
  fetch?: typeof fetch;
  firstPaintWaitMs?: number;
}

/**
 * Apply the cached brand, fetch the current one, and resolve once the first
 * render may proceed. Never rejects.
 */
export function bootBrand(options: BootBrandOptions = {}): Promise<void> {
  const cached = readCache();
  if (cached) applyBrand(cached);

  const fetched = fetchBrand(options.fetch ?? fetch).then((fresh) => {
    if (fresh === undefined) return;
    applyBrand(fresh);
    writeCache(fresh);
  });

  if (cached) return Promise.resolve();
  const wait = options.firstPaintWaitMs ?? FIRST_PAINT_WAIT_MS;
  return Promise.race([fetched, new Promise<void>((resolve) => setTimeout(resolve, wait))]);
}

/**
 * Paint `brand`, or canonical if it cannot be painted. `{}` restores canonical.
 * Re-applying the brand already applied is a no-op.
 */
export function applyBrand(brand: ResolvedBrand): void {
  const json = JSON.stringify(brand);
  if (json === currentJson) return;
  try {
    paint(brand);
    current = brand;
    currentJson = json;
  } catch (err) {
    console.warn("[brand] could not apply the brand; using the default", err);
    paint({});
    current = {};
    currentJson = "{}";
  }
  for (const listener of listeners) listener();
}

function paint(brand: ResolvedBrand): void {
  const palette = mergePalette(brand);
  const faces = brandFaces(brand);
  const overrides = brand.colors || brand.fonts || brand.radius;

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

/** Every face the brand declares, one per distinct family, URL and weight. */
function brandFaces(brand: ResolvedBrand): BrandFontSpec[] {
  const out = new Map<string, BrandFontSpec>();
  for (const font of Object.values(brand.fonts ?? {})) {
    if (!font?.family) continue;
    for (const face of font.faces ?? []) {
      const spec: BrandFontSpec = {
        family: font.family,
        url: face.url,
        ...(face.weight ? { weight: face.weight } : {}),
      };
      out.set(`${spec.family}\n${spec.url}\n${spec.weight ?? ""}`, spec);
    }
  }
  return [...out.values()];
}

// ── Title and favicon ───────────────────────────────────────────────────────

function setTitle(name: string | undefined): void {
  document.title = name ?? DEFAULT_BRAND_NAME;
}

/** Where a favicon link keeps the attributes index.html gave it. */
const CANONICAL_ICON_ATTR = "data-nb-canonical";
const ICON_ATTRS = ["href", "type", "sizes"] as const;

/**
 * Point every favicon link at the brand's image, or back at what index.html
 * shipped. Each link records its own canonical attributes the first time it is
 * touched, so unbranding restores exactly those.
 */
function setFavicon(url: string | undefined): void {
  for (const el of document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')) {
    if (!el.hasAttribute(CANONICAL_ICON_ATTR)) {
      const canonical = Object.fromEntries(ICON_ATTRS.map((a) => [a, el.getAttribute(a)]));
      el.setAttribute(CANONICAL_ICON_ATTR, JSON.stringify(canonical));
    }
    if (url) {
      // One brand image replaces every size; the canonical type and sizes
      // describe the canonical files, not it.
      el.setAttribute("href", url);
      el.removeAttribute("type");
      el.removeAttribute("sizes");
      continue;
    }
    const canonical = JSON.parse(el.getAttribute(CANONICAL_ICON_ATTR) ?? "{}") as Record<
      string,
      string | null
    >;
    for (const attr of ICON_ATTRS) {
      const value = canonical[attr];
      if (value == null) el.removeAttribute(attr);
      else el.setAttribute(attr, value);
    }
  }
}

// ── Fetch and cache ─────────────────────────────────────────────────────────

/** The server's brand, or `undefined` when there is no answer to act on. */
async function fetchBrand(fetchImpl: typeof fetch): Promise<ResolvedBrand | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(BRAND_URL, { signal: controller.signal });
    if (!res.ok) return undefined;
    const body: unknown = await res.json();
    return isBrand(body) ? body : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function isBrand(value: unknown): value is ResolvedBrand {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readCache(): ResolvedBrand | undefined {
  try {
    const raw = localStorage.getItem(BRAND_CACHE_KEY);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    return isBrand(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writeCache(brand: ResolvedBrand): void {
  try {
    if (Object.keys(brand).length === 0) localStorage.removeItem(BRAND_CACHE_KEY);
    else localStorage.setItem(BRAND_CACHE_KEY, JSON.stringify(brand));
  } catch {
    // Storage unavailable (private mode, quota): the next load fetches again.
  }
}
