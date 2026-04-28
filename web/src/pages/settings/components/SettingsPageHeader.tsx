import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";

/**
 * Page-level header used by every settings page kind (Form / List /
 * Dashboard / AppPanel). Centralizes title typography, description
 * styling, optional back-nav, and a right-aligned action slot.
 *
 * Heading hierarchy convention for the settings tree:
 *   - Page title (this component): `h2 text-lg font-semibold tracking-tight`
 *   - Section title (`Section`):   `h3 text-sm font-semibold`
 *
 * The sidebar's "Settings" lives at h1 inside `SettingsPage`, so this is
 * intentionally h2 — both for a11y and to keep the visual hierarchy
 * consistent with the nav.
 */
export interface SettingsPageHeaderProps {
  title: string;
  description?: ReactNode;
  /** Right-aligned action — typically a primary button (Create, Save, etc). */
  action?: ReactNode;
  /** Optional back-nav rendered as an arrow button to the left of the title. */
  back?: { to: string; label?: string };
}

export function SettingsPageHeader({ title, description, action, back }: SettingsPageHeaderProps) {
  return (
    <header className="flex items-start justify-between gap-4">
      <div className="flex items-start gap-2 min-w-0">
        {back ? (
          <Link
            to={back.to}
            aria-label={back.label ?? "Back"}
            className="-ml-1 shrink-0 inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
        ) : null}
        <div className="min-w-0">
          <h2 className="text-lg font-semibold tracking-tight truncate">{title}</h2>
          {description ? (
            <p className="text-sm text-muted-foreground mt-0.5">{description}</p>
          ) : null}
        </div>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}
