import { useCallback, useEffect, useState } from "react";
import { listPersonalConnectors, type PersonalConnector } from "../../api/client";
import { EmptyState, SettingsPageHeader } from "./components";

/**
 * Profile → Connectors — `/profile/connectors`.
 *
 * A personal connector is a remote MCP connection (Gmail, Outlook, Granola, …)
 * the user connects at the IDENTITY level — it follows them across workspaces
 * and is owned by no single workspace (the runtime resolves it from the user's
 * personal workspace; the UI just presents it, like `ProfileSkillsTab`). This
 * tab lists the connectors the user has connected and, for each, how many
 * workspaces it's granted into. Connecting a new one and toggling grants land
 * in follow-up slices.
 */
export function ProfileConnectorsTab() {
  const [connectors, setConnectors] = useState<PersonalConnector[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Workspace-independent: the server derives the personal workspace from
      // the caller, so no active-workspace header is needed here on `/profile`.
      const result = await listPersonalConnectors();
      setConnectors(result.connectors);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <SettingsPageHeader
        title="Connectors"
        description="Your personal connections — remote MCP services like Gmail. Grant one to a workspace to let your agent use it there."
      />
      {loading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : error ? (
        <EmptyState message={`Unable to load connectors: ${error}. Reload to retry.`} />
      ) : connectors.length === 0 ? (
        <EmptyState message="You haven't connected any connectors yet." />
      ) : (
        <div className="border-t border-border">
          {connectors.map((c) => (
            <PersonalConnectorRow key={c.serverName} connector={c} />
          ))}
        </div>
      )}
    </div>
  );
}

function PersonalConnectorRow({ connector }: { connector: PersonalConnector }) {
  const grants = connector.grantedWorkspaces.length;
  const grantLabel =
    grants === 0 ? "Not granted" : `Granted to ${grants} workspace${grants === 1 ? "" : "s"}`;
  const ready = connector.state === "running";
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border py-3">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">
          {connector.displayName || connector.serverName}
        </div>
        {connector.description ? (
          <div className="truncate text-xs text-muted-foreground">{connector.description}</div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <span className="text-xs text-muted-foreground">{grantLabel}</span>
        <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
          {ready ? "Ready" : connector.state}
        </span>
      </div>
    </div>
  );
}
