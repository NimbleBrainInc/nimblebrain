import { Navigate, useParams } from "react-router-dom";
import { SlotRenderer } from "../../components/SlotRenderer";
import { useShellContext } from "../../context/ShellContext";
import { RequireActiveWorkspace, SettingsAppPanelPage } from "./components";

/**
 * Renders an app's settings panel from the "settings" slot, wrapped in
 * `SettingsAppPanelPage` so it inherits page chrome (back-link, title,
 * "provided by" footer) consistent with sibling settings tabs.
 *
 * Route: /w/:slug/settings/apps/:serverName
 *
 * Workspace-switch behavior: if the workspace named by the slug doesn't
 * have the bundle installed (e.g. user navigated to another workspace
 * while on this page), redirect to the apps index instead of rendering a
 * "not found" dead-end. This is the locked decision from the IA plan.
 */
export function SettingsAppPanel() {
  return (
    <RequireActiveWorkspace>
      <Inner />
    </RequireActiveWorkspace>
  );
}

function Inner() {
  const { serverName, slug } = useParams<{ serverName: string; slug: string }>();
  const shell = useShellContext();

  if (!shell || !serverName) {
    return <p className="text-sm text-muted-foreground">App settings not available.</p>;
  }

  const panels = shell.forSlot("settings");
  const panel = panels.find((p) => p.serverName === serverName);

  if (!panel) {
    // Bundle not installed in this workspace — redirect to index per IA contract.
    return <Navigate to={`/w/${slug}/settings/apps`} replace />;
  }

  return (
    <SettingsAppPanelPage panel={panel}>
      <SlotRenderer placements={[panel]} className="h-full" />
    </SettingsAppPanelPage>
  );
}
