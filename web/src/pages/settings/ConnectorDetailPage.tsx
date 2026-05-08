import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  getInstalledConnectors,
  type InstalledConnector,
  uninstallConnector,
} from "../../api/client";
import { BundleConfigSection } from "../../components/connectors/BundleConfigSection";
import { CollapsibleSection } from "../../components/connectors/CollapsibleSection";
import { ConnectorStatusHero } from "../../components/connectors/ConnectorStatusHero";
import { OAuthConnectionSection } from "../../components/connectors/OAuthConnectionSection";
import { OperatorOAuthSection } from "../../components/connectors/OperatorOAuthSection";
import { ToolPermissionsTable } from "../../components/connectors/ToolPermissionsTable";
import { roleAtLeast, useScopedRole } from "../../hooks/useScopedRole";

/**
 * Per-connector Configure page. The visual hierarchy is driven by
 * `installed.status` — a generic UI status the server derives from
 * the underlying BundleState + credential probes:
 *
 *   - The hero block carries the page's primary CTA (Configure /
 *     Set up OAuth / Connect / Reconnect) when status ≠ ready, and
 *     fades to just the title block when ready.
 *
 *   - Sections below the hero are *settings* surfaces — connection
 *     details when running, OAuth client audit when configured,
 *     bundle config when populated. Each renders only when its
 *     content is actually present; an empty Configure page reads as
 *     "everything's good, nothing to manage."
 *
 *   - Tool permissions live behind a collapse. They're useful but
 *     verbose (12+ rows for some bundles); making them the page's
 *     longest scroll context drowns the actual configuration state.
 *
 * Reachable from `/settings/{personal,workspace}/connectors/:serverName`;
 * scope comes from the route prefix.
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

  const role = useScopedRole();
  // Workspace-scope edit gates ride on ws_admin. User-scope (personal
  // connectors) is always editable by the owner — it's their account.
  const canManage = scope === "user" ? true : roleAtLeast(role, "ws_admin");

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

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      {/* Action bar — back link / docs / uninstall. Stays minimal so
          the hero is the first thing the eye lands on. */}
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
          {canManage && (
            <button
              type="button"
              onClick={onUninstall}
              disabled={acting !== null}
              className="text-xs text-destructive hover:underline disabled:opacity-60"
            >
              {acting === "uninstall" ? "Uninstalling…" : "Uninstall"}
            </button>
          )}
        </div>
      </div>

      {/* Hero — title block plus a status row that absorbs the
          primary CTA. Quiet when ready; anchored when there's
          something to do. */}
      <ConnectorStatusHero installed={installed} canManage={canManage} onChanged={refresh} />

      {error && <p className="text-xs text-destructive">{error}</p>}

      {/* Settings surfaces. Each renders only when its content is
          present — an empty stack here means "nothing to tune." */}
      <div className="space-y-6">
        <OAuthConnectionSection installed={installed} canManage={canManage} onChanged={refresh} />
        <OperatorOAuthSection installed={installed} canManage={canManage} onChanged={refresh} />
        <BundleConfigSection installed={installed} canManage={canManage} onChanged={refresh} />

        {/* Tool permissions — collapsed by default. Verbose enough
            that always-rendering pushes everything else off-screen
            on bundles with 10+ tools. */}
        <CollapsibleSection
          title="Tool permissions"
          summary="Choose which tools the agent can call"
        >
          <ToolPermissionsTable serverName={installed.serverName} scope={scope} />
        </CollapsibleSection>
      </div>
    </div>
  );
}
