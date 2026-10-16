// ---------------------------------------------------------------------------
// AppSettingsLink — the top bar's gear, a way from an app straight to its
// connector's settings page.
//
// Drawn only on an app route (`/w/<slug>/app/<route>`) whose connector declares
// a `settings` placement, the same test `ConnectorSettingsSection` applies to
// render that page's last section. A connector with nothing of its own to set
// has a settings page too, but the gear would open a page with nothing the app
// put there. Nothing while the shell still holds another workspace's
// placements mid-switch, since the route's app would be looked up in the wrong
// set. An identity app has no workspace settings page, so `connectorSettingsPath`
// answers null and nothing is drawn.
// ---------------------------------------------------------------------------

import { Settings } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { useShellContext } from "../../context/ShellContext";
import { useWorkspaceContext } from "../../context/WorkspaceContext";
import { connectorSettingsPath } from "../../lib/workspace-apps";
import { Tooltip } from "../ui/tooltip";

export function AppSettingsLink() {
  const { pathname } = useLocation();
  const shell = useShellContext();
  const { activeWorkspace } = useWorkspaceContext();

  const [first, slug, view, route] = pathname.split("/").filter(Boolean);
  if (first !== "w" || view !== "app" || !route) return null;
  if (!shell || shell.shellWorkspaceId !== activeWorkspace?.id) return null;

  const app = shell.forSlot("sidebar").find((p) => p.route === route);
  if (!app) return null;
  // `forSlot` also returns `settings.<x>` slots; only the exact slot is a settings section.
  const hasSettings = shell
    .forSlot("settings")
    .some((p) => p.slot === "settings" && p.serverName === app.serverName);
  const to = hasSettings ? connectorSettingsPath(slug, app.serverName) : null;
  if (!to) return null;

  const label = `${app.label ?? app.route ?? app.serverName} settings`;
  return (
    <Tooltip label={label}>
      <Link
        to={to}
        aria-label={label}
        data-testid="top-bar-app-settings"
        className="flex size-8 shrink-0 items-center justify-center rounded-md text-foreground transition-colors hover:bg-foreground/10"
      >
        <Settings aria-hidden="true" className="size-[18px]" />
      </Link>
    </Tooltip>
  );
}
