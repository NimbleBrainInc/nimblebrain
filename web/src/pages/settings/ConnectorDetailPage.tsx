import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  disconnectConnector,
  getInstalledConnectors,
  initiateMcpOAuth,
  type InstalledConnector,
} from "../../api/client";
import { ToolPermissionsTable } from "../../components/connectors/ToolPermissionsTable";
import { Card, CardContent } from "../../components/ui/card";

/**
 * Per-connector Configure detail page. Reachable from both
 * /settings/personal/connectors/:serverName and
 * /settings/workspace/connectors/:serverName — the scope is determined
 * by the route prefix.
 *
 * Surfaces:
 *  - Header (icon, name, source link, status)
 *  - Reauth button (if reauth_required state)
 *  - Tool permissions table (per-tool allow/disallow)
 *  - Uninstall button (danger zone)
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
      await disconnectConnector(installed.serverName, scope);
      navigate(backPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setActing(null);
    }
  };

  if (loading) {
    return <div className="text-sm text-muted-foreground p-6">Loading…</div>;
  }
  if (!installed) {
    return (
      <div className="p-6 flex flex-col gap-3">
        <Link to={backPath} className="text-xs text-muted-foreground hover:underline">
          ← All connectors
        </Link>
        <p className="text-sm">Connector "{serverName}" is not installed in this scope.</p>
      </div>
    );
  }

  const cat = installed.catalog;
  const reconnectable =
    installed.state === "reauth_required" ||
    installed.state === "dead" ||
    installed.state === "crashed";

  return (
    <div className="p-4 md:p-6 flex flex-col gap-6 max-w-4xl">
      <div>
        <Link to={backPath} className="text-xs text-muted-foreground hover:underline">
          ← All connectors
        </Link>
      </div>

      <Card>
        <CardContent className="py-4 px-5">
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
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold">{cat?.name ?? installed.serverName}</h2>
                {installed.interactive && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/40 text-accent-foreground font-medium">
                    Interactive
                  </span>
                )}
              </div>
              {cat?.description && (
                <p className="text-sm text-muted-foreground mt-0.5">{cat.description}</p>
              )}
              <div className="text-xs text-muted-foreground mt-2 flex flex-wrap gap-x-4 gap-y-1">
                <span>
                  Scope: <span className="font-medium">{installed.scope}</span>
                </span>
                <span>
                  State: <span className="font-medium">{installed.state}</span>
                </span>
                {installed.identity?.email && <span>Connected as {installed.identity.email}</span>}
              </div>
            </div>
            <div className="flex flex-col gap-2 shrink-0">
              {reconnectable && (
                <button
                  type="button"
                  onClick={onReauth}
                  disabled={acting !== null}
                  className="text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
                >
                  {acting === "reauth" ? "Reconnecting…" : "Reconnect"}
                </button>
              )}
            </div>
          </div>
          {error && <p className="text-xs text-destructive mt-3">{error}</p>}
        </CardContent>
      </Card>

      <ToolPermissionsTable serverName={installed.serverName} scope={scope} />

      <Card>
        <CardContent className="py-4 px-5">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold">Uninstall</h3>
              <p className="text-xs text-muted-foreground">
                Removes the connector from this {scope === "user" ? "account" : "workspace"},
                revokes credentials, and deletes tool permissions. Re-installable from the catalog
                later.
              </p>
            </div>
            <button
              type="button"
              onClick={onUninstall}
              disabled={acting !== null}
              className="text-xs px-3 py-1.5 rounded border border-destructive text-destructive hover:bg-destructive/10 disabled:opacity-60"
            >
              {acting === "uninstall" ? "Uninstalling…" : "Uninstall"}
            </button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
