import { ConnectorList } from "../../components/connectors/ConnectorList";
import { RequireActiveWorkspace, SettingsListPage } from "./components";

/**
 * Workspace connectors tab — services shared across the active
 * workspace. Tokens stored under `workspaces/<wsId>/credentials/...`,
 * used by every member of the workspace.
 */
export function WorkspaceConnectorsTab() {
  return (
    <SettingsListPage
      title="Workspace connectors"
      description="Services shared with everyone in this workspace. Tokens belong to the workspace."
    >
      <RequireActiveWorkspace>
        <ConnectorList scope="workspace" configureBasePath="/settings/workspace/connectors" />
      </RequireActiveWorkspace>
    </SettingsListPage>
  );
}
