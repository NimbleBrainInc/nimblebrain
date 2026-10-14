/**
 * Font faces the host serves to embedded app iframes.
 *
 * A CSS custom property can *name* a font family but cannot load one, and an
 * app iframe is its own document — it inherits no `@font-face` from the shell.
 * So injecting `--font-sans: 'Hanken Grotesk', …` names a typeface the app has
 * no way to render, and it silently falls through to `system-ui`.
 *
 * This module closes that half: the `@font-face` rules ride the host context as
 * the spec's `styles.css.fonts`, and the app's SDK injects them into its own
 * document. Apps import nothing; typography arrives with the rest of the theme.
 *
 * The faces are *declared*, not force-loaded, so a browser fetches the bytes
 * only if the app's own CSS actually matches the family. An app that never
 * references `var(--font-sans)` pays nothing, which is the opt-out: use of the
 * token, not an import.
 *
 * The CSS is read once, at the handshake. A typeface swap mid-session does not
 * reach an app already running — which is why this is built from constants and
 * a hashed asset URL rather than from anything a person can change while the
 * page is open.
 *
 * **Why the URLs are injected rather than imported here.** This module is
 * reachable from the shared bridge protocol, which the ROOT unit suite
 * exercises without `web/` dependencies installed. Importing the font packages
 * here would put a web-only value in that graph and break `Unit Tests (root
 * deps only)` — the same seam `sentry.ts` documents. The specs below (family,
 * weight) are plain data and stay here where the palette guard can check them;
 * the browser entry supplies the hashed asset URLs via
 * {@link registerHostFontUrls}. Unregistered, this yields no faces, which is
 * the supported "host sends no fonts" configuration rather than an error.
 *
 * Two further constraints shape what's here:
 *
 *  - **Family names must match the token values**, not the upstream package's.
 *    Fontsource ships these as `'Hanken Grotesk Variable'` / `'JetBrains Mono
 *    Variable'`; `palette.ts` names `'Hanken Grotesk'` and `'JetBrains Mono
 *    Variable'`. A descriptor's family is whatever we declare, so we declare the
 *    token's name and point it at the file. `fonts.test.ts` pins the pair so a
 *    palette rename can't silently orphan a face.
 *  - **Latin subset only.** Fontsource splits by unicode range, but the ext-apps
 *    font descriptor has no `unicodeRange` field, so a face here claims every
 *    codepoint. Shipping just `latin` means a glyph the font lacks falls through
 *    to the next family in the stack — correct behaviour, and the reason every
 *    `--font-*` token keeps a web-safe tail.
 *  - **`format('woff2')`, not `format('woff2-variations')`.** The keyword states
 *    the container format; variability comes from the file's `fvar` table and the
 *    `weight` range on the descriptor, not from the keyword. `woff2-variations` is
 *    a dropped CSS Fonts 4 draft spelling — both load identically today (verified
 *    in Chrome 148 and Firefox 153, same live weight axis), but an unrecognised
 *    keyword makes the whole `src` unparseable, and the SDK wraps `new FontFace`
 *    in `try/catch`, so the cost of being wrong here is a silently missing
 *    typeface. The current spelling has no such exposure.
 *
 * **A tenant brand's faces ride the same channel.** The brand's font URLs are
 * absolute woff2 URLs on a server the brand names, handed over by the browser
 * entry through {@link registerBrandFonts} once the brand is applied. They join
 * the host's own faces in {@link getHostFontFaceCss}, and their origins join
 * the iframe's `font-src` through {@link brandFontOrigins}. The server hosting
 * them must answer with `Access-Control-Allow-Origin: *`: the app frame's origin
 * is opaque, so no narrower value matches it.
 */

/**
 * The families the iframe token set names, and the weight range each variable
 * file covers. Data only — no asset imports — so the root unit suite can check
 * these against the palette without `web/` dependencies installed.
 */
export const FONT_SPECS = [
  { family: "Hanken Grotesk", weight: "100 900" },
  { family: "JetBrains Mono Variable", weight: "100 800" },
] as const satisfies readonly { family: string; weight: string }[];

/** family → hashed asset URL, supplied by the browser entry. */
let fontUrls: Readonly<Record<string, string>> = {};

/**
 * Register the built asset URL for each family. Called once from the browser
 * entry (`main.tsx`), which is the only place the font packages are imported as
 * values. Backend and root-unit importers never call this and get no faces.
 */
export function registerHostFontUrls(urls: Readonly<Record<string, string>>): void {
  fontUrls = urls;
}

/** One `@font-face` a brand declares: family, absolute woff2 URL, optional weight. */
export interface BrandFontSpec {
  family: string;
  url: string;
  weight?: string;
}

let brandFaces: readonly BrandFontSpec[] = [];

/**
 * Register a tenant brand's faces. Called by the brand boot each time a brand
 * is applied; an empty list removes them. Faces whose URL is not an absolute
 * http(s) URL are dropped here, so everything downstream can trust the list.
 */
export function registerBrandFonts(faces: readonly BrandFontSpec[]): void {
  brandFaces = faces.filter((face) => httpOrigin(face.url) !== "");
}

/**
 * The origins the registered brand faces load from, deduplicated. The iframe
 * CSP adds each one to `font-src`; a face whose origin is missing there fails
 * silently to the next family in the stack.
 */
export function brandFontOrigins(): string[] {
  return [...new Set(brandFaces.map((face) => httpOrigin(face.url)))];
}

/** The origin of an absolute http(s) URL, or `""`. */
function httpOrigin(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.origin;
  } catch {
    return "";
  }
}

/**
 * The host's own origin, or `""` where there isn't a usable one.
 *
 * Derived rather than configured so dev, preview and prod agree without a knob.
 * A document can report an origin that is not a usable URL — `"null"` for an
 * opaque origin, `""` in some test DOMs, `about:blank` whose parsed origin is
 * the literal string `"null"` — so this validates rather than trusting it, and
 * every caller must handle the empty case.
 */
export function fontOrigin(): string {
  if (typeof window === "undefined") return "";
  // A non-http scheme is not something `font-src` can act on.
  return httpOrigin(window.location?.origin ?? "");
}

/**
 * Absolute same-origin URL for a built asset path, or `""` if there isn't one.
 *
 * `'self'` is meaningless in an opaque-origin frame, so the app has to be given
 * a resolvable absolute URL — a relative `/assets/…` would resolve against the
 * frame's own opaque origin and 404. Total by construction: this runs inside
 * `buildHostExtensions`, which runs during a placement render, so throwing here
 * would take down the whole app mount over typography.
 */
function absolute(assetPath: string, origin: string): string {
  try {
    return new URL(assetPath, origin).href;
  } catch {
    return "";
  }
}

/**
 * The host's `@font-face` CSS, or `""` when there is none to send: the host's
 * own faces, then any a brand registered.
 *
 * `display: swap` paints text in the fallback immediately rather than blocking
 * on the download. A family with no registered URL is skipped, so a partial
 * registration degrades to fewer faces rather than a broken one.
 *
 * One rule covers every way this comes up short: **a face we cannot address is
 * not shipped.** No registered URL and no usable origin both land there — the
 * rule would carry a URL nothing can fetch, so the browser would attempt a
 * doomed request and the app would fall back anyway. Yielding nothing is the
 * supported "host sends no fonts" state; `styles.css` is then omitted from the
 * host context entirely rather than sent empty.
 *
 * Stated once, on purpose. An early `if (!fontOrigin()) return ""` reads as a
 * useful guard but is the same rule spelled a second way — `absolute()` already
 * fails every URL when there is no origin — and two spellings of one rule are
 * what drift apart later.
 */
export function getHostFontFaceCss(): string {
  const origin = fontOrigin();
  const rules: string[] = [];
  for (const spec of FONT_SPECS) {
    const url = fontUrls[spec.family];
    if (!url) continue;
    const href = absolute(url, origin);
    if (!href) continue;
    rules.push(fontFaceRule(spec.family, href, spec.weight));
  }
  for (const face of brandFaces) {
    rules.push(fontFaceRule(face.family, face.url, face.weight));
  }
  return rules.join("\n");
}

/**
 * One `@font-face` rule. A face with no weight omits the descriptor and so
 * covers the normal weight only. The shell's brand style block declares brand
 * faces with this same function, so shell and apps load the same rule.
 */
export function fontFaceRule(family: string, url: string, weight?: string): string {
  const weightDecl = weight ? ` font-weight: ${weight};` : "";
  return `@font-face { font-family: '${family}'; src: url('${url}') format('woff2');${weightDecl} font-style: normal; font-display: swap; }`;
}
