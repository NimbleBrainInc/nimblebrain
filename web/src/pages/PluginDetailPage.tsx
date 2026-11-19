import { useCallback, useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
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
import { useNotice } from "../components/notices";
import { SECTION_ACTION, SECTION_ROW } from "../components/plugins/list-parts";
import { StopUsingDialog } from "../components/plugins/StopUsingDialog";
import { UsePluginHereDialog } from "../components/plugins/UsePluginHereDialog";
import { Button } from "../components/ui/button";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { useWorkspaceContext } from "../context/WorkspaceContext";
import { useEvents } from "../hooks/useEvents";
import { useCanWriteActiveWorkspace } from "../hooks/useScopedRole";
import {
  ownerLine,
  pluginAccount,
  pluginConnected,
  pluginPath,
  workspacePluginForServer,
} from "../lib/plugins";
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
 *   every workspace the person belongs to, each on or off with the change that
 *   flips it. Use here signs in too when it is not connected, and every
 *   sign-in returns to this workspace's Plugins. Turning it on elsewhere only
 *   grants it: no workspace is on by default, and the owner decides each one.
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
          className="block w-fit py-1 text-xs text-muted-foreground hover:underline"
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

  // A sign-in finishing elsewhere changes the plugin's status and account; a
  // grant changed from another tab or the chat changes whether it is on here.
  useEvents({
    onConnectionStateChanged: () => void refresh(),
    onConnectorGrantChanged: () => void refresh(),
  });

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
  const { workspaces } = useWorkspaceContext();
  const [connectors, setConnectors] = useState<PersonalConnector[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const notify = useNotice();
  // `connect:<serverName>` while a sign-in starts.
  const [busy, setBusy] = useState<string | null>(null);
  // The state each workspace whose grant is changing is moving to, shown until
  // the change lands or fails.
  const [pending, setPending] = useState<Record<string, boolean>>({});
  // The workspace a Use or a Stop using is being confirmed for.
  const [using, setUsing] = useState<WorkspaceRef | null>(null);
  const [stopping, setStopping] = useState<WorkspaceRef | null>(null);
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
  // The Workspaces list reads each grant from the connector records.
  useEvents({ onConnectorGrantChanged: () => void loadConnectors() });

  const serverNames = plugin.servers.map((s) => s.serverName);
  const mine = (connectors ?? []).filter((c) => serverNames.includes(c.serverName));
  // A plugin is used in a workspace where its servers are granted; Use here and
  // Stop grant and revoke every one of them, as the Plugins list does.
  const grantedIds = [...new Set(mine.flatMap((c) => c.grantedWorkspaces))];
  const workspaceName = workspaces.find((w) => w.id === wsId)?.name ?? "this workspace";
  const here: WorkspaceRef = { id: wsId, name: workspaceName };
  // Every workspace the person belongs to, this one first, then any it is
  // granted to that the list does not hold, so each grant can still be revoked.
  const rows: WorkspaceRef[] = [
    here,
    ...workspaces.filter((w) => w.id !== wsId).map((w) => ({ id: w.id, name: w.name })),
    ...grantedIds
      .filter((id) => id !== wsId && !workspaces.some((w) => w.id === id))
      .map((id) => ({ id, name: id })),
  ];
  const isOn = (id: string) =>
    pending[id] ?? (id === wsId ? plugin.granted : grantedIds.includes(id));
  const name = plugin.displayName;
  const connected = pluginConnected(plugin);

  const setGrant = async (targetWsId: string, grant: boolean) => {
    for (const server of serverNames) {
      await (grant ? grantConnector : revokeConnector)(server, targetWsId);
    }
    await loadConnectors();
    onChanged();
  };

  // Shows the new state at once and says when it lands; a failure puts the
  // row back as it was and says why.
  const change = async (ws: WorkspaceRef, on: boolean) => {
    setError(null);
    setPending((p) => ({ ...p, [ws.id]: on }));
    try {
      await setGrant(ws.id, on);
      notify({
        level: "success",
        title: `${name} is ${on ? "on" : "off"} in ${ws.name}`,
        description:
          on && !connected ? `Sign in to ${name} so your agent can use it there.` : undefined,
      });
    } catch (err) {
      notify({
        level: "error",
        title: `Couldn't turn ${name} ${on ? "on" : "off"} in ${ws.name}`,
        description: err instanceof Error ? err.message : String(err),
      });
      await loadConnectors();
      onChanged();
    } finally {
      setPending(({ [ws.id]: _, ...rest }) => rest);
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
        wsId,
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
                className={cn(
                  SECTION_ROW,
                  "rounded-sm border border-border/60 bg-muted/20 px-4 py-3",
                )}
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
                  className={cn("shrink-0", SECTION_ACTION)}
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
        <HereSection
          name={name}
          workspaceName={workspaceName}
          on={isOn(wsId)}
          changing={wsId in pending}
          connected={connected}
          // Signing in follows the connector's record, so Use here waits for it.
          ready={connected || connectors !== null}
          onUse={() => {
            setError(null);
            setUsing(here);
          }}
          onStop={() => setStopping(here)}
        />

        <section className="space-y-3" data-testid="plugin-workspaces">
          <PanelHeading
            title="Workspaces"
            hint={`Your agent can use ${name} only in workspaces where you turn it on.`}
          />
          {connectors === null ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : (
            <ul className="border-t border-border/60">
              {rows.map((ws) => (
                <WorkspaceRow
                  key={ws.id}
                  pluginName={name}
                  workspace={ws}
                  current={ws.id === wsId}
                  on={isOn(ws.id)}
                  changing={ws.id in pending}
                  connected={connected}
                  onUse={() => {
                    setError(null);
                    setUsing(ws);
                  }}
                  onStop={() => setStopping(ws)}
                />
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

        <section className={cn(SECTION_ROW, "@min-[40rem]/main:items-center")}>
          <p className="text-xs text-muted-foreground">
            Sign out of {name} and remove it from your account.
          </p>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            className={SECTION_ACTION}
            onClick={() => setConfirmingDisconnect(true)}
          >
            Disconnect
          </Button>
        </section>
      </div>

      <UsePluginHereDialog
        plugin={using ? plugin : null}
        workspaceName={using?.name ?? ""}
        here={using?.id === wsId}
        onClose={() => setUsing(null)}
        onConfirm={async () => {
          if (!using) return;
          // On here with no account behind it: turn it on, then sign in. The
          // redirect leaves the page, so the dialog stays as it is until it
          // does, and a failure stays in it.
          if (using.id === wsId && !connected) {
            await setGrant(wsId, true);
            if ((await startPluginSignIn(plugin, mine, { workspaceId: wsId })) === "redirected") {
              return;
            }
            setUsing(null);
            return;
          }
          setUsing(null);
          void change(using, true);
        }}
      />
      <StopUsingDialog
        open={stopping !== null}
        onOpenChange={(open) => !open && setStopping(null)}
        pluginName={name}
        workspaceName={stopping?.name ?? ""}
        here={stopping?.id === wsId}
        onConfirm={() => {
          if (!stopping) return;
          setStopping(null);
          void change(stopping, false);
        }}
      />
      <ConfirmDialog
        open={confirmingDisconnect}
        onOpenChange={setConfirmingDisconnect}
        title={`Disconnect ${name}?`}
        description={disconnectConsequence(grantedIds.length)}
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

/** Whether a person's plugin is on in the workspace the page is in, and the change that flips it. */
function HereSection({
  name,
  workspaceName,
  on,
  changing,
  connected,
  ready,
  onUse,
  onStop,
}: {
  name: string;
  workspaceName: string;
  on: boolean;
  /** A change to this workspace's grant is in flight; `on` is where it is going. */
  changing: boolean;
  connected: boolean;
  /** Use here can start: the plugin is signed in, or its record is loaded. */
  ready: boolean;
  onUse: () => void;
  onStop: () => void;
}) {
  return (
    <section className={SECTION_ROW} data-testid="plugin-here">
      <PanelHeading
        title="In this workspace"
        hint={
          !on
            ? `Your agent can't use ${name} in ${workspaceName} until you turn it on.`
            : connected
              ? "On here. Only you can use it; other members can't."
              : `On here. Connect to sign in to ${name} so your agent can use it.`
        }
      />
      {on ? (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {connected && (
            <span className="px-2 text-xs text-muted-foreground" data-testid="plugin-in-use">
              In use here
            </span>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={SECTION_ACTION}
            disabled={changing}
            onClick={onStop}
          >
            {changing ? "Turning on…" : "Stop using here"}
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          size="sm"
          className={cn("shrink-0", SECTION_ACTION)}
          disabled={!ready || changing}
          onClick={onUse}
        >
          {changing ? "Stopping…" : "Use here"}
        </Button>
      )}
    </section>
  );
}

interface WorkspaceRef {
  id: string;
  name: string;
}

/**
 * One workspace on a person's plugin's page: whether the plugin is on there,
 * and the change that flips it, each confirmed first. A row wraps its action
 * beneath its name on a narrow column, where the action is 44px tall.
 */
function WorkspaceRow({
  pluginName,
  workspace,
  current,
  on,
  changing,
  connected,
  onUse,
  onStop,
}: {
  pluginName: string;
  workspace: WorkspaceRef;
  /** The workspace the page is in. */
  current: boolean;
  on: boolean;
  /** A change to this workspace's grant is in flight. */
  changing: boolean;
  connected: boolean;
  onUse: () => void;
  onStop: () => void;
}) {
  // While a change is in flight the row already shows where it is going, and
  // its disabled action says it is on the way.
  const state = on ? (connected ? "On" : "On · Not signed in") : "Off";
  return (
    <li
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border/60 py-2.5 last:border-b-0 last:pb-0"
      data-testid="plugin-workspace-row"
      data-on={on}
    >
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <Link
            to={`/w/${toSlug(workspace.id)}/plugins`}
            className="truncate text-sm underline-offset-4 hover:underline"
          >
            {workspace.name}
          </Link>
          {current && (
            <span className="text-xs text-muted-foreground" data-testid="plugin-workspace-current">
              This workspace
            </span>
          )}
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground" data-testid="plugin-workspace-state">
          {state}
        </div>
      </div>
      {on ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="shrink-0 @max-[40rem]/main:min-h-11"
          disabled={changing}
          onClick={onStop}
          aria-label={`Stop using ${pluginName} in ${workspace.name}`}
        >
          {changing ? "Turning on…" : "Stop using"}
        </Button>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="max-w-full shrink-0 @max-[40rem]/main:min-h-11"
          disabled={changing}
          onClick={onUse}
          aria-label={`Use ${pluginName} in ${workspace.name}`}
        >
          <span className="truncate">{changing ? "Stopping…" : `Use in ${workspace.name}`}</span>
        </Button>
      )}
    </li>
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
        const plugin = workspacePluginForServer(plugins, serverName);
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
