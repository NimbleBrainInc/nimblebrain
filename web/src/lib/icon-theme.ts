/**
 * Theme-aware connector icon resolution.
 *
 * Connector brand logos hosted on our static CDN ship deterministic theme
 * variants at `/logos/<slug>/{light,dark}.svg`, and the asset build guarantees
 * both files always exist (a theme-agnostic mark just mirrors light into dark).
 * So when an iconUrl is one of these, both variants are known from the URL
 * alone, with no extra metadata to thread through the registry → projection →
 * provider chain.
 *
 * Every other URL has no variants: registry `ServerDetail.icons[].src`, legacy
 * flat `/icons/<name>.png`, or any third-party host. Those render as-is and the
 * caller's letter-avatar fallback covers anything that fails to load.
 *
 * The variants are returned as a pair, never chosen here, because which one
 * shows depends on the surface the icon sits on, not on the page's theme: a
 * brand's dark light-mode sidebar renders under the dark palette. The caller
 * renders both and lets the `dark:` variant pick, as `Logo` does.
 */
const NB_THEMED_ICON = /^(https:\/\/static\.nimblebrain\.ai\/logos\/[^/?#]+\/)(?:light|dark)\.svg$/;

export interface IconVariants {
  light: string;
  dark: string;
}

export function themedIconVariants(url: string | undefined): IconVariants | undefined {
  if (!url) return undefined;
  const m = NB_THEMED_ICON.exec(url);
  if (!m) return undefined;
  return { light: `${m[1]}light.svg`, dark: `${m[1]}dark.svg` };
}
