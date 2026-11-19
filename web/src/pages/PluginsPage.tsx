import { User } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { Plugin, PluginsListOutput } from "../_generated/platform-schemas/plugins";
import {
  grantConnector,
  listPersonalConnectors,
  listPlugins,
  type PersonalConnector,
  revokeConnector,
} from "../api/client";
import { ConnectorIcon } from "../components/connectors/ConnectorIcon";
import { connectorStatusSummary } from "../components/connectors/ConnectorList";
import { startPluginSignIn } from "../components/connectors/personal-connector";
import { SkillsGroup } from "../components/plugins/SkillsGroup";
import { UsePluginHereDialog } from "../components/plugins/UsePluginHereDialog";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
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
 * Installed lists the workspace's plugins and the viewer's own ones granted
 * here, then the viewer's plugins not used here, then the skills people wrote
 * (`SkillsGroup`). Each of the viewer's own plugins offers its next step
 * (`pluginNextStep`): Use here, which signs in too when it is not connected;
 * Connect, for one on here but not signed in; or nothing, once it is in use.
 * A sign-in returns to this page. Browse offers
 * writing a skill above the connector directory, which asks whom an install
 * is for: the viewer alone (granted here in the same act) or everyone in the
 * workspace. Each row shows a plugin by the facts the listing carries (whose it
 * is, whether it is granted, the account it signs in as) and needs no rule of
 * its own to tell a personal plugin from a workspace one (ADR-0069).
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

/** The listing split by whose each plugin is and whether it acts here. */
export function groupPlugins(plugins: readonly Plugin[]): {
  workspace: Plugin[];
  yours: Plugin[];
  yoursNotHere: Plugin[];
} {
  const byName = (a: Plugin, b: Plugin) =>
    a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" });
  const sorted = [...plugins].sort(byName);
  return {
    workspace: sorted.filter((p) => p.owner.kind === "workspace"),
    yours: sorted.filter((p) => p.owner.kind === "person" && p.granted),
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
  // Installing writes the workspace; granting your own plugin does not, so
  // only the install affordance is gated.
  const canInstall = useCanWriteActiveWorkspace();
  const workspaceName = workspaces.find((w) => w.id === wsId)?.name ?? "this workspace";
  const [listing, setListing] = useState<PluginsListOutput | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Plugin | null>(null);
  // The viewer's connector records, which say which route each sign-in takes.
  // An action that signs in waits for them rather than guess the route.
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

  useEffect(() => {
    let cancelled = false;
    listPersonalConnectors()
      .then(({ connectors: mine }) => {
        if (!cancelled) setConnectors(mine);
      })
      .catch((err: unknown) => {
        if (!cancelled) setActionError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

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

  const revokeHere = async (plugin: Plugin) => {
    setActionError(null);
    setBusyId(plugin.id);
    try {
      for (const server of plugin.servers) await revokeConnector(server.serverName, wsId);
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  if (loadError && !groups) {
    return <InlineError message={`Unable to load plugins: ${loadError}. Reload to retry.`} />;
  }
  if (!groups) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const nothingHere = groups.workspace.length === 0 && groups.yours.length === 0;

  return (
    <div className="space-y-8">
      {actionError && <InlineError message={actionError} />}

      {nothingHere ? (
        <EmptyState
          message="No plugins act in this workspace yet."
          action={
            canInstall ? (
              <Button type="button" variant="outline" size="sm" onClick={onBrowse}>
                Browse plugins
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <PluginSection title="In this workspace" plugins={groups.workspace} testId="workspace">
            {(plugin) => (
              <PluginRow key={plugin.id} plugin={plugin} to={pluginPath(slug, plugin)} />
            )}
          </PluginSection>
          <PluginSection title="Yours" plugins={groups.yours} testId="yours">
            {(plugin) => (
              <PluginRow
                key={plugin.id}
                plugin={plugin}
                to={pluginPath(slug, plugin)}
                action={
                  <div className="flex items-center gap-1.5">
                    {pluginNextStep(plugin) === "connect" ? (
                      <Button
                        type="button"
                        size="sm"
                        disabled={busyId === plugin.id || connectors === null}
                        onClick={() => void connectHere(plugin)}
                        data-testid="plugin-connect"
                      >
                        {busyId === plugin.id ? "Connecting…" : "Connect"}
                      </Button>
                    ) : (
                      <span
                        className="px-2 text-xs text-muted-foreground"
                        data-testid="plugin-in-use"
                      >
                        In use here
                      </span>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busyId === plugin.id}
                      onClick={() => void revokeHere(plugin)}
                    >
                      Stop using here
                    </Button>
                  </div>
                }
              />
            )}
          </PluginSection>
        </>
      )}

      <PluginSection
        title="Yours, not used here"
        plugins={groups.yoursNotHere}
        testId="yours-not-here"
      >
        {(plugin) => (
          <PluginRow
            key={plugin.id}
            plugin={plugin}
            to={pluginPath(slug, plugin)}
            muted
            action={
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
            }
          />
        )}
      </PluginSection>

      <SkillsGroup wsId={wsId} slug={slug} />

      <UsePluginHereDialog
        plugin={confirming}
        workspaceName={workspaceName}
        onClose={() => setConfirming(null)}
        onConfirm={grantHere}
      />
    </div>
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

/**
 * One plugin. The name and its facts link to where it is configured; the
 * action, when there is one, sits beside the link because a control cannot
 * nest inside one.
 */
function PluginRow({
  plugin,
  to,
  action,
  muted = false,
}: {
  plugin: Plugin;
  to: string;
  action?: React.ReactNode;
  muted?: boolean;
}) {
  const contents = contentsLine(plugin);
  const notReady = plugin.servers.find((s) => s.status !== "ready");
  const status = notReady ? connectorStatusSummary(notReady.status) : null;
  return (
    <div
      className="flex items-center gap-3 border-b border-border py-2.5"
      data-testid="plugin-row"
      data-plugin-id={plugin.id}
    >
      <Link
        to={to}
        className="-ml-2 flex min-w-0 flex-1 items-center gap-3 rounded px-2 py-0.5 transition-colors hover:bg-muted/50"
      >
        <ConnectorIcon
          name={plugin.displayName}
          iconUrl={plugin.iconUrl}
          className={cn("h-7 w-7 rounded text-xs", muted && "opacity-60")}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{plugin.displayName}</span>
            {plugin.owner.kind === "person" && (
              <Badge variant="outline" data-testid="plugin-person-badge">
                <User aria-hidden="true" />
                Yours
              </Badge>
            )}
          </div>
          <p className="truncate text-xs text-muted-foreground" data-testid="plugin-account">
            {accountLine(plugin)}
            {contents && ` · ${contents}`}
          </p>
        </div>
        {status && (
          <span className={cn("flex shrink-0 items-center gap-1.5 text-xs", status.tone)}>
            {status.dot && <span className={cn("h-1.5 w-1.5 rounded-full", status.dotColor)} />}
            <span>{status.label}</span>
          </span>
        )}
      </Link>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
