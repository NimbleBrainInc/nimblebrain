import { useCallback, useEffect, useState } from "react";
import {
  type DirectoryEntry,
  grantConnector,
  initiateComposioIdentityConnect,
  initiateIdentityConnect,
  installPersonalConnector,
  listPersonalCatalog,
  listPersonalConnectors,
  type PersonalConnector,
  revokeConnector,
} from "../../api/client";
import { Button } from "../../components/ui/button";
import { useWorkspaceContext, type WorkspaceInfo } from "../../context/WorkspaceContext";
import { EmptyState, InlineError, Section, SettingsPageHeader } from "./components";

/**
 * Profile → Connectors — `/profile/connectors`.
 *
 * A personal connector is a remote MCP connection (Granola, Gmail, …) the user
 * connects at the IDENTITY level — it follows them across workspaces and is
 * owned by no single workspace. This tab lists the connectors the user has
 * connected, offers the curated set available for a personal connection, and —
 * per connector — grants/revokes it into the caller's workspaces.
 *
 * A personal connector is identity-bound and must be granted into EVERY
 * workspace it's used in (the personal workspace included — no free-at-home);
 * only then do its tools surface to the agent there. Connecting redirects the
 * browser through the connector's OAuth flow (`installPersonalConnector` → a
 * Connect initiate → the vendor's authorization URL); the callback lands back
 * here. The Connect route depends on the connector's auth: DCR goes through
 * `initiateIdentityConnect` (keyed on the serverName), composio through
 * `initiateComposioIdentityConnect` (keyed on the catalog connector id).
 */
export function ProfileConnectorsTab() {
  const { workspaces } = useWorkspaceContext();
  const [connectors, setConnectors] = useState<PersonalConnector[]>([]);
  const [available, setAvailable] = useState<DirectoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  // A load failure blocks the page; an action failure is a banner above the
  // still-valid lists — two separate slots.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Keyed by the in-flight unit: a connector's serverName (Connect), a catalog
  // id (Add), or `grant:<serverName>:<wsId>` (grant/revoke a workspace).
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // Re-fetch the lists WITHOUT toggling the page spinner — used after a
  // grant/revoke so the open "manage access" panel doesn't collapse.
  const fetchLists = useCallback(async () => {
    // Workspace-independent: the server resolves the caller's identity, so no
    // active-workspace header is needed on `/profile`. The installed list is the
    // page's primary content; the curated picker is secondary — decouple them so
    // a `list_personal_catalog` failure hides "Add a connector" but doesn't block
    // the installed list behind a load error.
    const [installed, catalog] = await Promise.allSettled([
      listPersonalConnectors(),
      listPersonalCatalog(),
    ]);
    if (installed.status === "fulfilled") {
      setConnectors(installed.value.connectors);
      setLoadError(null);
    } else {
      const err = installed.reason;
      setLoadError(err instanceof Error ? err.message : String(err));
    }
    setAvailable(catalog.status === "fulfilled" ? catalog.value.catalog : []);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    await fetchLists();
    setLoading(false);
  }, [fetchLists]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Redirect into the connector's Connect flow. The route depends on the auth
  // type: composio keys on the catalog connector id, DCR on the serverName.
  // `window.location.assign` leaves the SPA, so `busyKey` only needs resetting
  // when the flow fails to start.
  const redirectToConnect = useCallback(
    async (target: { auth: "dcr" | "composio"; serverName: string; connectorId?: string }) => {
      const { authorizationUrl } =
        target.auth === "composio" && target.connectorId
          ? await initiateComposioIdentityConnect(target.connectorId)
          : await initiateIdentityConnect(target.serverName);
      window.location.assign(authorizationUrl);
    },
    [],
  );

  // Available (not yet installed): install on the identity, then connect. The
  // catalog only offers DCR + composio, so map the entry's auth to the Connect
  // route (`entry.id` is the composio connector id).
  const onConnectNew = useCallback(
    async (entry: DirectoryEntry) => {
      setActionError(null);
      setBusyKey(entry.id);
      try {
        const { serverName } = await installPersonalConnector(entry);
        const auth =
          entry.install.kind === "remote-oauth" && entry.install.auth === "composio"
            ? "composio"
            : "dcr";
        await redirectToConnect({ auth, serverName, connectorId: entry.id });
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
        setBusyKey(null);
        // The install may have persisted before the connect leg failed; re-sync
        // so the connector moves from "Add a connector" to "Your connectors".
        void refresh();
      }
    },
    [redirectToConnect, refresh],
  );

  // Installed but not authenticated (e.g. a cancelled or expired flow): connect
  // the existing record — no re-install. Route by the connector's stored auth.
  const onConnectExisting = useCallback(
    async (connector: PersonalConnector) => {
      setActionError(null);
      setBusyKey(connector.serverName);
      try {
        await redirectToConnect({
          auth: connector.auth,
          serverName: connector.serverName,
          connectorId: connector.connectorId,
        });
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
        setBusyKey(null);
      }
    },
    [redirectToConnect],
  );

  const onSetGrant = useCallback(
    async (serverName: string, wsId: string, granted: boolean) => {
      setActionError(null);
      setBusyKey(`grant:${serverName}:${wsId}`);
      try {
        await (granted ? revokeConnector : grantConnector)(serverName, wsId);
        await fetchLists();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyKey(null);
      }
    },
    [fetchLists],
  );

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <SettingsPageHeader
        title="Connectors"
        description="Your personal connections — remote MCP services like Granola. Grant one into a workspace to let your agent use it there."
      />
      {actionError ? <InlineError message={actionError} /> : null}
      {loading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : loadError ? (
        <InlineError message={`Unable to load connectors: ${loadError}. Reload to retry.`} />
      ) : (
        <>
          <Section title="Your connectors" flush>
            {connectors.length === 0 ? (
              <EmptyState message="You haven't connected any connectors yet." />
            ) : (
              <div className="border-t border-border">
                {connectors.map((c) => (
                  <PersonalConnectorRow
                    key={c.serverName}
                    connector={c}
                    workspaces={workspaces}
                    busyKey={busyKey}
                    onConnect={() => onConnectExisting(c)}
                    onSetGrant={onSetGrant}
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
  workspaces,
  busyKey,
  onConnect,
  onSetGrant,
}: {
  connector: PersonalConnector;
  workspaces: WorkspaceInfo[];
  busyKey: string | null;
  onConnect: () => void;
  onSetGrant: (serverName: string, wsId: string, granted: boolean) => void;
}) {
  const [managing, setManaging] = useState(false);
  const grants = connector.grantedWorkspaces.length;
  const grantLabel =
    grants === 0 ? "Not granted" : `Granted to ${grants} workspace${grants === 1 ? "" : "s"}`;
  const connected = connector.state === "running";
  const connectBusy = busyKey === connector.serverName;

  return (
    <div className="border-b border-border py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">
            {connector.displayName || connector.serverName}
          </div>
          {connector.description ? (
            <div className="truncate text-xs text-muted-foreground">{connector.description}</div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <button
            type="button"
            onClick={() => setManaging((m) => !m)}
            className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            aria-expanded={managing}
          >
            {grantLabel}
          </button>
          {connected ? (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />
              Connected
            </span>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onConnect}
              disabled={connectBusy}
            >
              {connectBusy ? "Connecting…" : "Connect"}
            </Button>
          )}
        </div>
      </div>

      {managing ? (
        <WorkspaceAccessPanel
          connector={connector}
          workspaces={workspaces}
          busyKey={busyKey}
          onSetGrant={onSetGrant}
        />
      ) : null}
    </div>
  );
}

function WorkspaceAccessPanel({
  connector,
  workspaces,
  busyKey,
  onSetGrant,
}: {
  connector: PersonalConnector;
  workspaces: WorkspaceInfo[];
  busyKey: string | null;
  onSetGrant: (serverName: string, wsId: string, granted: boolean) => void;
}) {
  return (
    <div className="mt-3 border-t border-border/60 pt-3">
      <div className="mb-2 text-xs text-muted-foreground">
        Grant this connector into a workspace to let your agent use it there.
      </div>
      {workspaces.length === 0 ? (
        <div className="text-xs text-muted-foreground">You have no workspaces yet.</div>
      ) : (
        <div className="space-y-0.5">
          {workspaces.map((ws) => (
            <WorkspaceGrantRow
              key={ws.id}
              ws={ws}
              granted={connector.grantedWorkspaces.includes(ws.id)}
              busy={busyKey === `grant:${connector.serverName}:${ws.id}`}
              onToggle={(granted) => onSetGrant(connector.serverName, ws.id, granted)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function WorkspaceGrantRow({
  ws,
  granted,
  busy,
  onToggle,
}: {
  ws: WorkspaceInfo;
  granted: boolean;
  busy: boolean;
  onToggle: (granted: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <span className="truncate text-sm">
        {ws.name}
        {ws.isPersonal ? <span className="text-muted-foreground"> · personal</span> : null}
      </span>
      <Button
        type="button"
        size="sm"
        variant={granted ? "ghost" : "outline"}
        disabled={busy}
        onClick={() => onToggle(granted)}
      >
        {busy ? "…" : granted ? "Revoke" : "Grant"}
      </Button>
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
