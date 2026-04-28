import type { ReactNode } from "react";
import { InlineError } from "./InlineError";
import { SettingsPageHeader, type SettingsPageHeaderProps } from "./SettingsPageHeader";

/**
 * Layout template for settings pages whose primary content is *data*
 * (Usage, About). Owns:
 *
 *   - page header (title, description)
 *   - column width (`max-w-5xl` — for stat-tile grids and breakdown tables)
 *   - an optional controls bar between header and body (period selector,
 *     filters)
 *
 * Distinct from FormPage because there's no Save flow, and distinct from
 * ListPage because the body is typically a *composition* of stat tiles +
 * charts + tables rather than a single list. The page composes its body
 * out of `Section` blocks, often with `Card`s for the stat tiles.
 */
export interface SettingsDashboardPageProps extends Omit<SettingsPageHeaderProps, "action"> {
  /** Optional toolbar between header and body (e.g. period selector). */
  controls?: ReactNode;
  loadError?: string | null;
  loading?: boolean;
  loadingMessage?: string;
  children: ReactNode;
}

export function SettingsDashboardPage({
  title,
  description,
  back,
  controls,
  loadError,
  loading,
  loadingMessage = "Loading...",
  children,
}: SettingsDashboardPageProps) {
  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <SettingsPageHeader title={title} description={description} back={back} />

      {controls ? <div>{controls}</div> : null}

      {loadError ? <InlineError message={loadError} /> : null}

      {loading ? <p className="text-sm text-muted-foreground">{loadingMessage}</p> : children}
    </div>
  );
}
