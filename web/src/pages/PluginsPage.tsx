import { Menu } from "@base-ui/react/menu";
import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { Plugin, PluginsListOutput } from "../_generated/platform-schemas/plugins";
import {
  disconnectPersonalConnector,
  grantConnector,
  listPersonalConnectors,
  listPlugins,
  type PersonalConnector,
  revokeConnector,
} from "../api/client";
import { connectorStatusSummary } from "../components/connectors/ConnectorList";
import {
  disconnectConsequence,
  startPluginSignIn,
} from "../components/connectors/personal-connector";
import {
  type ReturnedConnector,
  useConnectedNotice,
} from "../components/connectors/useConnectedNotice";
import { InstalledView, type RowMenuItem } from "../components/plugins/InstalledView";
import { UsePluginHereDialog } from "../components/plugins/UsePluginHereDialog";
import { Button } from "../components/ui/button";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { useWorkspaceContext } from "../context/WorkspaceContext";
import { useEvents } from "../hooks/useEvents";
import { useCanWriteActiveWorkspace } from "../hooks/useScopedRole";
import { type AuthoredSkill, listAuthoredSkills } from "../lib/authored-skills";
import {
  type AttentionStep,
  buildInstalledModel,
  type InstalledFilters,
  pluginAttention,
} from "../lib/installed-view";
import { newSkillPath, pluginConnected, pluginPath, skillPath } from "../lib/plugins";
import { cn } from "../lib/utils";
import { toWsId } from "../lib/workspace-slug";
import { ConnectorDirectory } from "./settings/ConnectorBrowsePage";
import { EmptyState, InlineError } from "./settings/components";

/**
 * Plugins — what the agent can do in this workspace, in one place.
 *
 * Installed arranges, for a listing of any length (`InstalledView`), what the
 * agent can use here by who it acts for: **Shared** (the workspace's plugins,
 * its skills, and the org's), **Just you** (the viewer's plugins granted here
 * and their own skills), and **Yours, not on here**. Plugins whose next step is
 * an action are also gathered at the top under **Needs you**. A row names the
 * plugin and the account it uses, offers only what needs the viewer, and opens
 * the plugin's page; the rest is in its ⋯ menu. Whose a plugin is reads from
 * the facts the listing carries (ADR-0069).
 *
 * Browse offers writing a skill above the connector directory, which asks
 * whom an install is for: the viewer alone (granted here in the same act) or
 * everyone in the workspace.
 *
 * One column, because this renders in the main area beside the docked chat
 * (`web/DESIGN.md`).
 */
export function PluginsPage() {
  const { slug = "" } = useParams<{ slug: string }>();
  const wsId = toWsId(slug);
  const navigate = useNavigate();
  const { workspaces } = useWorkspaceContext();
  const workspaceName = workspaces.find((w) => w.id === wsId)?.name ?? "this workspace";
  const [params, setParams] = useSearchParams();
  const tab: PluginsTab = params.get("tab") === "browse" ? "browse" : "installed";
  const showTab = (next: PluginsTab) =>
    setParams(next === "browse" ? { tab: "browse" } : {}, { replace: true });

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-(--page-gutter) py-6 space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">Plugins</h1>
            <p className="text-sm text-muted-foreground mt-1">
              What your agent can do in {workspaceName}.
            </p>
          </div>
          {tab === "installed" && (
            <div className="flex shrink-0 gap-2" data-testid="plugins-header-actions">
              <Button type="button" variant="outline" size="sm" onClick={() => showTab("browse")}>
                Browse directory
              </Button>
              <AddMenu
                onPlugin={() => showTab("browse")}
                onSkill={() => navigate(newSkillPath(slug))}
              />
            </div>
          )}
        </div>

        <div role="tablist" aria-label="Plugins" className="flex gap-4 border-b border-border">
          <TabButton selected={tab === "installed"} onSelect={() => showTab("installed")}>
            Installed
          </TabButton>
          <TabButton selected={tab === "browse"} onSelect={() => showTab("browse")}>
            Browse
          </TabButton>
        </div>

        {tab === "installed" ? (
          <InstalledPlugins
            key={wsId}
            wsId={wsId}
            slug={slug}
            workspaceName={workspaceName}
            onBrowse={() => showTab("browse")}
          />
        ) : (
          <Browse slug={slug} />
        )}
      </div>
    </div>
  );
}

type PluginsTab = "installed" | "browse";

/** Add ▾: a plugin from the directory, or a skill written here. */
function AddMenu({ onPlugin, onSkill }: { onPlugin: () => void; onSkill: () => void }) {
  const itemClass =
    "flex w-full cursor-default items-center px-3 py-1.5 text-sm outline-none data-[highlighted]:bg-foreground/5";
  return (
    <Menu.Root>
      <Menu.Trigger
        render={<Button type="button" size="sm" data-testid="plugins-add" />}
        className="gap-1"
      >
        Add
        <ChevronDown className="h-3.5 w-3.5" aria-hidden />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="end" sideOffset={4} className="z-50">
          <Menu.Popup
            data-testid="plugins-add-popup"
            className="min-w-48 rounded-sm border bg-popover py-1 text-popover-foreground shadow-md outline-none"
          >
            <Menu.Item className={itemClass} onClick={onPlugin}>
              Plugin from the directory
            </Menu.Item>
            <Menu.Item className={itemClass} onClick={onSkill}>
              Write a skill
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/**
 * Browse: writing a skill, then the plugin directory. A skill written here is
 * not a plugin (ADR-0068), so it is its own entry above the directory rather
 * than a card in it. Room is left below it for a skills registry to browse.
 */
function Browse({ slug }: { slug: string }) {
  const navigate = useNavigate();
  return (
    <div className="space-y-6">
      <div
        className="flex items-center justify-between gap-4 rounded-md border border-border px-4 py-3"
        data-testid="write-skill"
      >
        <div className="min-w-0">
          <p className="text-sm font-medium">Skills</p>
          <p className="text-xs text-muted-foreground">
            Teach the agent how you work, in your own words, for just you or everyone here.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => navigate(newSkillPath(slug))}
        >
          Write a skill
        </Button>
      </div>
      <ConnectorDirectory offerPersonal />
    </div>
  );
}

function TabButton({
  selected,
  onSelect,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onSelect}
      className={cn(
        "-mb-px border-b-2 px-1 pb-2 text-sm transition-colors",
        selected
          ? "border-foreground font-medium text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

const NO_FILTERS: InstalledFilters = { query: "", kind: "all", owner: "everyone" };

function InstalledPlugins({
  wsId,
  slug,
  workspaceName,
  onBrowse,
}: {
  wsId: string;
  slug: string;
  workspaceName: string;
  onBrowse: () => void;
}) {
  const navigate = useNavigate();
  // Installing and signing in a workspace plugin write the workspace; granting
  // your own plugin does not, so only those affordances are gated.
  const canManage = useCanWriteActiveWorkspace();
  const [listing, setListing] = useState<PluginsListOutput | null>(null);
  const [skills, setSkills] = useState<AuthoredSkill[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [filters, setFilters] = useState<InstalledFilters>(NO_FILTERS);
  const [confirming, setConfirming] = useState<Plugin | null>(null);
  const [stopping, setStopping] = useState<Plugin | null>(null);
  const [disconnecting, setDisconnecting] = useState<Plugin | null>(null);
  // The viewer's connector records, which say which route each sign-in takes
  // and where each plugin is on. An action that signs in waits for them rather
  // than guess the route.
  const [connectors, setConnectors] = useState<PersonalConnector[] | null>(null);

  const refresh = useCallback(
    async (signal?: { cancelled: boolean }) => {
      try {
        const next = await listPlugins(wsId);
        if (signal?.cancelled) return;
        setListing(next);
        setLoadError(null);
      } catch (err) {
        if (signal?.cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      }
    },
    [wsId],
  );

  useEffect(() => {
    const signal = { cancelled: false };
    void refresh(signal);
    listAuthoredSkills(wsId).then(
      (next) => {
        if (!signal.cancelled) setSkills(next);
      },
      (err: unknown) => {
        if (signal.cancelled) return;
        setSkillsError(err instanceof Error ? err.message : String(err));
        setSkills([]);
      },
    );
    return () => {
      signal.cancelled = true;
    };
  }, [refresh, wsId]);

  const loadConnectors = useCallback(async (signal?: { cancelled: boolean }) => {
    try {
      const { connectors: mine } = await listPersonalConnectors();
      if (!signal?.cancelled) setConnectors(mine);
    } catch (err) {
      if (!signal?.cancelled) setActionError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    const signal = { cancelled: false };
    void loadConnectors(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [loadConnectors]);

  // A sign-in finishing elsewhere changes a row's status and account.
  useEvents({ onConnectionStateChanged: () => void refresh() });

  const plugins = listing && listing.wsId === wsId ? listing.plugins : null;

  // Confirm the connector an OAuth sign-in just connected (`?connected=`): a
  // notice, and its plugin's row marked while the page is open.
  const rereadSilently = useCallback(() => void refresh(), [refresh]);
  const returned = useMemo(() => plugins?.flatMap(toReturnedConnectors) ?? null, [plugins]);
  const justConnected = useConnectedNotice(returned, rereadSilently);

  const model = useMemo(
    () => (plugins && skills ? buildInstalledModel(plugins, skills, filters, { canManage }) : null),
    [plugins, skills, filters, canManage],
  );

  // Turn it on here, then sign in when it has no account behind it. The grant
  // needs only the install, so it stands across the sign-in's round trip. The
  // redirect leaves the page, so the dialog stays as it is until it does.
  const grantHere = async (plugin: Plugin) => {
    for (const server of plugin.servers) await grantConnector(server.serverName, wsId);
    if (!pluginConnected(plugin)) {
      const signedIn = await startPluginSignIn(plugin, connectors ?? [], { workspaceId: wsId });
      if (signedIn === "redirected") return;
    }
    await refresh();
    setConfirming(null);
  };

  const connectHere = async (plugin: Plugin) => {
    setActionError(null);
    setBusyId(plugin.id);
    try {
      // The redirect leaves the page, so the row stays busy until it does.
      const signedIn = await startPluginSignIn(plugin, connectors ?? [], { workspaceId: wsId });
      if (signedIn === "redirected") return;
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
    setBusyId(null);
  };

  // Both throw on failure, so the confirm stays open with the error shown.
  const stopHere = async (plugin: Plugin) => {
    for (const server of plugin.servers) await revokeConnector(server.serverName, wsId);
    await refresh();
    setStopping(null);
  };

  const disconnect = async (plugin: Plugin) => {
    for (const server of plugin.servers) await disconnectPersonalConnector(server.serverName);
    await Promise.all([refresh(), loadConnectors()]);
    setDisconnecting(null);
  };

  // The workspaces a person's plugin is on in, which Disconnect turns it off in.
  const grantCount = (plugin: Plugin) => {
    const names = plugin.servers.map((s) => s.serverName);
    const ids = (connectors ?? [])
      .filter((c) => names.includes(c.serverName))
      .flatMap((c) => c.grantedWorkspaces);
    return new Set(ids).size;
  };

  if (loadError && !plugins) {
    return <InlineError message={`Unable to load plugins: ${loadError}. Reload to retry.`} />;
  }
  if (!model) return <p className="text-sm text-muted-foreground">Loading…</p>;

  // Only what needs the viewer: nothing for a healthy plugin.
  const rowAction = (plugin: Plugin): React.ReactNode => {
    if (plugin.owner.kind === "person" && !plugin.granted) {
      return (
        <Button
          type="button"
          size="sm"
          variant="outline"
          // Use here signs in when it is not connected, which needs the
          // connector's record to pick the route.
          disabled={!pluginConnected(plugin) && connectors === null}
          onClick={() => {
            setActionError(null);
            setConfirming(plugin);
          }}
          data-testid="plugin-use-here"
        >
          Use here
        </Button>
      );
    }
    const step = pluginAttention(plugin, { canManage });
    if (!step) return statusWords(plugin);
    // A workspace plugin signs in on its page, where its admin connects it, and
    // a failed or unset-up one is fixed there; only a person's own sign-in
    // starts from the row.
    const fromRow = step !== "open" && plugin.owner.kind === "person";
    const busy = busyId === plugin.id;
    return (
      <AttentionButton
        step={step}
        busy={busy}
        disabled={fromRow && (busy || connectors === null)}
        onClick={() => (fromRow ? void connectHere(plugin) : navigate(pluginPath(slug, plugin)))}
      />
    );
  };

  const rowMenu = (plugin: Plugin): RowMenuItem[] => {
    const items: RowMenuItem[] = [{ kind: "link", label: "Open", to: pluginPath(slug, plugin) }];
    if (plugin.owner.kind !== "person") return items;
    if (plugin.granted) {
      items.push({ kind: "action", label: "Stop using here", onSelect: () => setStopping(plugin) });
    }
    if (pluginConnected(plugin)) {
      items.push({
        kind: "action",
        label: "Disconnect",
        destructive: true,
        onSelect: () => setDisconnecting(plugin),
      });
    }
    return items;
  };

  const total = (plugins?.length ?? 0) + (skills?.length ?? 0);

  return (
    <div className="space-y-4">
      {actionError && <InlineError message={actionError} />}
      {skillsError && <InlineError message={`Unable to load skills: ${skillsError}`} />}

      <InstalledView
        model={model}
        filters={filters}
        onFiltersChange={setFilters}
        workspaceName={workspaceName}
        total={total}
        pluginTo={(plugin) => pluginPath(slug, plugin)}
        skillTo={(skill) => skillPath(slug, skill.scope, skill.name)}
        rowAction={rowAction}
        rowMenu={rowMenu}
        justConnected={(plugin) =>
          justConnected !== null &&
          pluginConnected(plugin) &&
          justConnected.owner === plugin.owner.kind &&
          plugin.servers.some((s) => s.serverName === justConnected.serverName)
        }
        emptyState={
          <EmptyState
            message="Nothing is installed here yet. Add a plugin to give your agent tools, or write a skill to teach it how you work."
            action={
              <div className="flex gap-2">
                {canManage && (
                  <Button type="button" variant="outline" size="sm" onClick={onBrowse}>
                    Browse plugins
                  </Button>
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => navigate(newSkillPath(slug))}
                >
                  Write a skill
                </Button>
              </div>
            }
          />
        }
      />

      <UsePluginHereDialog
        plugin={confirming}
        workspaceName={workspaceName}
        onClose={() => setConfirming(null)}
        onConfirm={grantHere}
      />
      <ConfirmDialog
        open={stopping !== null}
        onOpenChange={(open) => !open && setStopping(null)}
        title={`Stop using ${stopping?.displayName ?? ""} here?`}
        description={`Your agent can't use it in ${workspaceName} until you turn it back on. It stays connected to your account.`}
        confirmLabel="Stop using here"
        pendingLabel="Stopping…"
        onConfirm={() => (stopping ? stopHere(stopping) : undefined)}
      />
      <ConfirmDialog
        open={disconnecting !== null}
        onOpenChange={(open) => !open && setDisconnecting(null)}
        title={`Disconnect ${disconnecting?.displayName ?? ""}?`}
        description={disconnectConsequence(disconnecting ? grantCount(disconnecting) : 0)}
        confirmLabel="Disconnect"
        pendingLabel="Disconnecting…"
        destructive
        onConfirm={() => (disconnecting ? disconnect(disconnecting) : undefined)}
      />
    </div>
  );
}

/**
 * A plugin that is not ready but asks the viewer nothing (settling, or a
 * workspace sign-in only its admin does) reads the connector list's status
 * words; a ready one shows nothing.
 */
function statusWords(plugin: Plugin): React.ReactNode {
  const notReady = plugin.servers.find((s) => s.status !== "ready");
  const status = notReady ? connectorStatusSummary(notReady.status) : null;
  if (!status) return null;
  return (
    <span
      className={cn("flex items-center gap-1.5 px-2 text-xs", status.tone)}
      data-testid="plugin-status"
    >
      {status.dot && <span className={cn("h-1.5 w-1.5 rounded-full", status.dotColor)} />}
      <span>{status.label}</span>
    </span>
  );
}

/** The button for what a plugin's row asks of the viewer (`pluginAttention`). */
function AttentionButton({
  step,
  busy,
  disabled,
  onClick,
}: {
  step: AttentionStep;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const label = step === "connect" ? "Connect" : step === "reconnect" ? "Reconnect" : "Open";
  return (
    <Button
      type="button"
      size="sm"
      variant={step === "connect" ? "default" : "secondary"}
      disabled={disabled}
      onClick={onClick}
      data-testid={`plugin-${step}`}
    >
      {busy ? "Connecting…" : label}
    </Button>
  );
}

/**
 * A plugin's servers as the sign-in confirmation reads them, each named by its
 * plugin and carrying its owner: a ready server is connected, a failed one is
 * dead, anything else is still settling.
 */
function toReturnedConnectors(plugin: Plugin): ReturnedConnector[] {
  return plugin.servers.map((server) => ({
    serverName: server.serverName,
    displayName: plugin.displayName,
    owner: plugin.owner.kind,
    state:
      server.status === "ready" ? "connected" : server.status === "failed" ? "failed" : "pending",
  }));
}
