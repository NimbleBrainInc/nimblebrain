import { useCallback, useEffect, useState } from "react";
import {
  type ConnectionCatalogEntry,
  disconnectConnection,
  getAuthToken,
  getConnectionsCatalog,
  getInstalledConnections,
  type InstalledConnection,
  initiateMcpOAuth,
  installConnection,
} from "../../api/client";
import { Card, CardContent } from "../../components/ui/card";
import { useWorkspaceContext } from "../../context/WorkspaceContext";
import { useEvents } from "../../hooks/useEvents";
import { EmptyState, RequireActiveWorkspace, SettingsListPage } from "./components";

/**
 * Settings → Connections page.
 *
 * Two columns:
 *   - My Connections: oauthScope='member' bundles. Per-user "Connect"
 *     flows. Each row shows the caller's per-principal state +
 *     "Connected as <email>" when OIDC identity is captured.
 *   - Workspace Connections: oauthScope='workspace' bundles. Shared
 *     identity per workspace.
 *
 * One-click install. Clicking Connect on an uninstalled catalog entry
 * runs `POST /v1/connections/install` (which adds the bundle to
 * workspace.json + seeds the lifecycle map) and then immediately
 * `POST /v1/mcp-auth/initiate` to start the OAuth dance. Failures at
 * either step surface inline on the card.
 *
 * State → button mapping:
 *   - running          → "Disconnect"
 *   - reauth_required  → "Reconnect" (prior tokens broke; user reconsents)
 *   - dead             → "Reconnect"
 *   - not_authenticated, not_installed, stopped → "Connect"
 *   - pending_auth, starting → busy spinner
 */
export function ConnectionsTab() {
  return (
    <RequireActiveWorkspace>
      <Inner />
    </RequireActiveWorkspace>
  );
}

function Inner() {
  const [catalog, setCatalog] = useState<ConnectionCatalogEntry[]>([]);
  const [installed, setInstalled] = useState<InstalledConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const wsCtx = useWorkspaceContext();

  // Fetches catalog + installed. `silent` skips the loading flicker on
  // SSE-driven refreshes — the user is already looking at populated data.
  const refresh = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    setError(null);
    try {
      const [cat, ins] = await Promise.all([getConnectionsCatalog(), getInstalledConnections()]);
      setCatalog(cat.catalog);
      setInstalled(ins.installed);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Re-fetch on connection state transitions for this workspace. Critical
  // for the OAuth round-trip case: the user is redirected back to this
  // page while the code-exchange + tools/list is still running in the
  // background. Without an SSE-driven refresh, the card sticks at
  // "Connecting…" until the user reloads.
  const token = getAuthToken() ?? "";
  useEvents(token, wsCtx.activeWorkspace?.id, {
    onConnectionStateChanged: (evt) => {
      if (evt.wsId === wsCtx.activeWorkspace?.id) {
        refresh({ silent: true });
      }
    },
  });

  if (loading) {
    return (
      <SettingsListPage title="Connections" description="Loading…">
        <div />
      </SettingsListPage>
    );
  }
  if (error) {
    return (
      <SettingsListPage title="Connections" description={`Failed to load: ${error}`}>
        <EmptyState message="Unable to load connections. Reload the page or check the server logs." />
      </SettingsListPage>
    );
  }

  // Index installed by URL so catalog entries can find their installed counterpart.
  const installedByUrl = new Map<string, InstalledConnection>();
  for (const ins of installed) installedByUrl.set(ins.url, ins);

  // Catalog entries without an installed counterpart: render with
  // "Not installed" affordance.
  const memberCatalog = catalog.filter((e) => e.defaultScope === "member");
  const workspaceCatalog = catalog.filter((e) => e.defaultScope === "workspace");

  // Plus any installed bundles whose URL doesn't match the catalog (custom URLs).
  const orphanInstalled = installed.filter((ins) => !catalog.some((c) => c.url === ins.url));

  return (
    <SettingsListPage
      title="Connections"
      description="Connect remote services. Personal connections (member-scoped) are private to you; workspace connections are shared across the team."
    >
      <div className="grid gap-6 md:grid-cols-2">
        <ColumnSection
          heading="My Connections"
          subheading="Personal accounts — private to you"
          entries={memberCatalog}
          installedByUrl={installedByUrl}
          onChanged={refresh}
        />
        <ColumnSection
          heading="Workspace Connections"
          subheading="Shared across all workspace members"
          entries={workspaceCatalog}
          installedByUrl={installedByUrl}
          onChanged={refresh}
        />
      </div>

      {orphanInstalled.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-semibold mb-2">Custom URL Bundles</h3>
          <p className="text-xs text-muted-foreground mb-3">
            Bundles installed via direct URL (not in the catalog).
          </p>
          <div className="grid gap-2">
            {orphanInstalled.map((ins) => (
              <OrphanCard key={ins.serverName} ins={ins} onChanged={refresh} />
            ))}
          </div>
        </div>
      )}
    </SettingsListPage>
  );
}

function ColumnSection({
  heading,
  subheading,
  entries,
  installedByUrl,
  onChanged,
}: {
  heading: string;
  subheading: string;
  entries: ConnectionCatalogEntry[];
  installedByUrl: Map<string, InstalledConnection>;
  onChanged: () => void;
}) {
  return (
    <div>
      <h3 className="text-sm font-semibold">{heading}</h3>
      <p className="text-xs text-muted-foreground mb-3">{subheading}</p>
      {entries.length === 0 ? (
        <EmptyState message="No services in this category." />
      ) : (
        <div className="grid gap-2">
          {entries.map((entry) => (
            <ConnectionCard
              key={entry.id}
              entry={entry}
              installed={installedByUrl.get(entry.url)}
              onChanged={onChanged}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ConnectionCard({
  entry,
  installed,
  onChanged,
}: {
  entry: ConnectionCatalogEntry;
  installed: InstalledConnection | undefined;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const conn =
    installed?.oauthScope === "member" ? installed.myConnection : installed?.workspaceConnection;
  const state = conn?.state ?? (installed ? "not_authenticated" : "not_installed");
  // Static-auth (pre-registered OAuth apps: HubSpot, Gmail, Outlook, etc.)
  // can't be installed from the UI in v1 — they need operator setup
  // (registering the OAuth app, seeding clientId + clientSecret) before
  // any user can connect. Surface the affordance up front so the user
  // doesn't click Connect → 409.
  const needsOperatorSetup =
    installed?.missingOperatorSetup === true || (!installed && entry.auth === "static");
  const connected = state === "running";
  const reconnectable = state === "reauth_required" || state === "dead" || state === "crashed";

  // One-click install + connect. If the bundle isn't yet in
  // workspace.bundles[], call /install to add it, then /initiate to
  // start the OAuth dance. The /install endpoint is idempotent so a
  // race (user double-clicks, two tabs) is safe.
  const onConnect = async () => {
    setBusy(true);
    setErr(null);
    try {
      let serverName = installed?.serverName;
      if (!installed) {
        const installResult = await installConnection(entry.id);
        serverName = installResult.serverName;
      }
      if (!serverName) {
        throw new Error("Could not resolve serverName after install.");
      }
      const { authorizationUrl } = await initiateMcpOAuth(serverName);
      window.location.assign(authorizationUrl);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const onDisconnect = async () => {
    if (!installed) return;
    setBusy(true);
    setErr(null);
    try {
      await disconnectConnection(installed.serverName);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardContent className="py-3 px-4">
        <div className="flex items-center gap-3">
          {entry.iconUrl && (
            <img
              src={entry.iconUrl}
              alt=""
              className="h-8 w-8 rounded"
              onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")}
            />
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium text-sm">{entry.name}</span>
              <StatusPill state={state} identity={installed?.myConnection?.identity} />
            </div>
            <p className="text-xs text-muted-foreground truncate">{entry.description}</p>
            {err && <p className="text-xs text-destructive mt-1">{err}</p>}
          </div>
          <div className="flex items-center gap-2">
            {needsOperatorSetup ? (
              <div className="flex flex-col items-end gap-0.5 text-right">
                <span className="text-xs text-amber-600">Operator setup required</span>
                {entry.operatorSetup?.portalUrl && (
                  <a
                    href={entry.operatorSetup.portalUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[10px] text-muted-foreground underline"
                  >
                    {new URL(entry.operatorSetup.portalUrl).hostname}
                  </a>
                )}
              </div>
            ) : connected ? (
              <button
                type="button"
                onClick={onDisconnect}
                disabled={busy}
                className="text-xs px-3 py-1 rounded border border-border hover:bg-muted disabled:opacity-60"
              >
                {busy ? "…" : "Disconnect"}
              </button>
            ) : (
              <button
                type="button"
                onClick={onConnect}
                disabled={busy}
                className="text-xs px-3 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
              >
                {busy ? "Connecting…" : reconnectable ? "Reconnect" : "Connect"}
              </button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function OrphanCard({ ins, onChanged }: { ins: InstalledConnection; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const conn = ins.oauthScope === "member" ? ins.myConnection : ins.workspaceConnection;
  const state = conn?.state ?? "not_connected";
  return (
    <Card>
      <CardContent className="py-3 px-4">
        <div className="flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium text-sm font-mono">{ins.serverName}</span>
              <StatusPill state={state} />
            </div>
            <p className="text-xs text-muted-foreground truncate">{ins.url}</p>
          </div>
          {state === "running" && (
            <button
              type="button"
              onClick={async () => {
                setBusy(true);
                try {
                  await disconnectConnection(ins.serverName);
                  onChanged();
                } finally {
                  setBusy(false);
                }
              }}
              disabled={busy}
              className="text-xs px-3 py-1 rounded border border-border hover:bg-muted disabled:opacity-60"
            >
              {busy ? "…" : "Disconnect"}
            </button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function StatusPill({
  state,
  identity,
}: {
  state: string;
  identity?: { sub?: string; email?: string; name?: string };
}) {
  const variants: Record<string, string> = {
    running: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
    pending_auth: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
    starting: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
    reauth_required: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
    crashed: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
    dead: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
    stopped: "bg-muted text-muted-foreground",
    not_authenticated: "bg-muted text-muted-foreground",
    not_installed: "bg-muted text-muted-foreground",
  };
  const labels: Record<string, string> = {
    running: identity?.email ? `Connected as ${identity.email}` : "Connected",
    pending_auth: "Connecting…",
    starting: "Starting…",
    reauth_required: "Reconnection needed",
    crashed: "Crashed",
    dead: "Failed",
    stopped: "Stopped",
    not_authenticated: "Not connected",
    not_installed: "Not installed",
  };
  const cls = variants[state] ?? "bg-muted text-muted-foreground";
  const label = labels[state] ?? state.replace(/_/g, " ");
  return (
    <span className={`text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap ${cls}`}>{label}</span>
  );
}
