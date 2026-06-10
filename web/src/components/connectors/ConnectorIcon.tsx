import { useState } from "react";
import { useThemeMode } from "../../context/ThemeContext";
import { themedIconUrl } from "../../lib/icon-theme";

/**
 * Connector identity icon. Used everywhere a connector is shown:
 * Browse cards, the Configure page hero, the connectors list. When
 * the catalog entry carries a real `iconUrl` we render the image; if
 * it's missing OR the URL fails to load we fall back to a
 * deterministic letter avatar so cards never have a hole on the left
 * edge.
 *
 * Brand icons on our static CDN ship light/dark variants; we swap to
 * the one matching the active theme via `themedIconUrl`. Any other URL
 * (mpak, legacy PNG, third-party) renders unchanged.
 *
 * The fallback's background tint is hashed from the connector's
 * display name. Same connector → same color across reloads. The
 * palette is intentionally low-saturation (15% alpha) so the icon
 * reads as "branding placeholder," not "loud accent."
 *
 * Default size is 36px (h-9 w-9) to match the Browse card. Pass a
 * className override to upsize for the page header (h-12 w-12) or
 * downsize for a denser list. Sizes scale the rounded radius and
 * the letter weight in the className override; the component itself
 * just provides the geometry.
 */
export function ConnectorIcon({
  name,
  iconUrl,
  className = "h-9 w-9 rounded text-sm",
}: {
  name: string;
  iconUrl?: string;
  /** Tailwind classes for size + rounded radius + letter typography.
   *  The `h-* w-*` and `text-*` classes both flow through to the
   *  appropriate primitive (img or fallback div). */
  className?: string;
}) {
  const mode = useThemeMode();
  const src = themedIconUrl(iconUrl, mode);
  // Track the broken URL, not a boolean: when the theme flips we render a
  // different variant (…/dark.svg), so a prior light-variant failure must not
  // suppress the retry. Only fall back to the avatar once the *current* src
  // has actually failed.
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null);
  const showImage = !!src && brokenSrc !== src;
  if (showImage) {
    return (
      <img src={src} alt="" className={`shrink-0 ${className}`} onError={() => setBrokenSrc(src)} />
    );
  }
  const letter = (name.trim().charAt(0) || "?").toUpperCase();
  const tint = pickTint(name);
  return (
    <div
      className={`shrink-0 flex items-center justify-center font-semibold ${tint} ${className}`}
      aria-hidden
    >
      {letter}
    </div>
  );
}

const TINTS = [
  "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  "bg-rose-500/15 text-rose-600 dark:text-rose-400",
  "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400",
  "bg-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-400",
  "bg-orange-500/15 text-orange-600 dark:text-orange-400",
];

/** Stable hash → tint index. Deterministic so reloads don't shuffle. */
function pickTint(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  // biome-ignore lint/style/noNonNullAssertion: TINTS is a non-empty literal
  return TINTS[Math.abs(h) % TINTS.length]!;
}
