import type { ReactNode } from "react";
import { useWorkspaceContext } from "../../../context/WorkspaceContext";

/**
 * Hard-fail wrapper for the "This Workspace" section.
 *
 * Per the IA contract, no active workspace is an *invalid* configuration —
 * the header switcher should always have one selected. If we end up
 * rendering a workspace-scoped page without one, surface a loud error
 * rather than rendering an indeterminate UI.
 *
 * Distinct from the loading state: while `WorkspaceContext` is still
 * fetching (`loading: true`) we show a spinner placeholder. Only after
 * loading completes with `activeWorkspace === null` do we treat it as
 * an error condition.
 */
export function RequireActiveWorkspace({ children }: { children: ReactNode }) {
  const { activeWorkspace, loading } = useWorkspaceContext();

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading workspace…</p>;
  }

  if (!activeWorkspace) {
    return (
      <div className="space-y-2" role="alert">
        <h2 className="text-base font-semibold text-destructive">No active workspace</h2>
        <p className="text-sm text-muted-foreground">
          Select a workspace in the header switcher to continue. If none are listed, you don't yet
          belong to one — ask an organization admin to add you.
        </p>
      </div>
    );
  }

  return <>{children}</>;
}
