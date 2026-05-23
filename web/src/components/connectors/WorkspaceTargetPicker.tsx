import type { WorkspaceInfo } from "../../context/WorkspaceContext";

/**
 * Workspace target picker for the connector install dialog.
 *
 * Renders one selectable row per workspace the caller can install
 * into. Each row carries the workspace's display name, a role badge
 * (Personal / Admin), and a radio-style selection indicator. The
 * parent dialog owns the selection state — this is a controlled
 * component, no internal state.
 *
 * Filtering rule: only workspaces the caller has `userRole: "admin"`
 * in are installable. Personal workspaces are always admin-by-design
 * (Stage 1 invariant), so personal rows pass this filter
 * unconditionally. Member-only rows are HIDDEN, not shown disabled —
 * a member can't install into the workspace, and surfacing it as a
 * dead row would imply the operation is on the table.
 *
 * The picker has no opinion on which row is preselected; the dialog
 * picks based on the catalog entry's `defaultBinding` (UX hint) plus
 * the user's personal workspace id, and passes the result back via
 * `selectedWorkspaceId`. The picker simply renders.
 */
export interface WorkspaceTarget {
  id: string;
  name: string;
  isPersonal: boolean;
}

export function workspacesEligibleForInstall(workspaces: WorkspaceInfo[]): WorkspaceTarget[] {
  // Workspace install widens the workspace's tool/credential surface
  // for every member; the server enforces admin-only on the install
  // action. Mirror the gate in the UI by hiding workspaces the user
  // can't install into. This is consistent with `manage_connectors`
  // returning `permission_denied` for non-admin installers.
  return workspaces
    .filter((ws) => ws.userRole === "admin")
    .map((ws) => ({
      id: ws.id,
      name: ws.name,
      isPersonal: ws.isPersonal === true,
    }));
}

export function WorkspaceTargetPicker({
  workspaces,
  selectedWorkspaceId,
  onChange,
  disabled,
}: {
  workspaces: WorkspaceTarget[];
  selectedWorkspaceId: string | null;
  onChange: (wsId: string) => void;
  disabled?: boolean;
}) {
  if (workspaces.length === 0) {
    return (
      <div className="text-xs text-muted-foreground p-3 border border-dashed border-border rounded">
        No workspaces available — you need to be a workspace admin to install connectors.
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-1" role="radiogroup" aria-label="Install target workspace">
      {workspaces.map((ws) => {
        const selected = ws.id === selectedWorkspaceId;
        return (
          <li key={ws.id}>
            <button
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => onChange(ws.id)}
              className={[
                "w-full flex items-center gap-3 px-3 py-2 rounded border text-left transition-colors",
                selected
                  ? "border-primary bg-primary/5"
                  : "border-border bg-background hover:bg-muted/50",
                disabled ? "opacity-60 cursor-not-allowed" : "cursor-pointer",
              ].join(" ")}
              data-testid={`workspace-target-${ws.id}`}
            >
              <span
                aria-hidden
                className={[
                  "h-3.5 w-3.5 rounded-full border flex items-center justify-center shrink-0",
                  selected ? "border-primary" : "border-border",
                ].join(" ")}
              >
                {selected && <span className="h-1.5 w-1.5 rounded-full bg-primary" />}
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-sm font-medium truncate">{ws.name}</span>
              </span>
              <span
                className={[
                  "shrink-0 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border",
                  ws.isPersonal
                    ? "border-blue-500/40 text-blue-600 dark:text-blue-400"
                    : "border-border text-muted-foreground",
                ].join(" ")}
              >
                {ws.isPersonal ? "Personal" : "Shared"}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
