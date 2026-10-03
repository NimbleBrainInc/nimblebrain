// ---------------------------------------------------------------------------
// WorkspaceOverviewPage — workspace landing at `/w/<slug>/`
//
// Answers "what do I do here?", most direct first:
//   1. Ask: a composer that sends into the chat panel, opening it, the way an
//      app's `ui/message` does (`AppWithChat`).
//   2. What needs a member: the briefing panel (`BriefingView`), which renders
//      nothing when nothing does.
//   3. Pick up: the workspace's most recent conversations, each reopening in
//      the panel.
//   4. Apps: one card per placement, plus "Add app" for a member who may
//      install one.
// Workspace facts appear only as an action: a workspace of one shows an
// invite to someone who may manage its members, and nothing otherwise.
//
// Gutter: the content's edges sit on the top bar's (`pl-4 pr-3` in TopBar), so
// the title lines up under the bar's title and Settings' edge under Chat's.
// Nothing is centered, since centering moves content off those lines as the
// main area widens. The header spans the column so Settings stays on that
// edge; the sections below it are capped for line length. Widths come from
// container queries on the main area (web/DESIGN.md), never the viewport.
//
// App data source: `forSlot("sidebar")` → `workspaceApps()`, the same set the
// sidebar quick-list reads, so the grid and the count agree. Icons are the
// apps' brand icons via `useWorkspaceAppIcons`, with a letter-avatar fallback.
// ---------------------------------------------------------------------------

import { ArrowUp, MessageSquare, Plus, Settings, UserPlus } from "lucide-react";
import { type FormEvent, useCallback, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { BriefingView } from "../components/briefing/BriefingView";
import { ConnectorIcon } from "../components/connectors/ConnectorIcon";
import { relativeTime } from "../components/RecentConversationsPopover";
import { Tooltip } from "../components/ui/tooltip";
import { useChatContext } from "../context/ChatContext";
import { useChatPanelContext } from "../context/ChatPanelContext";
import { useSession } from "../context/SessionContext";
import { useShellContext } from "../context/ShellContext";
import { useWorkspaceAppIcons } from "../context/WorkspaceAppIconsContext";
import { useWorkspaceContext } from "../context/WorkspaceContext";
import { type RecentConversation, useRecentConversations } from "../hooks/useRecentConversations";
import { canManageWorkspaceMembers, canWriteWorkspace } from "../hooks/useScopedRole";
import { useWorkspaceBriefing } from "../hooks/useWorkspaceBriefing";
import { cn } from "../lib/utils";
import { connectorSettingsPath, workspaceApps } from "../lib/workspace-apps";
import { toSlug } from "../lib/workspace-slug";
import type { PlacementEntry } from "../types";

export function WorkspaceOverviewPage() {
  const { slug } = useParams<{ slug: string }>();
  const wsCtx = useWorkspaceContext();
  const shell = useShellContext();
  const { iconFor, connectors } = useWorkspaceAppIcons();
  const navigate = useNavigate();
  const session = useSession();
  const { openPanel } = useChatPanelContext();

  const workspace = slug ? wsCtx.workspaces.find((w) => toSlug(w.id) === slug) : undefined;

  // The briefing is workspace-scoped server-side via the workspace in the
  // request path, which the route guard projects from the slug. Key the fetch on
  // THIS page's route workspace so the path, the fetch, and the briefing all follow the URL in
  // lockstep — no one-frame mismatch on a switch (see useWorkspaceBriefing).
  const {
    briefing,
    loading: briefingLoading,
    error: briefingError,
    refresh: refreshBriefing,
  } = useWorkspaceBriefing(workspace?.id);
  const recent = useRecentConversations(workspace?.id, RECENT_LIMIT);

  // Connector status comes from the list the app icons already fetch. Until
  // it names this workspace (a switch in flight), the briefing waits for it,
  // so a connector needing attention never appears after "nothing needs you".
  const connectorsReady = workspace != null && connectors?.workspaceId === workspace.id;

  const handleBriefingOpen = useCallback(
    (route: string) => {
      // An item carries its app's placement route (e.g. "@scope/name").
      // Absolute paths pass through; bare routes open the app in this workspace.
      navigate(route.startsWith("/") ? route : `/w/${slug}/app/${route}`);
    },
    [navigate, slug],
  );

  const handleConnectorOpen = useCallback(
    (serverName: string) => {
      const path = connectorSettingsPath(slug, serverName);
      if (path) navigate(path);
    },
    [navigate, slug],
  );

  if (!workspace) {
    return (
      <div className="p-8 text-sm text-muted-foreground" data-testid="workspace-overview-not-found">
        Workspace not found.
      </div>
    );
  }

  // Apps come from the placement registry's grouped sub-slots via the shared
  // `workspaceApps()` helper (one card per placement) — so this grid and the
  // sidebar quick-list agree by construction. Bare `sidebar` items (Home,
  // Conversations, …) are core nav, not apps.
  //
  // Readiness — not just "is there a shell?". The shell holds ONE workspace's
  // placements at a time and lags a switch (old data stays visible while the
  // refetch is in flight, with no `loading` flag — see ShellContext). Compare
  // the shell's workspace to THIS page's workspace (`workspace.id`, derived from
  // the route slug — the stable truth). Until they match, `apps` is `null`: the
  // shell still reflects the previous workspace, so we don't read it (that would
  // be a false-empty / wrong-workspace grid). The route guard keeps this page
  // mounted across a switch, so the apps section just holds its space (the
  // `apps === null` branch below) until the array resolves — no skeleton flash.
  const appsReady = shell != null && shell.shellWorkspaceId === workspace.id;
  const apps = appsReady && shell ? workspaceApps(shell.forSlot("sidebar")) : null;

  const slugPath = `/w/${toSlug(workspace.id)}`;
  const canAddApps = canWriteWorkspace(workspace.userRole);
  const canInvite =
    workspace.memberCount === 1 &&
    canManageWorkspaceMembers(session?.user?.orgRole, workspace.userRole);

  return (
    <div className="@container h-full overflow-y-auto" data-testid="workspace-overview-page">
      <div className="pt-8 pb-10 pl-4 pr-3">
        <header className="mb-6 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="truncate text-3xl font-heading font-medium text-foreground">
              {workspace.name}
            </h1>
            {canInvite && (
              <Link
                to={`${slugPath}/settings/members`}
                data-testid="workspace-overview-invite"
                className="mt-2 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                <UserPlus className="size-4" aria-hidden />
                Only you so far. Invite people
              </Link>
            )}
          </div>
          <Link
            to={`${slugPath}/settings/general`}
            data-testid="workspace-overview-settings"
            className="shrink-0 inline-flex h-8 items-center gap-2 px-3 rounded-md border border-border text-sm text-muted-foreground hover:text-foreground hover:bg-foreground/5 transition-colors"
          >
            <Settings className="size-4" aria-hidden />
            Settings
          </Link>
        </header>

        <div className="max-w-5xl">
          <AskComposer workspaceName={workspace.name} />

          {/* What needs a member here: each app's open counts, and each
            connector that needs attention. */}
          <BriefingView
            workspaceId={workspace.id}
            briefing={briefing}
            connectors={connectorsReady ? connectors.installed : []}
            loading={briefingLoading || !connectorsReady}
            error={briefingError}
            onRetry={refreshBriefing}
            onOpen={handleBriefingOpen}
            onOpenConnector={handleConnectorOpen}
          />

          <RecentConversations
            conversations={recent}
            allPath={`${slugPath}/conversations`}
            onOpen={openPanel}
          />

          <SectionLabel className="mb-3">Apps</SectionLabel>
          {apps === null ? (
            // Brief shell-catch-up window after a switch — hold the space, don't
            // flash a skeleton (the page stays mounted, so this is a sub-second gap).
            <div
              className="min-h-[4.5rem]"
              aria-hidden
              data-testid="workspace-overview-apps-pending"
            />
          ) : apps.length === 0 ? (
            <div
              className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground"
              data-testid="workspace-overview-empty"
            >
              <p>No apps installed in this workspace yet.</p>
              {canAddApps && (
                <Link
                  to={`${slugPath}/settings/connectors/browse`}
                  className="mt-3 inline-flex h-8 items-center gap-2 px-3 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/80 transition-colors"
                >
                  <Plus className="size-4" aria-hidden />
                  Add an app
                </Link>
              )}
            </div>
          ) : (
            <div
              className="grid grid-cols-1 gap-3 @md:grid-cols-2 @3xl:grid-cols-3 @5xl:grid-cols-4"
              data-testid="workspace-overview-app-grid"
            >
              {apps.map((p) => (
                <AppCard
                  key={p.resourceUri}
                  placement={p}
                  iconUrl={iconFor(p.serverName)}
                  onOpen={() => {
                    if (!p.route) return;
                    navigate(`${slugPath}/app/${p.route}`);
                  }}
                />
              ))}
              {canAddApps && (
                <Link
                  to={`${slugPath}/settings/connectors/browse`}
                  data-testid="workspace-overview-add-app"
                  className="flex items-center gap-2 p-4 rounded-lg border border-dashed border-border text-sm text-muted-foreground hover:text-foreground hover:border-foreground/20 transition-colors"
                >
                  <Plus className="size-5" aria-hidden />
                  Add app
                </Link>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** How many conversations the overview offers to pick back up. */
const RECENT_LIMIT = 5;

function SectionLabel({ children, className }: { children: string; className?: string }) {
  return (
    <div
      className={cn(
        "text-2xs font-bold tracking-[0.08em] uppercase text-muted-foreground",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** The workspace's latest conversations, each reopening in the chat panel. */
function RecentConversations({
  conversations,
  allPath,
  onOpen,
}: {
  conversations: RecentConversation[] | null;
  allPath: string;
  onOpen: (id: string) => void;
}) {
  if (!conversations || conversations.length === 0) return null;
  return (
    <section className="mb-10" aria-label="Recent conversations">
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <SectionLabel>Recent conversations</SectionLabel>
        <Link
          to={allPath}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          View all
        </Link>
      </div>
      <ul
        className="divide-y divide-border rounded-lg border border-border"
        data-testid="workspace-overview-recent"
      >
        {conversations.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              onClick={() => onOpen(c.id)}
              data-testid="workspace-overview-recent-row"
              className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-foreground/5 transition-colors"
            >
              <MessageSquare className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-foreground">
                {c.title || c.preview || "Untitled conversation"}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {relativeTime(c.updatedAt)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Ask the workspace's agent. Sends into the chat panel's conversation and opens
 * the panel, as an app's message does, so the reply arrives where every other
 * chat turn does. Its own component so streaming re-renders stay out of the page.
 */
function AskComposer({ workspaceName }: { workspaceName: string }) {
  const chat = useChatContext();
  const { panelState, openPanel } = useChatPanelContext();
  const [text, setText] = useState("");
  const ready = text.trim().length > 0 && !chat.isStreaming;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    if (panelState === "closed") openPanel();
    void chat.sendMessage(text.trim());
    setText("");
  };

  return (
    <form
      onSubmit={submit}
      data-testid="workspace-overview-ask"
      className="mb-10 flex items-center gap-2 rounded-lg border border-border bg-card py-1.5 pl-4 pr-1.5 focus-within:border-foreground/20 transition-colors"
    >
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label={`Ask anything in ${workspaceName}`}
        placeholder={`Ask anything in ${workspaceName}…`}
        data-testid="workspace-overview-ask-input"
        className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
      />
      <Tooltip label="Send">
        <button
          type="submit"
          aria-label="Send"
          disabled={!ready}
          className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-primary/80 disabled:bg-foreground/10 disabled:text-muted-foreground transition-colors"
        >
          <ArrowUp className="size-4" aria-hidden />
        </button>
      </Tooltip>
    </form>
  );
}

function AppCard({
  placement,
  iconUrl,
  onOpen,
}: {
  placement: PlacementEntry;
  iconUrl?: string;
  onOpen: () => void;
}) {
  const label = placement.label ?? placement.route ?? "App";
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="workspace-overview-app-card"
      data-app-route={placement.route ?? ""}
      className={cn(
        "group flex items-center gap-2 p-4 rounded-lg border border-border bg-card text-left",
        "hover:border-foreground/20 hover:bg-foreground/5 transition-colors",
      )}
    >
      <ConnectorIcon name={label} iconUrl={iconUrl} className="h-5 w-5 rounded text-3xs" />
      <div className="truncate text-sm font-medium text-foreground">{label}</div>
    </button>
  );
}
