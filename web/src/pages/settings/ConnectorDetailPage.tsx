import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { getInstalledConnector, type InstalledConnector } from "../../api/client";
import { ConnectorStatusHero } from "../../components/connectors/ConnectorStatusHero";
import { OAuthConnectionSection } from "../../components/connectors/OAuthConnectionSection";
import { OperatorOAuthSection } from "../../components/connectors/OperatorOAuthSection";
import { ToolPermissionsTable } from "../../components/connectors/ToolPermissionsTable";
import { UninstallConnectorDialog } from "../../components/connectors/UninstallConnectorDialog";
import { WorkspaceSecretsSection } from "../../components/connectors/WorkspaceSecretsSection";
import { useCanWriteActiveWorkspace } from "../../hooks/useScopedRole";

/**
 * Per-connector Configure page. The visual hierarchy is driven by
 * `installed.status` — a generic UI status the server derives from
 * the underlying ConnectionState + credential probes:
 *
 *   - The hero block carries the page's primary CTA (Configure /
 *     Set up OAuth / Connect / Reconnect) when status ≠ ready, and
 *     fades to just the title block when ready.
 *
 *   - The action bar (top-right) groups secondary management
 *     affordances: Docs and Uninstall, keeping the page body focused
 *     on status + connection state + tool permissions with all
 *     "manage this connector" entry points in one consistent place.
 *
 *   - Tool permissions render inline as the page's primary content
 *     for any ready connector — that's what users come here for once
 *     setup is past.
 *
 * Reachable from `/w/:slug/settings/connectors/:serverName`.
 */
export function ConnectorDetailPage() {
  const { serverName = "", slug } = useParams<{ serverName: string; slug: string }>();
  const navigate = useNavigate();
  // Connectors are addressed by the URL slug — the page acts on whichever
  // workspace (personal or shared) the slug names.
  const backPath = `/w/${slug}/settings/connectors`;

  const [installed, setInstalled] = useState<InstalledConnector | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmingUninstall, setConfirmingUninstall] = useState(false);
  // Set only when an uninstall succeeded and a credential outlived it — either
  // stranded by a failed delete or kept for a sibling that still resolves it.
  // The connector is gone, so this page has nothing left to configure — the
  // notice takes its place rather than following a navigation nothing would
  // render.
  const [orphanNotice, setOrphanNotice] = useState<{
    text: string;
    tone: "error" | "info";
  } | null>(null);

  // Edit gates ride on workspace-admin *membership*, matching the server's
  // `canWriteWorkspaceScoped`. In a personal workspace the sole owner is its
  // admin (the workspace store enforces that invariant), so the same check
  // covers both cases.
  const canManage = useCanWriteActiveWorkspace();

  const refresh = useCallback(async () => {
    setError(null);
    try {
      // Targeted single-connector fetch — avoids building entries
      // (and tools() round-trips) for every other installed connector
      // when we only render one. Server resolves the connector from
      // serverName.
      const res = await getInstalledConnector(serverName);
      setInstalled(res.installed);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [serverName]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (loading) {
    return <div className="max-w-3xl mx-auto text-sm text-muted-foreground">Loading…</div>;
  }
  if (orphanNotice) {
    return (
      <div className="max-w-3xl mx-auto space-y-3">
        <Link to={backPath} className="text-xs text-muted-foreground hover:underline">
          ← All connectors
        </Link>
        <p
          className={
            orphanNotice.tone === "error"
              ? "text-sm text-destructive"
              : "text-sm text-muted-foreground"
          }
        >
          {orphanNotice.text}
        </p>
      </div>
    );
  }
  if (!installed) {
    return (
      <div className="max-w-3xl mx-auto space-y-3">
        <Link to={backPath} className="text-xs text-muted-foreground hover:underline">
          ← All connectors
        </Link>
        <p className="text-sm">Connector "{serverName}" is not installed.</p>
      </div>
    );
  }

  const cat = installed.catalog;

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      {/* Action bar — back link on the left, secondary management
          affordances on the right (Docs / Configure / Uninstall). */}
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
              onClick={() => setConfirmingUninstall(true)}
              className="text-xs text-destructive hover:underline"
            >
              Uninstall
            </button>
          )}
        </div>
      </div>

      {/* Hero — title block plus a status row that absorbs the
          primary CTA. Quiet when ready; anchored when there's
          something to do. */}
      <ConnectorStatusHero installed={installed} canManage={canManage} onChanged={refresh} />

      {error && <p className="text-xs text-destructive">{error}</p>}

      {/* Settings surfaces. Each renders only when its content is present. */}
      <div className="space-y-6">
        <OAuthConnectionSection installed={installed} canManage={canManage} onChanged={refresh} />
        <OperatorOAuthSection installed={installed} canManage={canManage} onChanged={refresh} />
        <WorkspaceSecretsSection installed={installed} canManage={canManage} />
        <ToolPermissionsTable serverName={installed.serverName} canManage={canManage} />
      </div>

      {canManage && (
        <UninstallConnectorDialog
          installed={installed}
          open={confirmingUninstall}
          onOpenChange={setConfirmingUninstall}
          // A clean uninstall leaves nothing to configure, so the page goes with
          // it. A key that outlived the connector is the one thing left to say —
          // stranded and still live, or kept for a sibling — and navigating away
          // is where it would be lost, so that case stays put and says so.
          onUninstalled={(notice) => {
            setConfirmingUninstall(false);
            if (notice) setOrphanNotice(notice);
            else navigate(backPath);
          }}
        />
      )}
    </div>
  );
}
