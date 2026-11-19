import { Menu } from "@base-ui/react/menu";
import { MoreHorizontal, User } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
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
import { SkillsGroup } from "../components/plugins/SkillsGroup";
import { UsePluginHereDialog } from "../components/plugins/UsePluginHereDialog";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { Tooltip } from "../components/ui/tooltip";
import { useWorkspaceContext } from "../context/WorkspaceContext";
import { useEvents } from "../hooks/useEvents";
import { useCanWriteActiveWorkspace } from "../hooks/useScopedRole";
import {
  accountLine,
  newSkillPath,
  pluginConnected,
  pluginNextStep,
  pluginPath,
  shellPath,
} from "../lib/plugins";
import { cn } from "../lib/utils";
import { toWsId } from "../lib/workspace-slug";
import { ConnectorDirectory } from "./settings/ConnectorBrowsePage";
import { EmptyState, InlineError } from "./settings/components";

/**
 * Plugins — what the agent can do in this workspace, in one place.
 *
 * Installed lists, in one group, everything the agent can use here: the
 * workspace's plugins and the viewer's own ones granted here. Then the
 * viewer's plugins not used here, then the skills people wrote
 * (`SkillsGroup`). A row names the plugin and the account it uses, flags only
 * what needs the viewer, and opens the plugin's page, where its state and
 * every action live. A healthy row offers nothing. One that needs a sign-in
 * offers Connect (a person's signs in from the row; a workspace's opens its
 * page, where its admin connects it), and one of the viewer's plugins not used
 * here offers Use here, which signs in too when it is not connected
 * (`pluginNextStep`). A sign-in returns to this page. The rest (Open, Stop
 * using here, Disconnect) sit in the row's ⋯ menu. Whose a plugin is reads
 * from its badge, not from a group.
 *
 * Browse offers writing a skill above the connector directory, which asks
 * whom an install is for: the viewer alone (granted here in the same act) or
 * everyone in the workspace. A row needs no rule of its own to tell a
 * personal plugin from a workspace one; it reads the facts the listing carries
 * (ADR-0069).
 *
 * One column, because this renders in the main area beside the docked chat
 * (`web/DESIGN.md`).
 */
export function PluginsPage() {
  const { slug = "" } = useParams<{ slug: string }>();
  const wsId = toWsId(slug);
  const [params, setParams] = useSearchParams();
  const tab: PluginsTab = params.get("tab") === "browse" ? "browse" : "installed";
  const showTab = (next: PluginsTab) =>
    setParams(next === "browse" ? { tab: "browse" } : {}, { replace: true });

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-(--page-gutter) py-6 space-y-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Plugins</h1>
          <p className="text-sm text-muted-foreground mt-1">
            What your agent can do in this workspace.
          </p>
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
          <InstalledPlugins key={wsId} wsId={wsId} slug={slug} onBrowse={() => showTab("browse")} />
        ) : (
          <Browse slug={slug} />
        )}
      </div>
    </div>
  );
}

type PluginsTab = "installed" | "browse";

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

/**
 * The listing in two groups: what the agent can use here (the workspace's
 * plugins and the viewer's own granted ones), then the viewer's plugins not
 * used here. Within each, the ones that need the viewer come first, then by name.
 */
export function groupPlugins(plugins: readonly Plugin[]): {
  here: Plugin[];
  yoursNotHere: Plugin[];
} {
  const order = (a: Plugin, b: Plugin) =>
    Number(pluginConnected(a)) - Number(pluginConnected(b)) ||
    a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" });
  const sorted = [...plugins].sort(order);
  return {
    here: sorted.filter((p) => p.owner.kind === "workspace" || p.granted),
    yoursNotHere: sorted.filter((p) => p.owner.kind === "person" && !p.granted),
  };
}

/** What the plugin brings besides its tools: its skills and its apps. */
export function contentsLine(plugin: Plugin): string | undefined {
  const parts: string[] = [];
  const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  if (plugin.skills.length > 0) parts.push(count(plugin.skills.length, "skill"));
  if (plugin.apps.length > 0) parts.push(count(plugin.apps.length, "app"));
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** A server status that a sign-in clears. */
function needsSignIn(plugin: Plugin): boolean {
  return plugin.servers.some((s) => s.status === "not_connected" || s.status === "needs_auth");
}

function InstalledPlugins({
  wsId,
  slug,
  onBrowse,
}: {
  wsId: string;
  slug: string;
  onBrowse: () => void;
}) {
  const { workspaces } = useWorkspaceContext();
  const location = useLocation();
  const navigate = useNavigate();
  // Installing and signing in a workspace plugin write the workspace; granting
  // your own plugin does not, so only those affordances are gated.
  const canManage = useCanWriteActiveWorkspace();
  const workspaceName = workspaces.find((w) => w.id === wsId)?.name ?? "this workspace";
  const [listing, setListing] = useState<PluginsListOutput | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
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

  // A sign-in finishing elsewhere changes a row's status and account.
  useEvents({ onConnectionStateChanged: () => void refresh() });

  const groups = useMemo(
    () => (listing && listing.wsId === wsId ? groupPlugins(listing.plugins) : null),
    [listing, wsId],
  );

  // Turn it on here, then sign in when it has no account behind it. The grant
  // needs only the install, so it stands across the sign-in's round trip. The
  // redirect leaves the page, so the dialog stays as it is until it does.
  const grantHere = async (plugin: Plugin) => {
    for (const server of plugin.servers) await grantConnector(server.serverName, wsId);
    if (!pluginConnected(plugin)) {
      const signedIn = await startPluginSignIn(plugin, connectors ?? [], shellPath(location));
      if (signedIn === "redirected") return;
    }
    await refresh();
    setConfirming(null);
  };

  const connectHere = async (plugin: Plugin) => {
    setActionError(null);
    setBusyId(plugin.id);
    try {
      const signedIn = await startPluginSignIn(plugin, connectors ?? [], shellPath(location));
      // The redirect leaves the page, so the row stays busy until it does.
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

  if (loadError && !groups) {
    return <InlineError message={`Unable to load plugins: ${loadError}. Reload to retry.`} />;
  }
  if (!groups) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const rowFor = (plugin: Plugin) => {
    const to = pluginPath(slug, plugin);
    const personal = plugin.owner.kind === "person";
    const menu: RowMenuItem[] = [{ kind: "open", to }];
    if (personal && plugin.granted) {
      menu.push({ kind: "stop", onSelect: () => setStopping(plugin) });
    }
    if (personal && pluginConnected(plugin)) {
      menu.push({ kind: "disconnect", onSelect: () => setDisconnecting(plugin) });
    }
    return (
      <PluginRow
        key={plugin.id}
        plugin={plugin}
        to={to}
        muted={personal && !plugin.granted}
        action={rowAction(plugin, to)}
        menu={menu}
      />
    );
  };

  // Only what needs the viewer: nothing for a healthy plugin.
  const rowAction = (plugin: Plugin, to: string): React.ReactNode =>
    plugin.owner.kind === "workspace"
      ? workspaceAction(plugin, canManage, () => navigate(to))
      : personalAction(plugin);

  const personalAction = (plugin: Plugin): React.ReactNode => {
    if (!plugin.granted) {
      return (
        <Button
          type="button"
          size="sm"
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
    if (pluginNextStep(plugin) !== "connect") return null;
    const busy = busyId === plugin.id;
    return (
      <Button
        type="button"
        size="sm"
        disabled={busy || connectors === null}
        onClick={() => void connectHere(plugin)}
        data-testid="plugin-connect"
      >
        {busy ? "Connecting…" : "Connect"}
      </Button>
    );
  };

  return (
    <div className="space-y-8">
      {actionError && <InlineError message={actionError} />}

      {groups.here.length === 0 ? (
        <EmptyState
          message="No plugins act in this workspace yet."
          action={
            canManage ? (
              <Button type="button" variant="outline" size="sm" onClick={onBrowse}>
                Browse plugins
              </Button>
            ) : undefined
          }
        />
      ) : (
        <PluginSection title="In this workspace" plugins={groups.here} testId="here">
          {rowFor}
        </PluginSection>
      )}

      <PluginSection
        title="Yours, not used here"
        plugins={groups.yoursNotHere}
        testId="yours-not-here"
      >
        {rowFor}
      </PluginSection>

      <SkillsGroup wsId={wsId} slug={slug} />

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
 * What a workspace plugin's row asks of the viewer. A sign-in happens on its
 * page, where its admin connects it, so Connect opens the page; a member, or a
 * state a sign-in does not clear, reads the status words instead.
 */
function workspaceAction(
  plugin: Plugin,
  canManage: boolean,
  onConnect: () => void,
): React.ReactNode {
  if (canManage && needsSignIn(plugin)) {
    return (
      <Button type="button" size="sm" onClick={onConnect} data-testid="plugin-connect">
        Connect
      </Button>
    );
  }
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

function PluginSection({
  title,
  plugins,
  testId,
  children,
}: {
  title: string;
  plugins: Plugin[];
  testId: string;
  children: (plugin: Plugin) => React.ReactNode;
}) {
  if (plugins.length === 0) return null;
  return (
    <section className="space-y-2" data-testid={`plugins-${testId}`}>
      <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
      <div className="border-t border-border">{plugins.map(children)}</div>
    </section>
  );
}

/** A secondary action in a row's ⋯ menu. */
type RowMenuItem =
  | { kind: "open"; to: string }
  | { kind: "stop"; onSelect: () => void }
  | { kind: "disconnect"; onSelect: () => void };

/**
 * One plugin: what it is, the account it uses, and only what needs the viewer.
 * The whole row opens the plugin's page: the name's link stretches over the
 * row, and the action and the ⋯ menu sit above it, beside the link rather than
 * inside it, because a control cannot nest inside a link.
 */
function PluginRow({
  plugin,
  to,
  action,
  menu,
  muted = false,
}: {
  plugin: Plugin;
  to: string;
  action?: React.ReactNode;
  menu: RowMenuItem[];
  muted?: boolean;
}) {
  const subtitle = [accountLine(plugin), contentsLine(plugin)].filter(Boolean).join(" · ");
  return (
    <div
      className="relative flex items-center gap-3 border-b border-border py-2.5"
      data-testid="plugin-row"
      data-plugin-id={plugin.id}
    >
      <ConnectorIcon
        name={plugin.displayName}
        iconUrl={plugin.iconUrl}
        className={cn("h-7 w-7 rounded text-xs", muted && "opacity-60")}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Link
            to={to}
            data-row-link
            className="truncate text-sm font-medium outline-none after:absolute after:inset-y-0 after:-inset-x-2 after:rounded-sm after:transition-colors hover:after:bg-foreground/5 focus-visible:after:ring-2 focus-visible:after:ring-ring"
          >
            {plugin.displayName}
          </Link>
          {plugin.owner.kind === "person" && (
            <Badge variant="outline" data-testid="plugin-person-badge">
              <User aria-hidden="true" />
              Yours
            </Badge>
          )}
        </div>
        {subtitle && (
          <p className="truncate text-xs text-muted-foreground" data-testid="plugin-account">
            {subtitle}
          </p>
        )}
      </div>
      {action && (
        <div className="relative shrink-0" data-testid="plugin-action">
          {action}
        </div>
      )}
      <RowMenu name={plugin.displayName} items={menu} />
    </div>
  );
}

function RowMenu({ name, items }: { name: string; items: RowMenuItem[] }) {
  const itemClass =
    "flex w-full cursor-default items-center px-3 py-1.5 text-sm outline-none data-[highlighted]:bg-foreground/5 data-[disabled]:opacity-50";
  const label = `${name} actions`;
  return (
    <Menu.Root>
      <Tooltip label="More actions" side="left">
        <Menu.Trigger
          aria-label={label}
          data-testid="plugin-menu"
          className="relative shrink-0 rounded-sm p-1.5 text-muted-foreground hover:bg-foreground/5 hover:text-foreground data-[popup-open]:bg-foreground/10"
        >
          <MoreHorizontal className="h-4 w-4" aria-hidden />
        </Menu.Trigger>
      </Tooltip>
      <Menu.Portal>
        <Menu.Positioner align="end" sideOffset={4} className="z-50">
          <Menu.Popup
            data-testid="plugin-menu-popup"
            className="min-w-44 rounded-sm border bg-popover py-1 text-popover-foreground shadow-md outline-none"
          >
            {items.map((item) => rowMenuItem(item, itemClass))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function rowMenuItem(item: RowMenuItem, itemClass: string): React.ReactNode {
  switch (item.kind) {
    case "open":
      return (
        <Menu.LinkItem key="open" closeOnClick render={<Link to={item.to} />} className={itemClass}>
          Open
        </Menu.LinkItem>
      );
    case "stop":
      return (
        <Menu.Item key="stop" className={itemClass} onClick={item.onSelect}>
          Stop using here
        </Menu.Item>
      );
    case "disconnect":
      return (
        <Menu.Item
          key="disconnect"
          className={cn(itemClass, "text-destructive")}
          onClick={item.onSelect}
        >
          Disconnect
        </Menu.Item>
      );
  }
}
