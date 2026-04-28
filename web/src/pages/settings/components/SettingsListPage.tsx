import { ChevronUp, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../../../components/ui/button";
import { Card, CardContent } from "../../../components/ui/card";
import { InlineError } from "./InlineError";
import { SettingsPageHeader, type SettingsPageHeaderProps } from "./SettingsPageHeader";

/**
 * Layout template for settings pages whose primary content is a *list*
 * (Users, Workspaces, Members, Apps). Owns:
 *
 *   - page header (title, description, optional back-nav)
 *   - column width (`max-w-5xl` — wide enough for tables with 4-6 cols)
 *   - the reveal-create pattern (button-in-header → form-card-below)
 *     that was duplicated in three tabs with subtly different state shapes
 *   - the load-error banner
 *
 * The list itself (`children`) is bare — table or card-list, page's
 * choice. The page is responsible for rendering its own empty state via
 * `EmptyState` when `children` would otherwise be empty.
 *
 * `create.canCreate === false` hides the create button entirely (used
 * for non-admin viewers). `create` omitted = no create flow at all
 * (used for `WorkspaceMembersTab` which is read-only by design).
 */
export interface SettingsListPageProps extends Omit<SettingsPageHeaderProps, "action"> {
  /**
   * Reveal-create config. The page owns the boolean (so it can also drive
   * other UI on the same toggle); this template owns the visual chrome.
   */
  create?: {
    /** Visible label on the create button (e.g. "Create User"). */
    label: string;
    showing: boolean;
    onToggle: () => void;
    /** The form to render when `showing` is true. */
    form: ReactNode;
    /** Role gate. When false, the create button isn't rendered. */
    canCreate?: boolean;
    /** Override the default `<Plus>` icon (e.g. `<UserPlus>` for users). */
    icon?: ReactNode;
  };
  /** Persistent banner above the body. */
  loadError?: string | null;
  children: ReactNode;
}

export function SettingsListPage({
  title,
  description,
  back,
  create,
  loadError,
  children,
}: SettingsListPageProps) {
  const showCreateButton = create && (create.canCreate ?? true);
  const action = showCreateButton ? (
    <Button variant={create.showing ? "outline" : "default"} size="sm" onClick={create.onToggle}>
      {create.showing ? (
        <>
          <ChevronUp className="mr-1 h-4 w-4" />
          Cancel
        </>
      ) : (
        <>
          {create.icon ?? <Plus className="mr-1 h-4 w-4" />}
          {create.label}
        </>
      )}
    </Button>
  ) : null;

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <SettingsPageHeader title={title} description={description} back={back} action={action} />

      {loadError ? <InlineError message={loadError} /> : null}

      {create?.showing ? (
        <Card>
          <CardContent className="py-4 space-y-4">{create.form}</CardContent>
        </Card>
      ) : null}

      {children}
    </div>
  );
}
