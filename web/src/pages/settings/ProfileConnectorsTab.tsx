import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import {
  type CatalogListing,
  disconnectPersonalConnector,
  grantConnector,
  initiateComposioIdentityConnect,
  initiateIdentityConnect,
  installPersonalConnector,
  listPersonalCatalog,
  listPersonalConnectors,
  type PersonalConnector,
  revokeConnector,
} from "../../api/client";
import { ConnectorIcon } from "../../components/connectors/ConnectorIcon";
import { ToolPermissionsTable } from "../../components/connectors/ToolPermissionsTable";
import { Button } from "../../components/ui/button";
import { ConfirmDialog } from "../../components/ui/confirm-dialog";
import { Switch } from "../../components/ui/switch";
import { useWorkspaceContext, type WorkspaceInfo } from "../../context/WorkspaceContext";
import { cn } from "../../lib/utils";
import { EmptyState, InlineError, Section, SettingsPageHeader } from "./components";

/**
 * Profile → Connectors — `/profile/connectors`.
 *
 * A personal connector is a remote MCP connection (Granola, Gmail, …) the user
 * connects at the IDENTITY level — it follows them across workspaces and is
 * owned by no single workspace. This tab lists the connectors the user has
 * connected, offers the curated set available for a personal connection, and —
 * per connector — grants/revokes it into the caller's workspaces and sets which
 * of its tools the agent may call. That tool policy is the caller's own
 * (`scope: "identity"`), read by the gate on every call to the connector in any
 * workspace it is granted to.
 *
 * A personal connector is identity-bound and must be granted into EVERY
 * workspace it's used in (no free-at-home);
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
  const [available, setAvailable] = useState<CatalogListing[]>([]);
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
  // type: composio keys on the catalog connector id, DCR on the serverName. The
  // redirect (`window.location.assign`) leaves the SPA, so the callers keep the row
  // busy until navigation and reset only on a thrown failure. The headless
  // "already connected" outcome below returns WITHOUT navigating, so it must clear
  // the busy state itself.
  const redirectToConnect = useCallback(
    async (target: { auth: "dcr" | "composio"; serverName: string; connectorId?: string }) => {
      const { authorizationUrl } =
        target.auth === "composio" && target.connectorId
          ? await initiateComposioIdentityConnect(target.connectorId)
          : await initiateIdentityConnect(target.serverName);
      if (!authorizationUrl) {
        // Already connected (no interactive flow) — refresh state in place rather
        // than redirecting to a nonexistent auth page. This success path does NOT
        // leave the SPA, so clear the row's busy state here (the callers reset only
        // on a thrown failure). (#679)
        await refresh();
        setBusyKey(null);
        return;
      }
      window.location.assign(authorizationUrl);
    },
    [refresh],
  );

  // Available (not yet installed): install on the identity, then connect. The
  // catalog only offers DCR + composio, so map the entry's auth to the Connect
  // route (`entry.id` is the composio connector id).
  const onConnectNew = useCallback(
    async (entry: CatalogListing) => {
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

  // Fully remove a personal connector — de-auth + delete credentials + revoke all
  // grants + drop the install. The row confirms first; a failure throws, so the
  // confirm dialog shows it beside the action that caused it.
  const onDisconnect = useCallback(
    async (serverName: string) => {
      setActionError(null);
      await disconnectPersonalConnector(serverName);
      await fetchLists();
    },
    [fetchLists],
  );

  return (
    <div className="space-y-6">
      <SettingsPageHeader
        title="Connectors"
        description="Your personal connections to services like Granola. Turn one on in a workspace to let your agent use it there."
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
                    onDisconnect={() => onDisconnect(c.serverName)}
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

/**
 * One personal connector, as a single disclosure:
 *
 *   [icon] <name>                                <workspace reach>  [Connect]  ⌄
 *          ● Connected as <account>
 *   ── opened ──────────────────────────────────────────────────────────────
 *          Workspaces        one switch per workspace
 *          Tool permissions  the table, listed on request
 *          Disconnect
 *
 * Closed, the row says only what is true: who it is signed in as and where the
 * agent may use it. Connect is the one action shown closed, because it is the
 * one thing that needs doing. Everything that changes the connector, including
 * the destructive Disconnect, is inside.
 */
function PersonalConnectorRow({
  connector,
  workspaces,
  busyKey,
  onConnect,
  onDisconnect,
  onSetGrant,
}: {
  connector: PersonalConnector;
  workspaces: WorkspaceInfo[];
  busyKey: string | null;
  onConnect: () => void;
  onDisconnect: () => Promise<void>;
  onSetGrant: (serverName: string, wsId: string, granted: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const panelId = useId();
  const name = connector.displayName || connector.serverName;
  const connected = connector.state === "running";
  const account = connector.identity?.email ?? connector.identity?.name;
  const connectBusy = busyKey === connector.serverName;
  const reach = workspaceReach(connector.grantedWorkspaces, workspaces);

  return (
    <div className="border-b border-border">
      <div className="relative -mx-2 flex items-center gap-3 rounded-sm px-2 py-3">
        <ConnectorIcon name={name} iconUrl={connector.iconUrl} className={ROW_ICON} />
        <div className="min-w-0 flex-1">
          {/* The name is the disclosure; its ::after stretches over the whole
              row, so the row is one click target. Connect sits above it. */}
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-controls={panelId}
            className="block max-w-full truncate text-left text-sm font-medium outline-none after:absolute after:inset-0 after:rounded-sm after:content-[''] hover:after:bg-foreground/5 focus-visible:after:ring-3 focus-visible:after:ring-ring/50"
          >
            {name}
          </button>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span
              className={cn(
                "h-1.5 w-1.5 shrink-0 rounded-full",
                connected ? "bg-success" : "bg-muted-foreground/50",
              )}
              aria-hidden
            />
            <span className="truncate">
              {!connected ? (
                "Not connected"
              ) : account ? (
                <>
                  Connected as <span className="font-medium text-foreground">{account}</span>
                </>
              ) : (
                "Connected"
              )}
            </span>
          </div>
        </div>
        <span
          className={cn(
            "shrink-0 text-xs tabular-nums",
            connector.grantedWorkspaces.length === 0 ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {reach}
        </span>
        {connected ? null : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onConnect}
            disabled={connectBusy}
            className="relative"
          >
            {connectBusy ? "Connecting…" : "Connect"}
          </Button>
        )}
        <ChevronDown
          aria-hidden
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
            open && "rotate-180",
          )}
        />
      </div>

      {open ? (
        <div id={panelId} className="space-y-6 pt-3 pb-4 pl-9">
          <WorkspaceAccess
            connector={connector}
            name={name}
            workspaces={workspaces}
            busyKey={busyKey}
            onSetGrant={onSetGrant}
          />
          <ToolPermissionsSection
            serverName={connector.serverName}
            name={name}
            connected={connected}
          />
          <div className="flex items-center justify-between gap-4 border-t border-border/60 pt-4">
            <p className="text-xs text-muted-foreground">
              Sign out of {name} and remove it from your account.
            </p>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => setConfirmingDisconnect(true)}
            >
              Disconnect
            </Button>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmingDisconnect}
        onOpenChange={setConfirmingDisconnect}
        title={`Disconnect ${name}?`}
        description={disconnectConsequence(connector.grantedWorkspaces.length)}
        confirmLabel="Disconnect"
        pendingLabel="Disconnecting…"
        destructive
        onConfirm={async () => {
          await onDisconnect();
          setConfirmingDisconnect(false);
        }}
      />
    </div>
  );
}

/** A list row's icon; the panel's indent (`pl-9`) is this width plus the row's gap. */
const ROW_ICON = "h-6 w-6 rounded text-xs";

/** Where the agent may use the connector, read against the caller's workspaces. */
export function workspaceReach(grantedIds: string[], workspaces: WorkspaceInfo[]): string {
  const n = grantedIds.length;
  if (n === 0) return "Not on in any workspace";
  const total = workspaces.length;
  // A grant into a workspace the list doesn't hold (not loaded yet, or no longer
  // a member) has no "of N" to count against.
  if (!grantedIds.every((id) => workspaces.some((w) => w.id === id))) {
    return `On in ${n} workspace${n === 1 ? "" : "s"}`;
  }
  if (n === total) return total === 1 ? "On in your workspace" : "On in all workspaces";
  return `On in ${n} of ${total} workspaces`;
}

function disconnectConsequence(grants: number): string {
  const base = "Signs out and removes it from your account.";
  if (grants === 0) return base;
  return `${base} It turns off in the ${grants} workspace${grants === 1 ? "" : "s"} it is on in.`;
}

/** A section heading inside an opened row, styled like the tool table's own. */
function PanelHeading({ title, hint }: { title: string; hint: string }) {
  return (
    <div>
      <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
        {title}
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

function WorkspaceAccess({
  connector,
  name,
  workspaces,
  busyKey,
  onSetGrant,
}: {
  connector: PersonalConnector;
  name: string;
  workspaces: WorkspaceInfo[];
  busyKey: string | null;
  onSetGrant: (serverName: string, wsId: string, granted: boolean) => void;
}) {
  return (
    <section className="space-y-3">
      <PanelHeading
        title="Workspaces"
        hint={`Your agent can use ${name} only in workspaces where it is on.`}
      />
      {workspaces.length === 0 ? (
        <p className="text-xs text-muted-foreground">You have no workspaces yet.</p>
      ) : (
        <ul className="border-t border-border/60">
          {workspaces.map((ws) => {
            const granted = connector.grantedWorkspaces.includes(ws.id);
            return (
              <li
                key={ws.id}
                className="flex items-center justify-between gap-4 border-b border-border/60 py-2.5"
              >
                <span className="truncate text-sm">{ws.name}</span>
                <Switch
                  checked={granted}
                  disabled={busyKey === `grant:${connector.serverName}:${ws.id}`}
                  onCheckedChange={() => onSetGrant(connector.serverName, ws.id, granted)}
                  aria-label={`Use ${name} in ${ws.name}`}
                />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * The connector's tool policy — the viewer's own (`scope: "identity"`), so they
 * may always change it. Listing tools starts a cold connector, so the table
 * mounts only when asked for, and replaces this stand-in heading in place.
 */
function ToolPermissionsSection({
  serverName,
  name,
  connected,
}: {
  serverName: string;
  name: string;
  connected: boolean;
}) {
  const [showing, setShowing] = useState(false);
  if (connected && showing) {
    return <ToolPermissionsTable serverName={serverName} scope="identity" canManage />;
  }
  return (
    <section className="flex items-start justify-between gap-3">
      <PanelHeading
        title="Tool permissions"
        hint={
          connected ? "Choose which tools the agent can call." : `Connect ${name} to see its tools.`
        }
      />
      {connected ? (
        <button
          type="button"
          onClick={() => setShowing(true)}
          className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          Show tools
        </button>
      ) : null}
    </section>
  );
}

function AvailableConnectorRow({
  entry,
  busy,
  onConnect,
}: {
  entry: CatalogListing;
  busy: boolean;
  onConnect: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border py-3">
      <div className="flex min-w-0 items-center gap-3">
        <ConnectorIcon name={entry.name} iconUrl={entry.iconUrl} className={ROW_ICON} />
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
