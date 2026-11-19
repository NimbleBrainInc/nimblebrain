import { useCallback, useEffect, useState } from "react";
import { Link, Navigate, useLocation, useNavigate, useParams } from "react-router-dom";
import type { Plugin, PluginServer } from "../_generated/platform-schemas/plugins";
import {
  disconnectPersonalConnector,
  getInstalledConnector,
  grantConnector,
  type InstalledConnector,
  listPersonalConnectors,
  listPlugins,
  type PersonalConnector,
  revokeConnector,
} from "../api/client";
import { ConnectorHeader, statusLabel } from "../components/connectors/ConnectorHeader";
import { ConnectorIcon } from "../components/connectors/ConnectorIcon";
import { ConnectorSettingsSection } from "../components/connectors/ConnectorSettingsSection";
import { OAuthClientSection } from "../components/connectors/OAuthClientSection";
import {
  disconnectConsequence,
  PanelHeading,
  PersonalToolPermissionsSection,
  personalConnectUrl,
  startPluginSignIn,
} from "../components/connectors/personal-connector";
import { ToolPermissionsTable } from "../components/connectors/ToolPermissionsTable";
import { UninstallConnectorDialog } from "../components/connectors/UninstallConnectorDialog";
import { WorkspaceSecretsSection } from "../components/connectors/WorkspaceSecretsSection";
import { UsePluginHereDialog } from "../components/plugins/UsePluginHereDialog";
import { Button } from "../components/ui/button";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { useWorkspaceContext } from "../context/WorkspaceContext";
import { useEvents } from "../hooks/useEvents";
import { useCanWriteActiveWorkspace } from "../hooks/useScopedRole";
import { ownerLine, pluginAccount, pluginConnected, pluginPath, shellPath } from "../lib/plugins";
import { cn } from "../lib/utils";
import { toSlug, toWsId } from "../lib/workspace-slug";
import { ConnectorSkillsSection } from "./settings/ConnectorSkillsSection";
import { InlineError } from "./settings/components";

/**
 * One plugin, at `/w/:slug/plugins/:pluginRef`: everything about it in this
 * workspace, by whose it is (ADR-0069).
 *
 * - **A workspace plugin** shows what configures its connection for every
 *   member: its OAuth client, secrets, its own settings, its skills, and the
 *   tools the agent may call. A workspace admin changes them and may uninstall
 *   it (`canManage`, the server's write rule).
 * - **A person's plugin** shows the account it signs in as, Connect or
 *   Disconnect, the owner's own tool permissions, whether it is used here, and
 *   every workspace it is used in, each revocable. Use here signs in too when
 *   it is not connected, and every sign-in returns to this page.
 *
 * The ref is the listing's `id`, URL-encoded (`pluginPath`); the page finds the
 * plugin by comparing ids and never reads one's parts. A plugin has one server
 * until plugins install as plugins (ADR-0068), and the page renders each
 * server's parts in turn so it holds when one has more.
 *
 * One column, because this renders in the main area beside the docked chat
 * (`web/DESIGN.md`).
 */
export function PluginDetailPage() {
  const { slug = "", pluginRef = "" } = useParams<{ slug: string; pluginRef: string }>();
  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-(--page-gutter) py-6 space-y-8">
        {/* A block, not inline: the column's spacing is a margin on each child, which
            an inline element ignores. */}
        <Link
          to={`/w/${slug}/plugins`}
          className="block w-fit text-xs text-muted-foreground hover:underline"
        >
          ← Plugins
        </Link>
        {/* Keyed by the route: a param-only change reuses the element, and one
            plugin's state must not carry over to the next. */}
        <PluginDetail key={`${slug}/${pluginRef}`} slug={slug} pluginRef={pluginRef} />
      </div>
    </div>
  );
}

function PluginDetail({ slug, pluginRef }: { slug: string; pluginRef: string }) {
  const wsId = toWsId(slug);
  const [plugin, setPlugin] = useState<Plugin | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(
    async (signal?: { cancelled: boolean }) => {
      try {
        const listing = await listPlugins(wsId);
        if (signal?.cancelled) return;
        setPlugin(listing.plugins.find((p) => p.id === pluginRef) ?? null);
        setLoadError(null);
      } catch (err) {
        if (signal?.cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      }
    },
    [wsId, pluginRef],
  );

  useEffect(() => {
    const signal = { cancelled: false };
    void refresh(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [refresh]);

  // A sign-in finishing elsewhere changes the plugin's status and account.
  useEvents({ onConnectionStateChanged: () => void refresh() });

  if (loadError && plugin === undefined) {
    return <InlineError message={`Unable to load this plugin: ${loadError}. Reload to retry.`} />;
  }
  if (plugin === undefined) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (plugin === null) {
    return <p className="text-sm">This plugin is not installed in this workspace.</p>;
  }
  return plugin.owner.kind === "workspace" ? (
    <WorkspacePlugin plugin={plugin} slug={slug} wsId={wsId} />
  ) : (
    <PersonalPlugin plugin={plugin} slug={slug} wsId={wsId} onChanged={() => void refresh()} />
  );
}

/** Whose account the plugin uses, and the apps it places, under its name. */
function PluginMeta({ plugin, slug }: { plugin: Plugin; slug: string }) {
  return (
    <div className="mt-1 space-y-0.5 text-sm text-muted-foreground">
      <p data-testid="plugin-owner">{ownerLine(plugin)}</p>
      {plugin.apps.length > 0 && (
        <p data-testid="plugin-apps">
          {plugin.apps.length === 1 ? "App: " : "Apps: "}
          {plugin.apps.map((app, i) => (
            <span key={app.resourceUri}>
              {i > 0 && " · "}
              {app.route ? (
                <Link
                  to={`/w/${slug}/app/${app.route}`}
                  className="text-foreground underline-offset-4 hover:underline"
                >
                  {app.label}
                </Link>
              ) : (
                app.label
              )}
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

// ── A workspace's plugin ────────────────────────────────────────────

function WorkspacePlugin({ plugin, slug, wsId }: { plugin: Plugin; slug: string; wsId: string }) {
  // Edit gates ride on workspace-admin *membership*, matching the server's
  // `canWriteWorkspaceScoped`.
  const canManage = useCanWriteActiveWorkspace();
  return (
    <div className="space-y-12">
      {plugin.servers.map((server, i) => (
        <WorkspaceConnector
          key={server.serverName}
          serverName={server.serverName}
          canManage={canManage}
          wsId={wsId}
          listPath={`/w/${slug}/plugins`}
          hasSkills={plugin.skills.some((s) => s.serverName === server.serverName)}
          meta={i === 0 ? <PluginMeta plugin={plugin} slug={slug} /> : undefined}
        />
      ))}
    </div>
  );
}

/**
 * One workspace connector's configuration. The header (`ConnectorHeader`) carries
 * identity, status and the ⋯ menu (docs, disconnect, uninstall, details), with a
 * status banner and its primary action only when something needs doing. Then
 * the sections in one order, one rule between each: how the connector is
 * reached (OAuth client, secrets), how it behaves (its own settings), the
 * guidance it brings (skills), and what the agent may call (tool permissions,
 * the longest and least often changed, so last and collapsed).
 */
function WorkspaceConnector({
  serverName,
  canManage,
  wsId,
  listPath,
  hasSkills,
  meta,
}: {
  serverName: string;
  canManage: boolean;
  wsId: string;
  listPath: string;
  hasSkills: boolean;
  meta?: React.ReactNode;
}) {
  const navigate = useNavigate();
  const [installed, setInstalled] = useState<InstalledConnector | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmingUninstall, setConfirmingUninstall] = useState(false);
  // Set only when an uninstall succeeded and a credential outlived it — either
  // stranded by a failed delete or kept for a sibling that still resolves it.
  // The connector is gone, so the notice takes its place rather than following
  // a navigation that would lose it.
  const [orphanNotice, setOrphanNotice] = useState<{
    text: string;
    tone: "error" | "info";
  } | null>(null);
  // `installed.allowedTools` is decided for the viewer's role, so a role change
  // re-reads the entry.
  const viewerRole = useWorkspaceContext().activeWorkspace?.userRole;

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const res = await getInstalledConnector(serverName);
      setInstalled(res.installed);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [serverName]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `viewerRole` is the trigger, not an input — the server reads the role itself
  useEffect(() => {
    void refresh();
  }, [refresh, viewerRole]);

  if (loading) return <div className="text-sm text-muted-foreground">Loading…</div>;
  if (orphanNotice) {
    return (
      <p
        className={
          orphanNotice.tone === "error"
            ? "text-sm text-destructive"
            : "text-sm text-muted-foreground"
        }
      >
        {orphanNotice.text}
      </p>
    );
  }
  if (!installed) {
    return error ? (
      <InlineError message={error} />
    ) : (
      <p className="text-sm">Connector "{serverName}" is not installed.</p>
    );
  }

  return (
    <div className="space-y-8">
      <ConnectorHeader
        installed={installed}
        canManage={canManage}
        onChanged={refresh}
        onUninstall={() => setConfirmingUninstall(true)}
        meta={meta}
      />

      {error && <p className="text-xs text-destructive">{error}</p>}

      {/* Each renders only when its content is present, and one rule separates
          each from the next. */}
      <div className="divide-y divide-border/60 [&>*]:py-6 [&>*:first-child]:pt-0 [&>*:last-child]:pb-0">
        <OAuthClientSection installed={installed} canManage={canManage} onChanged={refresh} />
        <WorkspaceSecretsSection installed={installed} canManage={canManage} />
        <ConnectorSettingsSection
          serverName={installed.serverName}
          canManage={canManage}
          allowedTools={installed.allowedTools}
        />
        {hasSkills && <ConnectorSkillsSection workspaceId={wsId} servers={[serverName]} />}
        <ToolPermissionsTable
          serverName={installed.serverName}
          scope="workspace"
          canManage={canManage}
          collapsible
        />
      </div>

      {canManage && (
        <UninstallConnectorDialog
          installed={installed}
          open={confirmingUninstall}
          onOpenChange={setConfirmingUninstall}
          // A clean uninstall leaves nothing to configure, so the page goes with
          // it. A key that outlived the connector is the one thing left to say,
          // so that case stays put and says so.
          onUninstalled={(notice) => {
            setConfirmingUninstall(false);
            if (notice) setOrphanNotice(notice);
            else navigate(listPath);
          }}
        />
      )}
    </div>
  );
}

// ── A person's plugin ───────────────────────────────────────────────

function PersonalPlugin({
  plugin,
  slug,
  wsId,
  onChanged,
}: {
  plugin: Plugin;
  slug: string;
  wsId: string;
  onChanged: () => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const { workspaces } = useWorkspaceContext();
  const [connectors, setConnectors] = useState<PersonalConnector[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // `connect:<serverName>`, or the workspace id whose grant is changing.
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmingUse, setConfirmingUse] = useState(false);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);

  const loadConnectors = useCallback(async () => {
    try {
      setConnectors((await listPersonalConnectors()).connectors);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void loadConnectors();
  }, [loadConnectors]);

  const serverNames = plugin.servers.map((s) => s.serverName);
  const mine = (connectors ?? []).filter((c) => serverNames.includes(c.serverName));
  // A plugin is used in a workspace where its servers are granted; Use here and
  // Stop grant and revoke every one of them, as the Plugins list does.
  const grantedIds = [...new Set(mine.flatMap((c) => c.grantedWorkspaces))];
  const usedIn = [
    ...workspaces.filter((w) => grantedIds.includes(w.id)),
    ...grantedIds
      .filter((id) => !workspaces.some((w) => w.id === id))
      .map((id) => ({ id, name: id })),
  ];
  const workspaceName = workspaces.find((w) => w.id === wsId)?.name ?? "this workspace";
  const name = plugin.displayName;
  const connected = pluginConnected(plugin);

  const setGrant = async (targetWsId: string, grant: boolean) => {
    for (const server of serverNames) {
      await (grant ? grantConnector : revokeConnector)(server, targetWsId);
    }
    await loadConnectors();
    onChanged();
  };

  const revoke = async (targetWsId: string) => {
    setError(null);
    setBusy(targetWsId);
    try {
      await setGrant(targetWsId, false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  // The connector record says which route Connect takes (Composio keys on its
  // connector id, DCR on the server name), so Connect waits for it.
  const connectorFor = (server: PluginServer) =>
    mine.find((c) => c.serverName === server.serverName);

  const connect = async (connector: PersonalConnector) => {
    setError(null);
    setBusy(`connect:${connector.serverName}`);
    try {
      const url = await personalConnectUrl(
        {
          auth: connector.auth,
          serverName: connector.serverName,
          connectorId: connector.connectorId,
        },
        shellPath(location),
      );
      // The redirect leaves the page, so the button stays busy until it does.
      if (url) {
        window.location.assign(url);
        return;
      }
      // Connected without an interactive flow: read the new state in place.
      onChanged();
      setBusy(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  };

  return (
    <div className="space-y-8">
      <section className="space-y-5">
        <div className="flex items-center gap-4">
          <ConnectorIcon
            name={name}
            iconUrl={plugin.iconUrl}
            className="h-12 w-12 rounded-sm text-base"
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-xl font-semibold tracking-tight">{name}</h1>
              <PersonalStatus plugin={plugin} />
            </div>
            <PluginMeta plugin={plugin} slug={slug} />
          </div>
        </div>
        {plugin.servers
          .filter((s) => s.status !== "ready")
          .map((server) => {
            const connector = connectorFor(server);
            return (
              <div
                key={server.serverName}
                className="flex items-start justify-between gap-4 rounded-sm border border-border/60 bg-muted/20 px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium">{statusLabel(server.status)}</div>
                  {server.statusReason && (
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {server.statusReason}
                    </div>
                  )}
                </div>
                <Button
                  type="button"
                  size="sm"
                  className="shrink-0"
                  disabled={!connector || busy === `connect:${server.serverName}`}
                  onClick={() => connector && void connect(connector)}
                >
                  {busy === `connect:${server.serverName}` ? "Connecting…" : "Connect"}
                </Button>
              </div>
            );
          })}
      </section>

      {error && <InlineError message={error} />}

      <div className="divide-y divide-border/60 [&>*]:py-6 [&>*:first-child]:pt-0 [&>*:last-child]:pb-0">
        <section className="flex items-start justify-between gap-4" data-testid="plugin-here">
          <PanelHeading
            title="In this workspace"
            hint={
              !plugin.granted
                ? `Your agent can't use ${name} in ${workspaceName} until you turn it on.`
                : connected
                  ? "On here. Only you can use it; other members can't."
                  : `On here. Connect to sign in to ${name} so your agent can use it.`
            }
          />
          {plugin.granted ? (
            <div className="flex shrink-0 items-center gap-1.5">
              {connected && (
                <span className="px-2 text-xs text-muted-foreground" data-testid="plugin-in-use">
                  In use here
                </span>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy === wsId}
                onClick={() => void revoke(wsId)}
              >
                {busy === wsId ? "Stopping…" : "Stop using here"}
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              size="sm"
              className="shrink-0"
              // Signing in follows the connector's record, so wait for it.
              disabled={!connected && connectors === null}
              onClick={() => {
                setError(null);
                setConfirmingUse(true);
              }}
            >
              Use here
            </Button>
          )}
        </section>

        <section className="space-y-3" data-testid="plugin-used-in">
          <PanelHeading
            title="Used in"
            hint={`Your agent can use ${name} only in workspaces where it is on.`}
          />
          {connectors === null ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : usedIn.length === 0 ? (
            <p className="text-xs text-muted-foreground">Not on in any workspace.</p>
          ) : (
            <ul className="border-t border-border/60">
              {usedIn.map((ws) => (
                <li
                  key={ws.id}
                  className="flex items-center justify-between gap-4 border-b border-border/60 py-2.5 last:border-b-0 last:pb-0"
                  data-testid="plugin-used-in-row"
                >
                  <Link
                    to={`/w/${toSlug(ws.id)}/plugins`}
                    className="truncate text-sm underline-offset-4 hover:underline"
                  >
                    {ws.name}
                  </Link>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy === ws.id}
                    onClick={() => void revoke(ws.id)}
                    aria-label={`Stop using ${name} in ${ws.name}`}
                  >
                    {busy === ws.id ? "Stopping…" : "Stop using"}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {plugin.servers.map((server) => (
          <PersonalToolPermissionsSection
            key={server.serverName}
            serverName={server.serverName}
            name={name}
            connected={server.status === "ready"}
          />
        ))}

        <section className="flex items-center justify-between gap-4">
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
        </section>
      </div>

      <UsePluginHereDialog
        plugin={confirmingUse ? plugin : null}
        workspaceName={workspaceName}
        onClose={() => setConfirmingUse(false)}
        onConfirm={async () => {
          await setGrant(wsId, true);
          // On here with no account behind it: sign in next. The redirect leaves
          // the page, so the dialog stays as it is until it does.
          if (
            !connected &&
            (await startPluginSignIn(plugin, mine, shellPath(location))) === "redirected"
          ) {
            return;
          }
          setConfirmingUse(false);
        }}
      />
      <ConfirmDialog
        open={confirmingDisconnect}
        onOpenChange={setConfirmingDisconnect}
        title={`Disconnect ${name}?`}
        description={disconnectConsequence(usedIn.length)}
        confirmLabel="Disconnect"
        pendingLabel="Disconnecting…"
        destructive
        onConfirm={async () => {
          for (const server of serverNames) await disconnectPersonalConnector(server);
          setConfirmingDisconnect(false);
          // It is gone from the account, so there is nothing left to show here.
          navigate(`/w/${slug}/plugins`);
        }}
      />
    </div>
  );
}

/** What is true of a person's plugin now, beside its name. */
function PersonalStatus({ plugin }: { plugin: Plugin }) {
  const ready = plugin.servers.every((s) => s.status === "ready");
  const account = pluginAccount(plugin);
  const notReady = plugin.servers.find((s) => s.status !== "ready");
  const label = ready
    ? account
      ? `Connected as ${account}`
      : "Connected"
    : statusLabel(notReady?.status ?? "not_connected");
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
      data-testid="plugin-status"
    >
      <span
        aria-hidden
        className={cn(
          "h-2 w-2 shrink-0 rounded-full",
          ready ? "bg-emerald-500" : "bg-muted-foreground/50",
        )}
      />
      {label}
    </span>
  );
}

// ── The settings page's old address ─────────────────────────────────

/**
 * `/w/:slug/settings/connectors/:serverName`, where a workspace connector was
 * configured before Plugins. It sends a bookmark on to the plugin that holds
 * that connector, found in the listing by its server, or to Plugins when no
 * workspace plugin does.
 */
export function ConnectorPageRedirect() {
  const { slug = "", serverName = "" } = useParams<{ slug: string; serverName: string }>();
  const [target, setTarget] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fallback = `/w/${slug}/plugins`;
    listPlugins(toWsId(slug))
      .then(({ plugins }) => {
        if (cancelled) return;
        const plugin = plugins.find(
          (p) => p.owner.kind === "workspace" && p.servers.some((s) => s.serverName === serverName),
        );
        setTarget(plugin ? pluginPath(slug, plugin) : fallback);
      })
      .catch(() => {
        if (!cancelled) setTarget(fallback);
      });
    return () => {
      cancelled = true;
    };
  }, [slug, serverName]);

  if (!target) return <p className="text-sm text-muted-foreground">Loading…</p>;
  return <Navigate to={target} replace />;
}
