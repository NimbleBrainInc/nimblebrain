import { Navigate, useParams } from "react-router-dom";
import { SlotRenderer } from "../../components/SlotRenderer";
import { useShellContext } from "../../context/ShellContext";
import { RequireActiveWorkspace } from "./components/RequireActiveWorkspace";

/**
 * Renders an app's settings panel from the "settings" slot.
 *
 * Route: /settings/workspace/apps/:serverName
 *
 * Workspace-switch behavior: if the active workspace doesn't have the
 * named bundle installed (e.g. user switched workspaces while on this
 * page), redirect to the apps index instead of rendering a "not found"
 * dead-end. This is the locked decision from the IA plan.
 */
export function SettingsAppPanel() {
  return (
    <RequireActiveWorkspace>
      <Inner />
    </RequireActiveWorkspace>
  );
}

function Inner() {
  const { serverName } = useParams<{ serverName: string }>();
  const shell = useShellContext();

  if (!shell || !serverName) {
    return <div className="text-muted-foreground text-sm">App settings not available.</div>;
  }

  const panels = shell.forSlot("settings");
  const panel = panels.find((p) => p.serverName === serverName);

  if (!panel) {
    // Bundle not installed in active workspace — redirect to index per IA contract.
    return <Navigate to="/settings/workspace/apps" replace />;
  }

  return <SlotRenderer placements={[panel]} className="h-full" />;
}
