import { ConnectorList } from "../../components/connectors/ConnectorList";
import { SettingsListPage } from "./components";

/**
 * Personal connectors tab — services tied to the signed-in user's
 * account. Tokens stored under `users/<userId>/credentials/...`,
 * available across every workspace the user is a member of.
 */
export function PersonalConnectorsTab() {
  return (
    <SettingsListPage
      title="Personal connectors"
      description="Services tied to your account. Available everywhere you sign in — connect once, use in any workspace."
    >
      <ConnectorList scope="user" configureBasePath="/settings/personal/connectors" />
    </SettingsListPage>
  );
}
