import { Link } from "react-router-dom";
import { Card, CardContent } from "../../components/ui/card";
import { useShellContext } from "../../context/ShellContext";
import { resolveIcon } from "../../lib/icons";
import { EmptyState, RequireActiveWorkspace, SettingsListPage } from "./components";

/**
 * Active-workspace "Apps" tab — index of installed bundles whose authors
 * registered a `settings` placement. Each entry deep-links to that
 * bundle's settings panel.
 *
 * Bundles that DON'T publish a settings panel don't appear here. That
 * matches the platform's bottom-up philosophy: the bundle decides if it
 * has a settings UX worth surfacing; the host doesn't synthesize one.
 */
export function WorkspaceAppsTab() {
  return (
    <RequireActiveWorkspace>
      <Inner />
    </RequireActiveWorkspace>
  );
}

function Inner() {
  const shell = useShellContext();
  const panels = shell ? shell.forSlot("settings") : [];

  return (
    <SettingsListPage
      title="Apps"
      description="Per-bundle settings for apps installed in this workspace. Apps appear here only when their author has registered a settings panel."
    >
      {panels.length === 0 ? (
        <EmptyState message="No installed bundles publish a settings panel." />
      ) : (
        <div className="grid gap-2">
          {panels.map((panel) => {
            const Icon = panel.icon ? resolveIcon(panel.icon) : null;
            return (
              <Card key={panel.serverName} className="hover:bg-muted/40 transition-colors">
                <CardContent className="py-3 px-4">
                  <Link
                    to={`/settings/workspace/apps/${panel.serverName}`}
                    className="flex items-center gap-3 text-sm font-medium"
                  >
                    {Icon && <Icon className="h-4 w-4 text-muted-foreground" />}
                    <span>{panel.label ?? panel.serverName}</span>
                    <span className="ml-auto text-xs text-muted-foreground font-mono">
                      {panel.serverName}
                    </span>
                  </Link>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </SettingsListPage>
  );
}
