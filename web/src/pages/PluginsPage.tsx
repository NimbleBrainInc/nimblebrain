import { Check, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { Plugin, PluginsListOutput } from "../_generated/platform-schemas/plugins";
import {
  disconnectPersonalConnector,
  grantConnector,
  listPersonalConnectors,
  listPlugins,
  type PersonalConnector,
  revokeConnector,
} from "../api/client";
import { ConnectorIcon } from "../components/connectors/ConnectorIcon";
import { connectorStatusSummary } from "../components/connectors/ConnectorList";
import {
  disconnectConsequence,
  startPluginSignIn,
} from "../components/connectors/personal-connector";
import {
  type ConnectedTarget,
  type ReturnedConnector,
  useConnectedNotice,
} from "../components/connectors/useConnectedNotice";
import {
  HEADER_ACTION,
  HEADER_ACTION_LABEL,
  ListEmpty,
  ListPageHeader,
  ROW_LINK,
  ROW_TEXT,
  RowMenu,
  type RowMenuItem,
  SegmentBar,
} from "../components/plugins/list-parts";
import { StopUsingDialog } from "../components/plugins/StopUsingDialog";
import { UsePluginHereDialog } from "../components/plugins/UsePluginHereDialog";
import { Button } from "../components/ui/button";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { useWorkspaceContext } from "../context/WorkspaceContext";
import { useEvents } from "../hooks/useEvents";
import { useCanWriteActiveWorkspace } from "../hooks/useScopedRole";
import {
  type AttentionStep,
  attentionLabel,
  attentionReason,
  buildPluginsModel,
  defaultSegment,
  pluginAttention,
  type Segment,
} from "../lib/plugin-lists";
import { accountLine, browsePluginsPath, pluginConnected, pluginPath } from "../lib/plugins";
import { cn } from "../lib/utils";
import { toWsId } from "../lib/workspace-slug";
import { EmptyState, InlineError } from "./settings/components";

/**
 * Plugins — the plugins installed for this workspace's agent. Adding one is
 * its own page, Browse plugins (`PluginsBrowsePage`); skills are on Skills.
 *
 * **Workspace** lists the workspace's plugins, which act for everyone here.
 * **Personal** lists the viewer's own, on here or not; one not on here offers
 * Use here. A row names the plugin and the account it uses, offers only the
 * next step when there is one, and opens the plugin's page; the rest is in its
 * ⋯ menu. A line above the list says when something in the segment needs the
 * viewer: with one, it carries that plugin's action, and the plugin's row says
 * what is wrong instead, so the action is offered once; with more, it filters
 * the list to them.
 *
 * One column, because this renders in the main area beside the docked chat
 * (`web/DESIGN.md`).
 */
export function PluginsPage() {
  const { slug = "" } = useParams<{ slug: string }>();
  const wsId = toWsId(slug);
  const navigate = useNavigate();
  const [params] = useSearchParams();

  // Browse was a tab of this page; its address still lands there.
  if (params.get("tab") === "browse") {
    const rest = new URLSearchParams(params);
    rest.delete("tab");
    const query = rest.toString();
    return <Navigate to={`${browsePluginsPath(slug)}${query ? `?${query}` : ""}`} replace />;
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-(--page-gutter) py-6 space-y-5">
        <ListPageHeader
          title="Plugins"
          action={
            <Button
              type="button"
              size="sm"
              className={HEADER_ACTION}
              aria-label="Browse plugins"
              onClick={() => navigate(browsePluginsPath(slug))}
              data-testid="plugins-browse"
            >
              <Plus aria-hidden />
              <span className={HEADER_ACTION_LABEL}>Browse plugins</span>
            </Button>
          }
        />
        <InstalledPlugins key={wsId} wsId={wsId} slug={slug} />
      </div>
    </div>
  );
}

function InstalledPlugins({ wsId, slug }: { wsId: string; slug: string }) {
  const navigate = useNavigate();
  const { workspaces } = useWorkspaceContext();
  const workspaceName = workspaces.find((w) => w.id === wsId)?.name ?? "this workspace";
  // Signing in a workspace plugin writes the workspace; granting your own
  // plugin does not, so only that affordance is gated.
  const canManage = useCanWriteActiveWorkspace();
  const [listing, setListing] = useState<PluginsListOutput | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [chosenSegment, setChosenSegment] = useState<Segment | null>(null);
  const [query, setQuery] = useState("");
  const [needsOnly, setNeedsOnly] = useState(false);
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
    return () => {
      signal.cancelled = true;
    };
  }, [refresh]);

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

  // A sign-in finishing elsewhere changes a row's status and account; a plugin
  // turned on or off from another tab or the chat changes where it is on.
  useEvents({
    onConnectionStateChanged: () => void refresh(),
    onConnectorGrantChanged: () => {
      void refresh();
      void loadConnectors();
    },
  });

  const plugins = listing && listing.wsId === wsId ? listing.plugins : null;

  // Confirm the connector an OAuth sign-in just connected (`?connected=`): a
  // notice, and its plugin's row marked while the page is open.
  const rereadSilently = useCallback(() => void refresh(), [refresh]);
  const returned = useMemo(() => plugins?.flatMap(toReturnedConnectors) ?? null, [plugins]);
  const justConnected = useConnectedNotice(returned, rereadSilently);

  // Until the viewer picks one, the segment is Workspace, unless only Personal
  // has anything or a sign-in just returned to one of the viewer's own.
  const counts = useMemo(
    () =>
      plugins
        ? buildPluginsModel(plugins, { segment: "workspace", query: "", canManage }).counts
        : null,
    [plugins, canManage],
  );
  const segment: Segment =
    chosenSegment ?? defaultSegment(counts, justConnected?.owner === "person");

  const model = useMemo(
    () => (plugins ? buildPluginsModel(plugins, { segment, query, needsOnly, canManage }) : null),
    [plugins, segment, query, needsOnly, canManage],
  );

  // A filter to what needs the viewer ends once nothing does.
  const needsCount = model?.needsYou.length ?? 0;
  useEffect(() => {
    if (needsOnly && needsCount === 0) setNeedsOnly(false);
  }, [needsOnly, needsCount]);

  const chooseSegment = (next: Segment) => {
    setChosenSegment(next);
    setNeedsOnly(false);
  };

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
  if (!model || !plugins) return <p className="text-sm text-muted-foreground">Loading…</p>;

  // The next step a row offers: nothing for a healthy plugin.
  const nextStep = (plugin: Plugin): React.ReactNode =>
    nextStepFor(plugin, {
      canManage,
      // Signing in follows the connector's record, so a sign-in waits for it.
      recordsLoaded: connectors !== null,
      busy: busyId === plugin.id,
      onUseHere: () => {
        setActionError(null);
        setConfirming(plugin);
      },
      onConnect: () => void connectHere(plugin),
      onOpen: () => navigate(pluginPath(slug, plugin)),
    });

  const rowMenu = (plugin: Plugin): RowMenuItem[] =>
    rowMenuFor(plugin, pluginPath(slug, plugin), {
      onStop: () => setStopping(plugin),
      onDisconnect: () => setDisconnecting(plugin),
    });

  // With one plugin needing the viewer, the line above the list carries its
  // action, so its row says what is wrong instead.
  const [only] = model.needsYou;
  const actionInBanner = model.needsYou.length === 1 && only ? only.id : null;

  return (
    <div className="space-y-4">
      <SegmentBar
        segment={segment}
        onSegment={chooseSegment}
        counts={model.counts}
        query={query}
        onQuery={setQuery}
        searchLabel="Search plugins"
      />

      {actionError && <InlineError message={actionError} />}

      {model.needsYou.length > 0 && (
        <NeedsYou
          plugins={model.needsYou}
          action={only && actionInBanner ? nextStep(only) : null}
          filtered={needsOnly}
          onFilter={setNeedsOnly}
        />
      )}

      <PluginListBody
        installed={plugins.length}
        rows={model.rows}
        empty={emptyMessage(query, segment, workspaceName)}
        segment={segment}
        renderRow={(plugin) => (
          <PluginRow
            key={plugin.id}
            plugin={plugin}
            to={pluginPath(slug, plugin)}
            action={plugin.id === actionInBanner ? attentionWords(plugin) : nextStep(plugin)}
            menu={rowMenu(plugin)}
            fresh={isJustConnected(justConnected, plugin)}
          />
        )}
      />

      <UsePluginHereDialog
        plugin={confirming}
        workspaceName={workspaceName}
        onClose={() => setConfirming(null)}
        onConfirm={grantHere}
      />
      <PersonalPluginDialogs
        workspaceName={workspaceName}
        stopping={stopping}
        onStopClose={() => setStopping(null)}
        onStop={stopHere}
        disconnecting={disconnecting}
        onDisconnectClose={() => setDisconnecting(null)}
        onDisconnect={disconnect}
        grantCount={grantCount}
      />
    </div>
  );
}

/**
 * What a plugin's row offers next. A person's plugin not on here offers Use
 * here; otherwise the row offers what `pluginAttention` asks, or the status
 * words of one settling. A workspace plugin signs in on its page, where its
 * admin connects it, and a failed or unset-up one is fixed there; only a
 * person's own sign-in starts from the row.
 */
function nextStepFor(
  plugin: Plugin,
  opts: {
    canManage: boolean;
    recordsLoaded: boolean;
    busy: boolean;
    onUseHere: () => void;
    onConnect: () => void;
    onOpen: () => void;
  },
): React.ReactNode {
  if (plugin.owner.kind === "person" && !plugin.granted) {
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="@max-[40rem]/main:h-11"
        // Use here signs in when it is not connected, which needs the record.
        disabled={!pluginConnected(plugin) && !opts.recordsLoaded}
        onClick={opts.onUseHere}
        data-testid="plugin-use-here"
      >
        Use here
      </Button>
    );
  }
  const step = pluginAttention(plugin, opts);
  if (!step) return statusWords(plugin);
  const fromRow = step !== "open" && plugin.owner.kind === "person";
  return (
    <AttentionButton
      step={step}
      busy={opts.busy}
      disabled={fromRow && (opts.busy || !opts.recordsLoaded)}
      onClick={fromRow ? opts.onConnect : opts.onOpen}
    />
  );
}

/** Whether a sign-in on this page just connected this plugin, as the owner it names. */
function isJustConnected(target: ConnectedTarget | null, plugin: Plugin): boolean {
  return (
    target !== null &&
    pluginConnected(plugin) &&
    target.owner === plugin.owner.kind &&
    plugin.servers.some((s) => s.serverName === target.serverName)
  );
}

/**
 * A row's ⋯ menu: Open, and for the viewer's own plugin, Stop using here while
 * it is on here and Disconnect while it is signed in.
 */
function rowMenuFor(
  plugin: Plugin,
  to: string,
  on: { onStop: () => void; onDisconnect: () => void },
): RowMenuItem[] {
  const items: RowMenuItem[] = [{ kind: "link", label: "Open", to }];
  if (plugin.owner.kind !== "person") return items;
  if (plugin.granted) items.push({ kind: "action", label: "Stop using here", onSelect: on.onStop });
  if (pluginConnected(plugin)) {
    items.push({
      kind: "action",
      label: "Disconnect",
      destructive: true,
      onSelect: on.onDisconnect,
    });
  }
  return items;
}

/** The list: rows, or what to say when there are none. */
function PluginListBody({
  installed,
  rows,
  empty,
  segment,
  renderRow,
}: {
  /** How many plugins are installed at all. */
  installed: number;
  rows: Plugin[];
  /** What to say when the segment or search leaves none. */
  empty: string;
  segment: Segment;
  renderRow: (plugin: Plugin) => React.ReactNode;
}) {
  if (installed === 0) {
    return <EmptyState message="No plugins here yet. Browse plugins to give your agent tools." />;
  }
  if (rows.length === 0) return <ListEmpty>{empty}</ListEmpty>;
  return (
    <div data-testid="plugin-list" data-segment={segment}>
      {rows.map(renderRow)}
    </div>
  );
}

/** The confirms for Stop using here and Disconnect on the viewer's own plugin. */
function PersonalPluginDialogs({
  workspaceName,
  stopping,
  onStopClose,
  onStop,
  disconnecting,
  onDisconnectClose,
  onDisconnect,
  grantCount,
}: {
  workspaceName: string;
  stopping: Plugin | null;
  onStopClose: () => void;
  /** Throws on failure, so the confirm stays open with the error shown. */
  onStop: (plugin: Plugin) => Promise<void>;
  disconnecting: Plugin | null;
  onDisconnectClose: () => void;
  onDisconnect: (plugin: Plugin) => Promise<void>;
  /** The workspaces the plugin is on in, which Disconnect turns it off in. */
  grantCount: (plugin: Plugin) => number;
}) {
  return (
    <>
      <StopUsingDialog
        open={stopping !== null}
        onOpenChange={(open) => !open && onStopClose()}
        pluginName={stopping?.displayName ?? ""}
        workspaceName={workspaceName}
        here
        onConfirm={() => (stopping ? onStop(stopping) : undefined)}
      />
      <ConfirmDialog
        open={disconnecting !== null}
        onOpenChange={(open) => !open && onDisconnectClose()}
        title={`Disconnect ${disconnecting?.displayName ?? ""}?`}
        description={disconnectConsequence(disconnecting ? grantCount(disconnecting) : 0)}
        confirmLabel="Disconnect"
        pendingLabel="Disconnecting…"
        destructive
        onConfirm={() => (disconnecting ? onDisconnect(disconnecting) : undefined)}
      />
    </>
  );
}

/** What the list says when the segment or the search leaves nothing. */
function emptyMessage(query: string, segment: Segment, workspaceName: string): string {
  const q = query.trim();
  if (q) return `No plugins match "${q}".`;
  return segment === "workspace"
    ? `${workspaceName} has no plugins for everyone yet.`
    : "You have no plugins of your own yet. Browse plugins and choose Just me to add one.";
}

/**
 * One line above the list, only while something in the segment needs the
 * viewer. One plugin: what is wrong and its action. More: how many, and a
 * filter to just them.
 */
function NeedsYou({
  plugins,
  action,
  filtered,
  onFilter,
}: {
  plugins: Plugin[];
  action: React.ReactNode;
  filtered: boolean;
  onFilter: (next: boolean) => void;
}) {
  const [first] = plugins;
  const count = plugins.length;
  return (
    <section
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-warning/20 bg-warning/5 px-3 py-2 text-sm"
      data-testid="needs-you"
      aria-label="Needs you"
    >
      <span className="font-medium text-warning">
        {count} {count === 1 ? "needs" : "need"} you
      </span>
      {count === 1 && first ? (
        <>
          <span className="min-w-0 flex-1 text-muted-foreground" data-testid="needs-you-reason">
            {first.displayName} {attentionReason(first)}.
          </span>
          {action && <div className="shrink-0">{action}</div>}
        </>
      ) : (
        <>
          <span className="min-w-0 flex-1" />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="@max-[40rem]/main:h-11"
            aria-pressed={filtered}
            onClick={() => onFilter(!filtered)}
            data-testid="needs-you-filter"
          >
            {filtered ? "Show all" : "Show them"}
          </Button>
        </>
      )}
    </section>
  );
}

/**
 * One plugin: its icon, its name and account (one line on a wide column, two
 * on a narrow one), its next step, and its ⋯ menu. The whole row opens the
 * plugin's page.
 */
function PluginRow({
  plugin,
  to,
  action,
  menu,
  fresh,
}: {
  plugin: Plugin;
  to: string;
  action: React.ReactNode;
  menu: RowMenuItem[];
  /** A sign-in on this page just connected it. */
  fresh: boolean;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  // A long list may hold the plugin below the fold.
  useEffect(() => {
    if (fresh) rowRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [fresh]);
  const muted = plugin.owner.kind === "person" && !plugin.granted;
  const line = accountLine(plugin);

  return (
    <div
      ref={rowRef}
      className="relative flex min-h-11 items-center gap-3 border-b border-border/60 py-1.5 last:border-b-0"
      data-testid="plugin-row"
      data-plugin-id={plugin.id}
    >
      <ConnectorIcon
        name={plugin.displayName}
        iconUrl={plugin.iconUrl}
        className={cn("h-6 w-6 shrink-0 rounded text-[11px]", muted && "opacity-60")}
      />
      <div className={ROW_TEXT} data-testid="row-text">
        <Link
          to={to}
          data-row-link
          className={cn("min-w-0 truncate text-sm font-medium", ROW_LINK)}
        >
          {plugin.displayName}
        </Link>
        {line && (
          <span className="truncate text-xs text-muted-foreground" data-testid="plugin-account">
            {line}
          </span>
        )}
      </div>
      {fresh && (
        <span className="relative flex shrink-0 items-center gap-1.5 text-xs font-medium text-success">
          <Check className="h-3.5 w-3.5" aria-hidden />
          <span>Connected just now</span>
        </span>
      )}
      {action && (
        <div className="relative shrink-0" data-testid="plugin-action">
          {action}
        </div>
      )}
      <RowMenu name={plugin.displayName} items={menu} testId="plugin-menu" />
    </div>
  );
}

/**
 * What is wrong, on the row whose action the Needs-you line carries. Said
 * once: a reason the account line already gives ("Not signed in") is left out.
 */
function attentionWords(plugin: Plugin): React.ReactNode {
  const label = attentionLabel(plugin);
  if (!label || label === accountLine(plugin)) return null;
  return (
    <span className="px-2 text-xs text-warning" data-testid="plugin-attention">
      {label}
    </span>
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

/** The button for what a plugin asks of the viewer (`pluginAttention`). */
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
      className="@max-[40rem]/main:h-11"
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
