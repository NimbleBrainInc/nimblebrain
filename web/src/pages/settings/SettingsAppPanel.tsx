import { useParams } from "react-router-dom";
import { SlotRenderer } from "../../components/SlotRenderer";
import { useShellContext } from "../../context/ShellContext";

/**
 * Renders an app's settings panel from the "settings" slot.
 * Route: /settings/apps/:serverName
 */
export function SettingsAppPanel() {
  const { serverName } = useParams<{ serverName: string }>();
  const shell = useShellContext();

  if (!shell || !serverName) {
    return <div className="text-muted-foreground text-sm">App settings not available.</div>;
  }

  const panels = shell.forSlot("settings");
  const panel = panels.find((p) => p.serverName === serverName);

  if (!panel) {
    return (
      <div className="text-muted-foreground text-sm">
        No settings panel found for <strong>{serverName}</strong>.
      </div>
    );
  }

  return <SlotRenderer placements={[panel]} className="h-full" />;
}
