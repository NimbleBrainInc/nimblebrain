import { Check, Plus } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { Plugin, PluginsListOutput } from "../_generated/platform-schemas/plugins";
import {
  grantConnector,
  listPersonalConnectors,
  listPlugins,
  type PersonalConnector,
} from "../api/client";
import { ConnectorIcon } from "../components/connectors/ConnectorIcon";
import { connectorStatusSummary } from "../components/connectors/ConnectorList";
import { startPluginSignIn } from "../components/connectors/personal-connector";
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
  RowChevron,
  SegmentBar,
} from "../components/plugins/list-parts";
import { UsePluginHereDialog } from "../components/plugins/UsePluginHereDialog";
import { Button } from "../components/ui/button";
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
import { browsePluginsPath, pluginAccount, pluginConnected, pluginPath } from "../lib/plugins";
import { cn } from "../lib/utils";
import { toWsId } from "../lib/workspace-slug";
import { EmptyState, InlineError } from "./settings/components";

/**
 * Plugins — the plugins installed for this workspace's agent. Adding one is
 * its own page, Browse plugins (`PluginsBrowsePage`); skills are on Skills.
 *
 * **Workspace** lists the workspace's plugins, which act for everyone here.
 * **Personal** lists the viewer's own, on here or not; one not on here offers
 * Use here. A row is one link to the plugin's page, where every action is. It
 * names the plugin and what it does, and on its right offers the next step
 * when there is one, else says the plugin's state in words. A line above the
 * list says when something in the segment needs the
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

  if (loadError && !plugins) {
    return <InlineError message={`Unable to load plugins: ${loadError}. Reload to retry.`} />;
  }
  if (!model || !plugins) return <p className="text-sm text-muted-foreground">Loading…</p>;

  // The one control a row offers: nothing for a plugin that needs nothing of the viewer.
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
        renderRow={(plugin) => {
          const action = plugin.id === actionInBanner ? null : nextStep(plugin);
          return (
            <PluginRow
              key={plugin.id}
              plugin={plugin}
              to={pluginPath(slug, plugin)}
              action={action}
              state={
                plugin.id === actionInBanner
                  ? attentionWords(plugin)
                  : action
                    ? null
                    : stateWords(plugin)
              }
              fresh={isJustConnected(justConnected, plugin)}
            />
          );
        }}
      />

      <UsePluginHereDialog
        plugin={confirming}
        workspaceName={workspaceName}
        onClose={() => setConfirming(null)}
        onConfirm={grantHere}
      />
    </div>
  );
}

/**
 * The one control a plugin's row offers. A person's plugin not on here offers
 * Use here; otherwise the row offers what `pluginAttention` asks, or nothing.
 * A workspace plugin signs in on its page, where its
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
  if (!step) return null;
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
 * One plugin, as one link to its page: its icon, its name over what it does,
 * then on the right either its one control (`action`, beside the link rather
 * than inside it, so it is its own tab stop and never navigates) or its state
 * in words, and a ›. Two lines at every width; the words truncate rather than
 * wrap.
 */
function PluginRow({
  plugin,
  to,
  action,
  state,
  fresh,
}: {
  plugin: Plugin;
  to: string;
  action: React.ReactNode;
  state: React.ReactNode;
  /** A sign-in on this page just connected it. */
  fresh: boolean;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const descriptionId = useId();
  // A long list may hold the plugin below the fold.
  useEffect(() => {
    if (fresh) rowRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [fresh]);
  const muted = plugin.owner.kind === "person" && !plugin.granted;

  return (
    <div
      ref={rowRef}
      className="relative flex min-h-11 items-center gap-3 border-b border-border/60 py-2 last:border-b-0"
      data-testid="plugin-row"
      data-plugin-id={plugin.id}
    >
      <ConnectorIcon
        name={plugin.displayName}
        iconUrl={plugin.iconUrl}
        className={cn("h-6 w-6 shrink-0 rounded text-[11px]", muted && "opacity-60")}
      />
      <div className="flex min-w-0 flex-1 flex-col" data-testid="row-text">
        <Link
          to={to}
          data-row-link
          aria-describedby={plugin.description ? descriptionId : undefined}
          className={cn("min-w-0 truncate text-sm font-medium", ROW_LINK)}
        >
          {plugin.displayName}
        </Link>
        {plugin.description && (
          <span
            id={descriptionId}
            className="truncate text-xs text-muted-foreground"
            data-testid="plugin-description"
          >
            {plugin.description}
          </span>
        )}
      </div>
      {fresh ? (
        <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-success">
          <Check className="h-3.5 w-3.5" aria-hidden />
          <span>Connected just now</span>
        </span>
      ) : (
        state && <div className="flex min-w-0 max-w-[45%] shrink justify-end">{state}</div>
      )}
      {action && (
        <div className="relative shrink-0" data-testid="plugin-action">
          {action}
        </div>
      )}
      <RowChevron />
    </div>
  );
}

/** What is wrong, on the row whose action the Needs-you line carries. */
function attentionWords(plugin: Plugin): React.ReactNode {
  const label = attentionLabel(plugin);
  if (!label) return null;
  return (
    <span className="truncate text-xs text-warning" data-testid="plugin-attention">
      {label}
    </span>
  );
}

/**
 * A row's state in words, when it offers no control. One not ready that asks
 * the viewer nothing (settling, or a workspace sign-in only its admin does)
 * reads the connector list's status words. A ready one names the account it
 * uses, else says Connected; a person's plugin adds that it is on here.
 */
function stateWords(plugin: Plugin): React.ReactNode {
  const notReady = plugin.servers.find((s) => s.status !== "ready");
  const status = notReady ? connectorStatusSummary(notReady.status) : null;
  if (status) {
    return (
      <span
        className={cn("flex min-w-0 items-center gap-1.5 text-xs", status.tone)}
        data-testid="plugin-status"
      >
        {status.dot && (
          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", status.dotColor)} />
        )}
        <span className="truncate">{status.label}</span>
      </span>
    );
  }
  if (notReady) return null;
  const account = pluginAccount(plugin);
  const person = plugin.owner.kind === "person";
  return (
    <span className="truncate text-xs text-muted-foreground" data-testid="plugin-state">
      {account ? <span data-testid="plugin-account">{account}</span> : !person && "Connected"}
      {person && (account ? " · on here" : "On here")}
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
