import { useState } from "react";
import fullDark from "../assets/nb-logo-full-dark.svg";
import fullLight from "../assets/nb-logo-full-light.svg";
import iconDark from "../assets/nb-logo-icon-dark.svg";
import iconLight from "../assets/nb-logo-icon-light.svg";
import wordmarkBlack from "../assets/nb-wordmark-black.svg";
import wordmarkWhite from "../assets/nb-wordmark-white.svg";
import { DEFAULT_BRAND_NAME, useBrand } from "../brand";
import type { ResolvedBrand } from "../theme/brand";

interface LogoProps {
  /** "icon" = logo mark only. "wordmark" = name only. "full" = icon + name. */
  variant?: "icon" | "wordmark" | "full";
  /**
   * Rendered height of NimbleBrain's artwork in pixels; width follows its
   * aspect ratio. Brand minimums: the full logo at 180px wide (height ≥ 36),
   * the icon at 32px. A tenant's artwork renders at the same area
   * ({@link opticalSize}).
   */
  height?: number;
  /** The tallest a tenant's artwork may render, the height of the slot it sits in. Defaults to `height` × {@link MAX_GROWTH}. */
  maxHeight?: number;
  /** The widest a tenant's artwork may render, the width of the slot it sits in. Defaults to the bundled width × {@link MAX_WIDEN}. */
  maxWidth?: number;
  className?: string;
}

const SOURCES = {
  full: { light: fullLight, dark: fullDark },
  icon: { light: iconLight, dark: iconDark },
  wordmark: { light: wordmarkBlack, dark: wordmarkWhite },
} as const;

/** Width ÷ height of the bundled artwork, the reference a tenant's artwork is sized against. */
const ASPECT = {
  full: 6735 / 1336,
  icon: 1576 / 1336,
  wordmark: 4945 / 637,
} as const;

/** How much taller than `height` a tenant's artwork may grow, absent a `maxHeight`. */
export const MAX_GROWTH = 1.75;
/** How much wider than the bundled artwork a tenant's artwork may grow, absent a `maxWidth`. */
export const MAX_WIDEN = 1.25;

/**
 * The height a tenant's artwork renders at: the area the bundled artwork covers
 * at `height`, so marks of any shape carry the same visual weight. A height-only
 * rule shrinks a compact lockup to a fraction of a wide wordmark's size. The
 * result stays within `maxHeight` and `maxWidth`, the bounds of the slot the
 * logo sits in.
 */
export function opticalSize(
  height: number,
  referenceAspect: number,
  aspect: number,
  maxHeight = height * MAX_GROWTH,
  maxWidth = height * referenceAspect * MAX_WIDEN,
): number {
  const area = height * height * referenceAspect;
  return Math.min(Math.sqrt(area / aspect), maxHeight, maxWidth / aspect);
}

/**
 * The brand's logo: the tenant's artwork when the brand supplies it, otherwise
 * NimbleBrain's, from the brand kit's generated artwork. The lockup is artwork,
 * not type: never rebuild it from the icon plus a text node, because the
 * spacing is part of the mark.
 *
 * Two colour variants render and the `.dark` class picks one, so the logo
 * follows the theme toggle rather than the OS preference. A brand that supplies
 * one variant uses it in both modes; a single mark serves both modes.
 */
export function Logo({
  variant = "full",
  height = 36,
  maxHeight,
  maxWidth,
  className = "",
}: LogoProps) {
  const brand = useBrand();
  const alt = brand.name ?? DEFAULT_BRAND_NAME;
  const branded = brandSources(brand, variant);
  const { light, dark } = branded ?? SOURCES[variant];
  const Img = branded ? BrandImage : FixedImage;
  const size = { height, maxHeight, maxWidth, referenceAspect: ASPECT[variant] };
  return (
    <span className={`inline-flex items-center shrink-0 ${className}`}>
      {light === dark ? (
        <Img src={light} alt={alt} {...size} className="w-auto" />
      ) : (
        <>
          <Img src={light} alt={alt} {...size} className="w-auto dark:hidden" />
          <Img src={dark} alt={alt} {...size} className="w-auto hidden dark:block" />
        </>
      )}
    </span>
  );
}

interface ImageProps {
  src: string;
  alt: string;
  height: number;
  maxHeight?: number;
  maxWidth?: number;
  referenceAspect: number;
  className: string;
}

/** Bundled artwork: its aspect is the reference, so it renders at `height`. */
function FixedImage({ src, alt, height, className }: ImageProps) {
  return <img src={src} alt={alt} style={{ height }} className={className} />;
}

/**
 * A tenant's artwork, sized by {@link opticalSize} once it loads and its aspect
 * is known. Hidden until then, so it never paints at one size and jumps to another;
 * one that fails to load shows at `height`, so its alt text does.
 */
function BrandImage({
  src,
  alt,
  height,
  maxHeight,
  maxWidth,
  referenceAspect,
  className,
}: ImageProps) {
  const [rendered, setRendered] = useState<number>();
  return (
    <img
      src={src}
      alt={alt}
      style={{ height: rendered ?? height, visibility: rendered ? undefined : "hidden" }}
      className={className}
      onLoad={(e) => {
        const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
        setRendered(
          w && h ? opticalSize(height, referenceAspect, w / h, maxHeight, maxWidth) : height,
        );
      }}
      onError={() => setRendered(height)}
    />
  );
}

/**
 * The brand's artwork for a variant, or `undefined` to fall back to the bundled
 * files. The brand has a full logo and a mark; the name-only wordmark variant
 * uses the full logo, the nearest artwork a brand supplies.
 */
function brandSources(
  brand: ResolvedBrand,
  variant: NonNullable<LogoProps["variant"]>,
): { light: string; dark: string } | undefined {
  const logo = brand.logo;
  if (variant === "icon") return logo?.mark ? { light: logo.mark, dark: logo.mark } : undefined;
  const light = logo?.light ?? logo?.dark;
  const dark = logo?.dark ?? logo?.light;
  return light && dark ? { light, dark } : undefined;
}
