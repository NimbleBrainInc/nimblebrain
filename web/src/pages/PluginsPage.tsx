import { User } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type { Plugin, PluginsListOutput } from "../_generated/platform-schemas/plugins";
import { grantConnector, listPlugins, revokeConnector } from "../api/client";
import { ConnectorIcon } from "../components/connectors/ConnectorIcon";
import { connectorStatusSummary } from "../components/connectors/ConnectorList";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { useWorkspaceContext } from "../context/WorkspaceContext";
import { useEvents } from "../hooks/useEvents";
import { useCanWriteActiveWorkspace } from "../hooks/useScopedRole";
import { cn } from "../lib/utils";
import { toWsId } from "../lib/workspace-slug";
import { ConnectorDirectory } from "./settings/ConnectorBrowsePage";
import { EmptyState, InlineError } from "./settings/components";

/**
 * Plugins — what the agent can do in this workspace, in one place.
 *
 * Installed lists the workspace's plugins and the viewer's own ones granted
 * here, then the viewer's plugins not used here, each with the one action that
 * changes that. Browse is the connector directory, unchanged, so installing
 * behaves as it does in settings. Each row shows a plugin by the facts the
 * listing carries (whose it is, whether it is granted, the account it signs in
 * as) and needs no rule of its own to tell a personal plugin from a workspace
 * one (ADR-0069).
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
          <ConnectorDirectory />
        )}
      </div>
    </div>
  );
}

type PluginsTab = "installed" | "browse";

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

/** The account the plugin signs in as: the first of its servers that records one. */
export function pluginAccount(plugin: Plugin): string | undefined {
  for (const server of plugin.servers) {
    const account = server.account?.email ?? server.account?.name;
    if (account) return account;
  }
  return undefined;
}

/** Whose account the plugin acts as, and which one when the sign-in recorded it. */
export function accountLine(plugin: Plugin): string {
  const whose =
    plugin.owner.kind === "person" ? "Uses your account" : "Uses the workspace's account";
  const account = pluginAccount(plugin);
  return account ? `${whose} · ${account}` : whose;
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
  // Installing writes the workspace; granting your own plugin does not, so
  // only the install affordance is gated.
  const canInstall = useCanWriteActiveWorkspace();
  const workspaceName = workspaces.find((w) => w.id === wsId)?.name ?? "this workspace";
  const [listing, setListing] = useState<PluginsListOutput | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Plugin | null>(null);

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

  // A sign-in finishing elsewhere changes a row's status and account.
  useEvents({ onConnectionStateChanged: () => void refresh() });

  const groups = useMemo(
    () => (listing && listing.wsId === wsId ? groupPlugins(listing.plugins) : null),
    [listing, wsId],
  );

  const grantHere = async (plugin: Plugin) => {
    for (const server of plugin.servers) await grantConnector(server.serverName, wsId);
    await refresh();
    setConfirming(null);
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

  const configurePath = (plugin: Plugin): string => {
    if (plugin.owner.kind === "person") return "/profile/connectors";
    const serverName = plugin.servers[0]?.serverName ?? "";
    return `/w/${slug}/settings/connectors/${encodeURIComponent(serverName)}`;
  };
  const nothingHere = groups.workspace.length === 0 && groups.yours.length === 0;
  const confirmAccount = confirming ? pluginAccount(confirming) : undefined;

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
            {(plugin) => <PluginRow key={plugin.id} plugin={plugin} to={configurePath(plugin)} />}
          </PluginSection>
          <PluginSection title="Yours" plugins={groups.yours} testId="yours">
            {(plugin) => (
              <PluginRow
                key={plugin.id}
                plugin={plugin}
                to={configurePath(plugin)}
                action={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busyId === plugin.id}
                    onClick={() => void revokeHere(plugin)}
                  >
                    {busyId === plugin.id ? "Stopping…" : "Stop using here"}
                  </Button>
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
            to={configurePath(plugin)}
            muted
            action={
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setActionError(null);
                  setConfirming(plugin);
                }}
              >
                Use here
              </Button>
            }
          />
        )}
      </PluginSection>

      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        title={
          confirming
            ? `Use ${confirming.displayName}${confirmAccount ? ` (${confirmAccount})` : ""} in ${workspaceName}?`
            : ""
        }
        description="Only you can use it here; other members can't. What your agent does with it is saved in this workspace, private to you unless you share it."
        confirmLabel="Use here"
        pendingLabel="Turning on…"
        onConfirm={async () => {
          if (confirming) await grantHere(confirming);
        }}
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
