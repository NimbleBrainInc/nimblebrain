import fullDark from "../assets/nb-logo-full-dark.svg";
import fullLight from "../assets/nb-logo-full-light.svg";
import iconDark from "../assets/nb-logo-icon-dark.svg";
import iconLight from "../assets/nb-logo-icon-light.svg";
import wordmarkBlack from "../assets/nb-wordmark-black.svg";
import wordmarkWhite from "../assets/nb-wordmark-white.svg";

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
 * NimbleBrain logo, from the brand kit's generated artwork. The lockup is
 * artwork, not type: never rebuild it from the icon plus a text node, because
 * the spacing is part of the mark.
 *
 * Both colour variants render and the `.dark` class picks one, so the logo
 * follows the theme toggle rather than the OS preference.
 */
export function Logo({ variant = "full", height = 36, className = "" }: LogoProps) {
  const { light, dark } = SOURCES[variant];
  return (
    <span className={`inline-flex items-center shrink-0 ${className}`}>
      <img src={light} alt="NimbleBrain" style={{ height }} className="w-auto dark:hidden" />
      <img src={dark} alt="NimbleBrain" style={{ height }} className="w-auto hidden dark:block" />
    </span>
  );
}
