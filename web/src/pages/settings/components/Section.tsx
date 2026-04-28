import type { ReactNode } from "react";
import { cn } from "../../../lib/utils";

/**
 * A page section — title + optional description + body.
 *
 * Sections are the meso layout unit between page header and form fields.
 * They are *not* cards by default — modern settings UIs (macOS, iOS,
 * GitHub) read better with airy text-and-content sections than with
 * boxes-inside-boxes. Pages with multiple sections separate them with a
 * top border; the first section renders without one.
 *
 * Title is `h3 text-sm font-semibold` — one tier below the page title.
 * `icon` renders inline with the title for sections that benefit from a
 * glyph (Members, Apps, Bundles).
 */
export interface SectionProps {
  /** Optional — sections without a title render their body only. */
  title?: string;
  description?: ReactNode;
  icon?: ReactNode;
  /** Right-aligned action — usually a primary button scoped to the section. */
  action?: ReactNode;
  /** When true, omits the top border separator (use for the first section). */
  flush?: boolean;
  children: ReactNode;
}

export function Section({ title, description, icon, action, flush, children }: SectionProps) {
  const hasHeader = title || description || icon || action;
  return (
    <section className={cn("space-y-3", !flush && "pt-6 border-t border-border/60")}>
      {hasHeader ? (
        <header className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            {title ? (
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                {icon ? <span className="shrink-0 text-muted-foreground">{icon}</span> : null}
                <span className="truncate">{title}</span>
              </h3>
            ) : null}
            {description ? (
              <p className={cn("text-sm text-muted-foreground", title && "mt-1")}>{description}</p>
            ) : null}
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </header>
      ) : null}
      <div>{children}</div>
    </section>
  );
}
