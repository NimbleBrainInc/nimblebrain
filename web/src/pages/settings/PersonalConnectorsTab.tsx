import { Link } from "react-router-dom";
import { ConnectorList } from "../../components/connectors/ConnectorList";
import { SettingsPageHeader } from "./components";

/**
 * Personal connectors tab — services tied to the signed-in user's
 * account. Tokens stored under `users/<userId>/credentials/...`,
 * available across every workspace the user is a member of.
 */
export function PersonalConnectorsTab() {
  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <SettingsPageHeader
        title="Personal connectors"
        description="Services tied to your account. Available everywhere you sign in."
        action={
          <Link
            to="/settings/personal/connectors/browse"
            className="text-sm px-3 py-1.5 rounded border border-border hover:bg-muted whitespace-nowrap"
          >
            Browse
          </Link>
        }
      />
      <ConnectorList scope="user" configureBasePath="/settings/personal/connectors" />
    </div>
  );
}
