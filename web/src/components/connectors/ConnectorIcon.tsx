import { useState } from "react";
import { themedIconVariants } from "../../lib/icon-theme";

/**
 * Connector identity icon. Used everywhere a connector is shown:
 * Browse cards, the Configure page hero, the connectors list. When
 * the catalog entry carries a real `iconUrl` we render the image; if
 * it's missing OR the URL fails to load we fall back to a
 * deterministic letter avatar so cards never have a hole on the left
 * edge.
 *
 * Brand icons on our static CDN ship light/dark variants. Both render,
 * and the `dark:` variant picks one, as `Logo` does: which one shows
 * depends on the surface the icon sits on, not on the page's theme,
 * because a brand's dark light-mode sidebar renders under the dark
 * palette while the page is light. Any other URL (legacy PNG,
 * third-party) renders as a single image.
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
 * just provides the geometry. The icon is always one element, so a
 * parent's spacing utilities (`-space-x-*` in a stack) see one child.
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
   *  element rendered (image, variant pair, or fallback div). */
  className?: string;
}) {
  // The URLs that failed to load. Keyed by URL, so a new iconUrl starts clean,
  // and a failed variant leaves the other to serve both themes.
  const [broken, setBroken] = useState<ReadonlySet<string>>(() => new Set());
  const markBroken = (url: string) =>
    setBroken((prev) => (prev.has(url) ? prev : new Set(prev).add(url)));

  const variants = themedIconVariants(iconUrl);
  const candidates = variants ? [variants.light, variants.dark] : iconUrl ? [iconUrl] : [];
  const live = candidates.filter((url) => !broken.has(url));

  if (variants && live.length === 2) {
    return (
      <span className={`inline-flex shrink-0 overflow-hidden ${className}`}>
        <img
          src={variants.light}
          alt=""
          className="size-full dark:hidden"
          onError={() => markBroken(variants.light)}
        />
        <img
          src={variants.dark}
          alt=""
          className="hidden size-full dark:block"
          onError={() => markBroken(variants.dark)}
        />
      </span>
    );
  }
  const src = live[0];
  if (src) {
    return (
      <img src={src} alt="" className={`shrink-0 ${className}`} onError={() => markBroken(src)} />
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
  return TINTS[Math.abs(h) % TINTS.length]!;
}
