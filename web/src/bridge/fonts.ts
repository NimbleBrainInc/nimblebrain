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
 * Three constraints shape what's here:
 *
 *  1. **Family names must match the token values**, not the upstream package's.
 *     Fontsource ships these as `'Hanken Grotesk Variable'` / `'JetBrains Mono
 *     Variable'`; `palette.ts` names `'Hanken Grotesk'` and `'JetBrains Mono
 *     Variable'`. A descriptor's family is whatever we declare, so we declare
 *     the token's name and point it at the file. `fonts.test.ts` pins the pair
 *     together so a palette rename can't silently orphan the face.
 *
 *  2. **The URL must satisfy the iframe's CSP**, and `'self'` does not help
 *     there: the frame is `srcdoc` without `allow-same-origin`, so it runs in
 *     an opaque origin where `'self'` matches nothing. These are absolute
 *     same-origin URLs, and `buildCSP` adds that origin to `font-src`.
 *
 *  3. **Latin subset only.** Fontsource splits by unicode range, but the
 *     ext-apps font descriptor has no `unicodeRange` field, so a face here
 *     claims every codepoint. Shipping just `latin` means a glyph the font
 *     lacks falls through to the next family in the stack — correct behaviour,
 *     and the reason every `--font-*` token keeps a web-safe tail.
 */

// `?url` yields the hashed, content-addressed asset path Vite emits, so the
// bytes are immutably cacheable and shared across every iframe on the page.
import hankenLatin from "@fontsource-variable/hanken-grotesk/files/hanken-grotesk-latin-wght-normal.woff2?url";
import jetbrainsLatin from "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?url";

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
 * The host's own origin, or `""` where there isn't a usable one.
 *
 * Derived rather than configured so dev, preview and prod agree without a knob.
 * A document can report an origin that is not a URL — `"null"` for an opaque
 * origin, `""` in some test DOMs — so this validates rather than trusting it,
 * and every caller must handle the empty case.
 */
export function fontOrigin(): string {
  if (typeof window === "undefined") return "";
  const origin = window.location?.origin ?? "";
  if (!origin || origin === "null") return "";
  try {
    const parsed = new URL(origin);
    // `about:blank` parses but its `.origin` is the literal string "null", and
    // a non-http scheme is not something `font-src` can act on. Only an http(s)
    // origin is usable, so anything else is treated as "no origin".
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.origin;
  } catch {
    return "";
  }
}

/**
 * Absolute same-origin URL for a Vite asset path.
 *
 * `'self'` is meaningless in an opaque-origin frame, so the app has to be given
 * a resolvable absolute URL. Total by construction: this runs inside
 * `buildHostExtensions`, which runs during a placement render, so throwing here
 * would take down the whole app mount over typography. Falls back to the raw
 * path, which at worst yields a face the app can't fetch — the same outcome as
 * sending no fonts at all.
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
 * Descriptors for the two families the iframe token set names.
 *
 * Both are variable fonts covering `100 900`, so one file serves every weight
 * the type scale uses. `display: swap` paints text in the fallback immediately
 * rather than blocking on the download.
 */
export function getHostFontFaces(): HostFontFace[] {
  return [
    {
      family: "Hanken Grotesk",
      src: `url('${absolute(hankenLatin)}') format('woff2-variations')`,
      weight: "100 900",
      style: "normal",
      display: "swap",
    },
    {
      family: "JetBrains Mono Variable",
      src: `url('${absolute(jetbrainsLatin)}') format('woff2-variations')`,
      weight: "100 800",
      style: "normal",
      display: "swap",
    },
  ];
}
