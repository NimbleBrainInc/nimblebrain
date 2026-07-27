/**
 * Font faces the host serves to embedded app iframes.
 *
 * A CSS custom property can *name* a font family but cannot load one, and an
 * app iframe is its own document — it inherits no `@font-face` from the shell.
 * So injecting `--font-sans: 'Hanken Grotesk', …` names a typeface the app has
 * no way to render, and it silently falls through to `system-ui`.
 *
 * This module closes that half: the descriptors ride the host context as the
 * `synapse/fontFaces` extension, and `@nimblebrain/synapse` (>= 0.13.0) loads
 * them into the app document via the CSS Font Loading API. Apps import nothing
 * and opt into nothing — typography arrives with the rest of the theme.
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
 */

/** One `@font-face` for an app iframe. Mirrors `FontFaceDescriptor` in
 *  `@nimblebrain/synapse`; kept structural so the bridge takes no SDK import. */
export type HostFontFace = {
  family: string;
  src: string;
  weight?: string;
  style?: string;
  display?: "auto" | "block" | "swap" | "fallback" | "optional";
};

/** Host-context key carrying the descriptors. A `synapse/` extension — the
 *  ext-apps spec has no equivalent, and hosts that omit it are unaffected. */
export const FONT_FACES_CONTEXT_KEY = "synapse/fontFaces";

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

/** Test seam — drop registered URLs so a suite can assert the unregistered path. */
export function resetHostFontUrls(): void {
  fontUrls = {};
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
  const origin = window.location?.origin ?? "";
  if (!origin || origin === "null") return "";
  try {
    const parsed = new URL(origin);
    // A non-http scheme is not something `font-src` can act on.
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.origin;
  } catch {
    return "";
  }
}

/**
 * Absolute same-origin URL for a built asset path.
 *
 * `'self'` is meaningless in an opaque-origin frame, so the app has to be given
 * a resolvable absolute URL. Total by construction: this runs inside
 * `buildHostExtensions`, which runs during a placement render, so throwing here
 * would take down the whole app mount over typography.
 */
function absolute(assetPath: string): string {
  const origin = fontOrigin();
  if (!origin) return assetPath;
  try {
    return new URL(assetPath, origin).href;
  } catch {
    return assetPath;
  }
}

/**
 * Descriptors for every family whose asset URL has been registered.
 *
 * `display: swap` paints text in the fallback immediately rather than blocking
 * on the download. A family with no registered URL is skipped, so a partial
 * registration degrades to fewer faces rather than a broken one.
 */
export function getHostFontFaces(): HostFontFace[] {
  const faces: HostFontFace[] = [];
  for (const spec of FONT_SPECS) {
    const url = fontUrls[spec.family];
    if (!url) continue;
    faces.push({
      family: spec.family,
      src: `url('${absolute(url)}') format('woff2-variations')`,
      weight: spec.weight,
      style: "normal",
      display: "swap",
    });
  }
  return faces;
}
