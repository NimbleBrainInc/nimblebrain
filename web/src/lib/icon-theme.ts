/**
 * Theme-aware connector icon resolution.
 *
 * Connector brand logos hosted on our static CDN ship deterministic theme
 * variants at `/logos/<slug>/{light,dark}.svg`, and the asset build guarantees
 * both files always exist (a theme-agnostic mark just mirrors light into dark).
 * So when an iconUrl is one of these, we can pick the variant matching the
 * active theme by swapping the last path segment — no extra metadata to thread
 * through the registry → projection → provider chain.
 *
 * Every other URL is returned unchanged: mpak `ServerDetail.icons[].src`,
 * legacy flat `/icons/<name>.png`, or any third-party host. Those render as-is
 * and the caller's letter-avatar fallback covers anything that fails to load.
 */
const NB_THEMED_ICON =
  /^(https:\/\/static\.nimblebrain\.ai\/logos\/[^/?#]+\/)(?:light|dark)\.svg$/;

export function themedIconUrl(
  url: string | undefined,
  mode: "light" | "dark",
): string | undefined {
  if (!url) return url;
  const m = NB_THEMED_ICON.exec(url);
  if (!m) return url;
  return `${m[1]}${mode}.svg`;
}
