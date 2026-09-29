import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { getInstalledConnector, type InstalledConnector } from "../../api/client";
import { ConnectorHeader } from "../../components/connectors/ConnectorHeader";
import { ConnectorSettingsSection } from "../../components/connectors/ConnectorSettingsSection";
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
 *   - The header (`ConnectorHeader`) is the same for every connector:
 *     icon, display name and status on one line, the description under
 *     them, and a ⋯ menu holding Documentation, Disconnect, Uninstall and
 *     the technical details. A status banner with the primary CTA appears
 *     under it only when status ≠ ready.
 *
 *   - Then the sections, in one order, one rule between each: how the
 *     connector is reached (operator OAuth, secrets), how it behaves (its
 *     own settings section, when it declares one), and what the agent may
 *     call (tool permissions, collapsed to a summary).
 *
 * Reachable from `/w/:slug/settings/connectors/:serverName`.
 */
export function ConnectorDetailPage() {
  const { serverName = "", slug } = useParams<{ serverName: string; slug: string }>();
  const navigate = useNavigate();
  // Connectors are addressed by the URL slug — the page acts on whichever
  // workspace the slug names.
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
  // `canWriteWorkspaceScoped`.
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
        <Link to={backPath} className="block w-fit text-xs text-muted-foreground hover:underline">
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
        <Link to={backPath} className="block w-fit text-xs text-muted-foreground hover:underline">
          ← All connectors
        </Link>
        <p className="text-sm">Connector "{serverName}" is not installed.</p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      {/* A block, not inline: the column's spacing is a margin on each child, which
          an inline element ignores. */}
      <Link to={backPath} className="block w-fit text-xs text-muted-foreground hover:underline">
        ← All connectors
      </Link>

      {/* Identity, status and the connector's menu (docs, disconnect, uninstall,
          details), then a status banner only when something needs doing. */}
      <ConnectorHeader
        installed={installed}
        canManage={canManage}
        onChanged={refresh}
        onUninstall={() => setConfirmingUninstall(true)}
      />

      {error && <p className="text-xs text-destructive">{error}</p>}

      {/* Settings surfaces. Each renders only when its content is present, and one rule
          separates each from the next. Order runs from how the connector is reached, to
          how it behaves (its own settings), to what the agent may call — the tool list is
          the longest and least often changed, so it comes last and starts collapsed. */}
      <div className="divide-y divide-border/60 [&>*]:py-6 [&>*:first-child]:pt-0 [&>*:last-child]:pb-0">
        <OperatorOAuthSection installed={installed} canManage={canManage} onChanged={refresh} />
        <WorkspaceSecretsSection installed={installed} canManage={canManage} />
        <ConnectorSettingsSection serverName={installed.serverName} canManage={canManage} />
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
