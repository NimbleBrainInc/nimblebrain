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
   * Rendered height in pixels; width follows the artwork's aspect ratio.
   * Brand minimums: the full logo at 180px wide (height ≥ 36), the icon at 32px.
   */
  height?: number;
  className?: string;
}

const SOURCES = {
  full: { light: fullLight, dark: fullDark },
  icon: { light: iconLight, dark: iconDark },
  wordmark: { light: wordmarkBlack, dark: wordmarkWhite },
} as const;

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
export function Logo({ variant = "full", height = 36, className = "" }: LogoProps) {
  const brand = useBrand();
  const alt = brand.name ?? DEFAULT_BRAND_NAME;
  const { light, dark } = brandSources(brand, variant) ?? SOURCES[variant];
  return (
    <span className={`inline-flex items-center shrink-0 ${className}`}>
      {light === dark ? (
        <img src={light} alt={alt} style={{ height }} className="w-auto" />
      ) : (
        <>
          <img src={light} alt={alt} style={{ height }} className="w-auto dark:hidden" />
          <img src={dark} alt={alt} style={{ height }} className="w-auto hidden dark:block" />
        </>
      )}
    </span>
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
