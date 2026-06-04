import { Link, useParams } from "react-router-dom";
import { ConnectorList } from "../../components/connectors/ConnectorList";
import { RequireActiveWorkspace, SettingsPageHeader } from "./components";

/**
 * Workspace connectors tab — services shared across the workspace named by
 * the URL slug. Tokens stored under `workspaces/<wsId>/credentials/...`,
 * used by every member of the workspace.
 */
export function WorkspaceConnectorsTab() {
  const { slug } = useParams<{ slug: string }>();
  const base = `/w/${slug}/settings/connectors`;
  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <SettingsPageHeader
        title="Workspace connectors"
        description="Services and tools available to everyone in this workspace."
        action={
          <Link
            to={`${base}/browse`}
            className="text-sm px-3 py-1.5 rounded border border-border hover:bg-muted whitespace-nowrap"
          >
            Browse
          </Link>
        }
      />
      <RequireActiveWorkspace>
        <ConnectorList configureBasePath={base} />
      </RequireActiveWorkspace>
    </div>
  );
}
