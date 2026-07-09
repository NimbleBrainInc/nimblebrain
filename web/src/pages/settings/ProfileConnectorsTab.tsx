import { useCallback, useEffect, useState } from "react";
import {
  type DirectoryEntry,
  initiateIdentityConnect,
  installPersonalConnector,
  listPersonalCatalog,
  listPersonalConnectors,
  type PersonalConnector,
} from "../../api/client";
import { Button } from "../../components/ui/button";
import { EmptyState, InlineError, Section, SettingsPageHeader } from "./components";

/**
 * Profile → Connectors — `/profile/connectors`.
 *
 * A personal connector is a remote MCP connection (Granola, Gmail, …) the user
 * connects at the IDENTITY level — it follows them across workspaces and is
 * owned by no single workspace. This tab lists the connectors the user has
 * connected (and how many workspaces each is granted into), and offers the
 * curated set of connectors available for a personal connection.
 *
 * Connecting redirects the browser through the connector's OAuth flow
 * (`installPersonalConnector` → `initiateIdentityConnect` → the vendor's
 * authorization URL); the callback lands back here. Grant management lands in a
 * follow-up slice.
 */
export function ProfileConnectorsTab() {
  const [connectors, setConnectors] = useState<PersonalConnector[]>([]);
  const [available, setAvailable] = useState<DirectoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  // A load failure blocks the page; a Connect failure is a banner above the
  // still-valid lists — two separate slots.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Keyed by the row's server name (installed) or catalog id (available) so
  // exactly the clicked row shows its in-flight state; a successful Connect
  // navigates away, so this only resets on error.
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      // Workspace-independent: the server resolves the caller's identity, so no
      // active-workspace header is needed on `/profile`.
      const [installed, catalog] = await Promise.all([
        listPersonalConnectors(),
        listPersonalCatalog(),
      ]);
      setConnectors(installed.connectors);
      setAvailable(catalog.catalog);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Redirect into the connector's OAuth flow. `window.location.assign` leaves
  // the SPA, so `busyKey` only needs resetting when the flow fails to start.
  const redirectToConnect = useCallback(async (serverName: string) => {
    const { authorizationUrl } = await initiateIdentityConnect(serverName);
    window.location.assign(authorizationUrl);
  }, []);

  // Available (not yet installed): install on the identity, then connect.
  const onConnectNew = useCallback(
    async (entry: DirectoryEntry) => {
      setActionError(null);
      setBusyKey(entry.id);
      try {
        const { serverName } = await installPersonalConnector(entry);
        await redirectToConnect(serverName);
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
        setBusyKey(null);
      }
    },
    [redirectToConnect],
  );

  // Installed but not authenticated (e.g. a cancelled or expired flow): connect
  // the existing record — no re-install.
  const onConnectExisting = useCallback(
    async (serverName: string) => {
      setActionError(null);
      setBusyKey(serverName);
      try {
        await redirectToConnect(serverName);
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
        setBusyKey(null);
      }
    },
    [redirectToConnect],
  );

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <SettingsPageHeader
        title="Connectors"
        description="Your personal connections — remote MCP services like Granola. Grant one to a workspace to let your agent use it there."
      />
      {loading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : loadError ? (
        <InlineError message={`Unable to load connectors: ${loadError}. Reload to retry.`} />
      ) : (
        <>
          {actionError ? <InlineError message={actionError} /> : null}
          <Section title="Your connectors" flush>
            {connectors.length === 0 ? (
              <EmptyState message="You haven't connected any connectors yet." />
            ) : (
              <div className="border-t border-border">
                {connectors.map((c) => (
                  <PersonalConnectorRow
                    key={c.serverName}
                    connector={c}
                    busy={busyKey === c.serverName}
                    onConnect={() => onConnectExisting(c.serverName)}
                  />
                ))}
              </div>
            )}
          </Section>

          {available.length > 0 ? (
            <Section
              title="Add a connector"
              description="Connect a personal service to use across your workspaces."
            >
              <div className="border-t border-border">
                {available.map((entry) => (
                  <AvailableConnectorRow
                    key={entry.id}
                    entry={entry}
                    busy={busyKey === entry.id}
                    onConnect={() => onConnectNew(entry)}
                  />
                ))}
              </div>
            </Section>
          ) : null}
        </>
      )}
    </div>
  );
}

function PersonalConnectorRow({
  connector,
  busy,
  onConnect,
}: {
  connector: PersonalConnector;
  busy: boolean;
  onConnect: () => void;
}) {
  const grants = connector.grantedWorkspaces.length;
  const grantLabel =
    grants === 0 ? "Not granted" : `Granted to ${grants} workspace${grants === 1 ? "" : "s"}`;
  const connected = connector.state === "running";
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
        {connected ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />
            Connected
          </span>
        ) : (
          <Button type="button" variant="outline" size="sm" onClick={onConnect} disabled={busy}>
            {busy ? "Connecting…" : "Connect"}
          </Button>
        )}
      </div>
    </div>
  );
}

function AvailableConnectorRow({
  entry,
  busy,
  onConnect,
}: {
  entry: DirectoryEntry;
  busy: boolean;
  onConnect: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border py-3">
      <div className="flex min-w-0 items-center gap-3">
        {entry.iconUrl ? (
          <img src={entry.iconUrl} alt="" className="h-6 w-6 shrink-0 rounded" />
        ) : null}
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{entry.name}</div>
          {entry.description ? (
            <div className="truncate text-xs text-muted-foreground">{entry.description}</div>
          ) : null}
        </div>
      </div>
      <Button type="button" variant="outline" size="sm" onClick={onConnect} disabled={busy}>
        {busy ? "Connecting…" : "Connect"}
      </Button>
    </div>
  );
}
