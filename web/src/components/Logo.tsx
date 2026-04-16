import iconSquare from "../assets/nimblebrain-icon-color-square.png";

interface LogoProps {
  /** "icon" = square logo mark only. "wordmark" = text only. "full" = icon + text. */
  variant?: "icon" | "wordmark" | "full";
  /** Height in pixels for the icon. Text sizes proportionally. */
  height?: number;
  className?: string;
}

/**
 * NimbleBrain logo component.
 *
 * - "icon": square logo mark only
 * - "wordmark": "NimbleBrain" in the heading font (Erode)
 * - "full": square icon + text wordmark (the standard lockup)
 */
export function Logo({ variant = "full", height = 24, className = "" }: LogoProps) {
  if (variant === "icon") {
    return (
      <span className={`inline-flex items-center shrink-0 ${className}`}>
        <img
          src={iconSquare}
          alt="NimbleBrain"
          style={{ height, width: height }}
          className="rounded-sm"
        />
      </span>
    );
  }

  if (variant === "wordmark") {
    return (
      <span
        className={`inline-flex items-center shrink-0 font-heading font-semibold tracking-tight text-foreground ${className}`}
        style={{ fontSize: height * 0.75 }}
      >
        NimbleBrain
      </span>
    );
  }

  // full: square icon + text wordmark
  return (
    <span className={`inline-flex items-center gap-2 shrink-0 ${className}`}>
      <img
        src={iconSquare}
        alt=""
        aria-hidden="true"
        style={{ height, width: height }}
        className="rounded-sm"
      />
      <span
        className="font-heading font-semibold tracking-tight text-foreground"
        style={{ fontSize: height * 0.75 }}
      >
        NimbleBrain
      </span>
    </span>
  );
}
