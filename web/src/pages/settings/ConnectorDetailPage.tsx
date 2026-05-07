import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  getInstalledConnectors,
  initiateMcpOAuth,
  type InstalledConnector,
  uninstallConnector,
} from "../../api/client";
import { ToolPermissionsTable } from "../../components/connectors/ToolPermissionsTable";

/**
 * Per-connector Configure detail page. Reachable from both
 * /settings/personal/connectors/:serverName and
 * /settings/workspace/connectors/:serverName — the scope is determined
 * by the route prefix.
 *
 * Layout: centered single column, no card chrome — sections separated
 * by spacing alone. Top-right action bar holds the destructive
 * Uninstall plus an optional Docs link. Reauth and per-tool
 * permissions sit inline.
 */
export function ConnectorDetailPage({ scope }: { scope: "user" | "workspace" }) {
  const { serverName = "" } = useParams<{ serverName: string }>();
  const navigate = useNavigate();
  const backPath =
    scope === "user" ? "/settings/personal/connectors" : "/settings/workspace/connectors";

  const [installed, setInstalled] = useState<InstalledConnector | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const res = await getInstalledConnectors({ scope });
      const found = res.installed.find((i) => i.serverName === serverName) ?? null;
      setInstalled(found);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [serverName, scope]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const onReauth = async () => {
    if (!installed) return;
    setActing("reauth");
    setError(null);
    try {
      const { authorizationUrl } = await initiateMcpOAuth(installed.serverName);
      window.location.assign(authorizationUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setActing(null);
    }
  };

  const onUninstall = async () => {
    if (!installed) return;
    if (
      !confirm(
        `Uninstall "${installed.catalog?.name ?? installed.serverName}"? This removes credentials and tool permissions.`,
      )
    ) {
      return;
    }
    setActing("uninstall");
    setError(null);
    try {
      await uninstallConnector(installed.serverName, scope);
      navigate(backPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setActing(null);
    }
  };

  if (loading) {
    return <div className="max-w-3xl mx-auto text-sm text-muted-foreground">Loading…</div>;
  }
  if (!installed) {
    return (
      <div className="max-w-3xl mx-auto space-y-3">
        <Link to={backPath} className="text-xs text-muted-foreground hover:underline">
          ← All connectors
        </Link>
        <p className="text-sm">Connector "{serverName}" is not installed in this scope.</p>
      </div>
    );
  }

  const cat = installed.catalog;
  // Reconnect is OAuth-flow specific. Local bundles can be in dead /
  // crashed state too, but they need a different recovery path
  // (restart, not OAuth re-init). Hide the button for non-remote.
  const reconnectable =
    installed.type === "remote" &&
    (installed.state === "reauth_required" ||
      installed.state === "dead" ||
      installed.state === "crashed");

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Action bar — back link on the left, docs + uninstall on the right */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <Link to={backPath} className="text-xs text-muted-foreground hover:underline">
          ← All connectors
        </Link>
        <div className="flex items-center gap-3">
          {cat?.docsUrl && (
            <a
              href={cat.docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-muted-foreground hover:text-foreground hover:underline"
            >
              Docs ↗
            </a>
          )}
          <button
            type="button"
            onClick={onUninstall}
            disabled={acting !== null}
            className="text-xs text-destructive hover:underline disabled:opacity-60"
          >
            {acting === "uninstall" ? "Uninstalling…" : "Uninstall"}
          </button>
        </div>
      </div>

      {/* Header — icon + name + metadata, no card chrome */}
      <div className="flex items-start gap-4">
        {cat?.iconUrl && (
          <img
            src={cat.iconUrl}
            alt=""
            className="h-12 w-12 rounded shrink-0"
            onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")}
          />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-xl font-semibold tracking-tight">
              {cat?.name ?? installed.serverName}
            </h1>
            {installed.interactive && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/40 text-accent-foreground font-medium">
                Interactive
              </span>
            )}
          </div>
          {cat?.description && (
            <p className="text-sm text-muted-foreground mt-1">{cat.description}</p>
          )}
          <dl className="text-xs text-muted-foreground mt-3 flex flex-wrap gap-x-5 gap-y-1">
            <div>
              <dt className="inline">Type: </dt>
              <dd className="inline font-medium text-foreground">{installed.type}</dd>
            </div>
            <div>
              <dt className="inline">Scope: </dt>
              <dd className="inline font-medium text-foreground">{installed.scope}</dd>
            </div>
            <div>
              <dt className="inline">State: </dt>
              <dd className="inline font-medium text-foreground">{installed.state}</dd>
            </div>
            {installed.version && installed.version !== "remote" && (
              <div>
                <dt className="inline">Version: </dt>
                <dd className="inline font-medium text-foreground font-mono">
                  {installed.version}
                </dd>
              </div>
            )}
            {installed.identity?.email && (
              <div>
                <dt className="inline">Connected as: </dt>
                <dd className="inline font-medium text-foreground">{installed.identity.email}</dd>
              </div>
            )}
          </dl>
          {reconnectable && (
            <div className="mt-3">
              <button
                type="button"
                onClick={onReauth}
                disabled={acting !== null}
                className="text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
              >
                {acting === "reauth" ? "Reconnecting…" : "Reconnect"}
              </button>
            </div>
          )}
        </div>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {/* Tool permissions */}
      <ToolPermissionsTable serverName={installed.serverName} scope={scope} />
    </div>
  );
}
