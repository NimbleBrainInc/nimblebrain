import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  type ConnectorCatalogEntry,
  disconnectConnector,
  getAuthToken,
  getConnectorsCatalog,
  getInstalledConnectors,
  type InstalledConnector,
  initiateMcpOAuth,
  installConnector,
} from "../../api/client";
import { useWorkspaceContext } from "../../context/WorkspaceContext";
import { useEvents } from "../../hooks/useEvents";
import { EmptyState } from "../../pages/settings/components";
import { Card, CardContent } from "../ui/card";

/**
 * Renders a list of connectors filtered to a single scope. Used by both
 * the Personal and Workspace connectors tabs in Settings — they share
 * the same list shape but filter the catalog (and installed list) to
 * the scope they manage.
 *
 * - `scope: "user"`      → Personal tab. Catalog filtered to entries
 *   with `defaultScope: "user"`. Installed list scoped to the caller's
 *   own user-scope bundles.
 * - `scope: "workspace"` → Workspace tab. Catalog filtered to entries
 *   with `defaultScope: "workspace"`. Installed list scoped to the
 *   active workspace's bundles.
 *
 * Each row links to the Configure detail page (`/settings/<scope>/
 * connectors/:serverName`) for tool permissions, reauth, uninstall —
 * the shared management surface across scopes.
 */
export function ConnectorList({
  scope,
  configureBasePath,
}: {
  scope: "user" | "workspace";
  configureBasePath: string;
}) {
  const [catalog, setCatalog] = useState<ConnectorCatalogEntry[]>([]);
  const [installed, setInstalled] = useState<InstalledConnector[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const wsCtx = useWorkspaceContext();

  const refresh = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!opts?.silent) setLoading(true);
      setError(null);
      try {
        const [cat, ins] = await Promise.all([
          getConnectorsCatalog(),
          getInstalledConnectors({ scope }),
        ]);
        setCatalog(cat.catalog);
        setInstalled(ins.installed);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!opts?.silent) setLoading(false);
      }
    },
    [scope],
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  // SSE-driven refresh: after the OAuth round-trip the user is redirected
  // back here while the backend code-exchange + tools/list is still
  // settling. Without a state-changed listener the card sticks at
  // "Connecting…" until reload.
  const token = getAuthToken() ?? "";
  useEvents(token, wsCtx.activeWorkspace?.id, {
    onConnectionStateChanged: () => {
      refresh({ silent: true });
    },
  });

  if (loading) {
    return <div className="text-sm text-muted-foreground">Loading…</div>;
  }
  if (error) {
    return <EmptyState message={`Unable to load connectors: ${error}. Reload to retry.`} />;
  }

  const installedByUrl = new Map<string, InstalledConnector>();
  for (const ins of installed) installedByUrl.set(ins.url, ins);

  const filteredCatalog = catalog.filter((e) => e.defaultScope === scope);
  const orphanInstalled = installed.filter((ins) => !catalog.some((c) => c.url === ins.url));

  return (
    <div className="flex flex-col gap-6">
      {filteredCatalog.length === 0 ? (
        <EmptyState message="No connectors available." />
      ) : (
        <div className="grid gap-2">
          {filteredCatalog.map((entry) => (
            <ConnectorCard
              key={entry.id}
              entry={entry}
              installed={installedByUrl.get(entry.url)}
              configureBasePath={configureBasePath}
            />
          ))}
        </div>
      )}

      {orphanInstalled.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-2">Custom URL bundles</h3>
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
    </div>
  );
}

function ConnectorCard({
  entry,
  installed,
  configureBasePath,
}: {
  entry: ConnectorCatalogEntry;
  installed: InstalledConnector | undefined;
  configureBasePath: string;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const state = installed?.state ?? "not_installed";
  const needsOperatorSetup =
    installed?.missingOperatorSetup === true || (!installed && entry.auth === "static");
  const isInstalled = !!installed;
  const reconnectable = state === "reauth_required" || state === "dead" || state === "crashed";

  const onConnect = async () => {
    setBusy(true);
    setErr(null);
    try {
      let serverName = installed?.serverName;
      if (!installed) {
        const installResult = await installConnector(entry.id);
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
              {(entry.interactive === true || installed?.interactive === true) && (
                <InteractiveBadge />
              )}
              <StatusPill state={state} identity={installed?.identity} />
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
            ) : isInstalled ? (
              <div className="flex items-center gap-2">
                {reconnectable && (
                  <button
                    type="button"
                    onClick={onConnect}
                    disabled={busy}
                    className="text-xs px-3 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
                  >
                    {busy ? "Reconnecting…" : "Reconnect"}
                  </button>
                )}
                <Link
                  to={`${configureBasePath}/${installed.serverName}`}
                  className="text-xs px-3 py-1 rounded border border-border hover:bg-muted"
                >
                  Configure
                </Link>
              </div>
            ) : (
              <button
                type="button"
                onClick={onConnect}
                disabled={busy}
                className="text-xs px-3 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
              >
                {busy ? "Connecting…" : "Connect"}
              </button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function OrphanCard({ ins, onChanged }: { ins: InstalledConnector; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const state = ins.state ?? "not_authenticated";
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
                  await disconnectConnector(ins.serverName);
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

function InteractiveBadge() {
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/40 text-accent-foreground font-medium whitespace-nowrap">
      Interactive
    </span>
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
