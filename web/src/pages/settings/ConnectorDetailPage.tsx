import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  getInstalledConnector,
  type InstalledConnector,
  uninstallConnector,
} from "../../api/client";
import { BundleCredentialsModal } from "../../components/connectors/BundleCredentialsModal";
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
 *   - The action bar (top-right) groups secondary management
 *     affordances: Docs, Configure (when stdio bundle has a
 *     `user_config` schema and status is ready — the hero owns
 *     `needs_setup`), and Uninstall. Putting Configure here instead
 *     of as another inline section keeps the page body focused on
 *     status + connection state + tool permissions, with all
 *     "manage this connector" entry points in one consistent place.
 *
 *   - Tool permissions render inline as the page's primary content
 *     for any ready connector — that's what users come here for once
 *     setup is past.
 *
 * Reachable from `/settings/{personal,workspace}/connectors/:serverName`;
 * `mode` comes from the route prefix.
 */
export function ConnectorDetailPage({ mode }: { mode: "personal" | "workspace" }) {
  const { serverName = "", slug } = useParams<{ serverName: string; slug: string }>();
  const navigate = useNavigate();
  // Workspace connectors are addressed by the URL slug. (Personal-scope
  // connectors have no UI surface today; the mode is kept for the API.)
  const backPath = `/w/${slug}/settings/connectors`;

  const [installed, setInstalled] = useState<InstalledConnector | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [configureModalOpen, setConfigureModalOpen] = useState(false);
  // Two-step uninstall: first click arms the button (label changes
  // to "Click again to confirm"), second click runs. Replaces
  // window.confirm() — that gets suppressed by browsers after a
  // few uses and silently makes destructive buttons no-op.
  const [uninstallArmed, setUninstallArmed] = useState(false);

  const role = useScopedRole();
  // Workspace-mode edit gates ride on ws_admin. Personal-mode is
  // always editable by the owner — it's their personal workspace, and
  // the workspace store enforces sole-owner membership invariants.
  const canManage = mode === "personal" ? true : roleAtLeast(role, "ws_admin");

  const refresh = useCallback(async () => {
    setError(null);
    try {
      // Targeted single-connector fetch — avoids building entries
      // (and tools() round-trips) for every other installed bundle
      // when we only render one. Server resolves the connector from
      // serverName; the page `mode` is a UI affordance, not a server
      // arg.
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

  const onUninstall = async () => {
    if (!installed) return;
    // First click arms; second click runs. Replaces window.confirm()
    // (browsers suppress it after a few uses, silently no-op'ing
    // destructive buttons).
    if (!uninstallArmed) {
      setUninstallArmed(true);
      return;
    }
    setActing("uninstall");
    setError(null);
    try {
      await uninstallConnector(installed.serverName, "workspace");
      navigate(backPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setActing(null);
      setUninstallArmed(false);
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
        <p className="text-sm">Connector "{serverName}" is not installed.</p>
      </div>
    );
  }

  const cat = installed.catalog;

  // Header-level Configure affordance. Visible when:
  //   - the user can manage this connector
  //   - the bundle declares a user_config schema (anything to set)
  //   - the status isn't `needs_setup` — when it is, the hero owns
  //     the primary CTA and a duplicate header button would
  //     double-count the prompt
  const showHeaderConfigure =
    canManage &&
    !!installed.userConfig &&
    Object.keys(installed.userConfig.schema).length > 0 &&
    installed.status !== "needs_setup";

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
          {showHeaderConfigure && (
            <button
              type="button"
              onClick={() => setConfigureModalOpen(true)}
              className="text-xs px-3 py-1.5 rounded border border-border bg-background hover:bg-muted"
            >
              Configure
            </button>
          )}
          {canManage && (
            <button
              type="button"
              onClick={onUninstall}
              onBlur={() => setUninstallArmed(false)}
              disabled={acting !== null}
              className={`text-xs hover:underline disabled:opacity-60 ${
                uninstallArmed
                  ? "text-destructive font-semibold"
                  : "text-destructive/80 hover:text-destructive"
              }`}
            >
              {acting === "uninstall"
                ? "Uninstalling…"
                : uninstallArmed
                  ? "Click again to confirm"
                  : "Uninstall"}
            </button>
          )}
        </div>
      </div>

      {/* Registry apps are version-managed at the org level (the mpak cache is
          shared platform-wide), so upgrades don't live here — point admins to
          Org → About. Connect/auth/configure stays on this page. */}
      {installed.installSource === "registry" && (
        <p className="text-xs text-muted-foreground">
          {installed.version ? `v${installed.version} · ` : ""}app version is managed in{" "}
          <Link to="/org/about" className="text-primary underline-offset-4 hover:underline">
            Org → About
          </Link>
          .
        </p>
      )}

      {/* Hero — title block plus a status row that absorbs the
          primary CTA. Quiet when ready; anchored when there's
          something to do. */}
      <ConnectorStatusHero installed={installed} canManage={canManage} onChanged={refresh} />

      {error && <p className="text-xs text-destructive">{error}</p>}

      {/* Settings surfaces. Each renders only when its content is
          present. Bundle config is no longer a section — the
          Configure button in the header above opens the same modal. */}
      <div className="space-y-6">
        <OAuthConnectionSection installed={installed} canManage={canManage} onChanged={refresh} />
        <OperatorOAuthSection installed={installed} canManage={canManage} onChanged={refresh} />
        <ToolPermissionsTable serverName={installed.serverName} mode={mode} />
      </div>

      {configureModalOpen && (
        <BundleCredentialsModal
          installed={installed}
          open={configureModalOpen}
          onClose={() => setConfigureModalOpen(false)}
          onSaved={() => {
            setConfigureModalOpen(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}
