import { useCallback, useEffect, useRef, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import {
  callToolWithoutWorkspace,
  logout,
  setAuthToken,
  setOnAuthError,
  setOnWorkspaceError,
  setPlatformVersion,
  tryBootstrap,
} from "./api/client";
import { closeEventsClient } from "./api/events-client";
import { AppFrameSkeleton } from "./components/AppFrameSkeleton";
import { AppWithChat } from "./components/AppWithChat";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Login } from "./components/Login";
import { NoticeProvider } from "./components/notices";
import { CommandPalette } from "./components/palette/CommandPalette";
import { RouteGuard } from "./components/RouteGuard";
import { ShellLayout } from "./components/ShellLayout";
import { WorkspaceRouteGuard } from "./components/WorkspaceRouteGuard";
import { AppLocationProvider } from "./context/AppLocationContext";
import { ArtifactPanelProvider } from "./context/ArtifactPanelContext";
import { ChatProvider, useChatConfigContext } from "./context/ChatContext";
import { ChatPanelProvider, useChatPanelContext } from "./context/ChatPanelContext";
import { FocusedAppProvider } from "./context/FocusedAppContext";
import { NotificationsProvider } from "./context/NotificationsProvider";
import { PaletteProvider } from "./context/PaletteContext";
import { SessionProvider } from "./context/SessionContext";
import { ShellProvider } from "./context/ShellContext";
import { SidebarProvider } from "./context/SidebarContext";
import { type ThemePreference, ThemeProvider, useTheme } from "./context/ThemeContext.tsx";
import { WorkspaceAppIconsProvider } from "./context/WorkspaceAppIconsProvider";
import {
  useWorkspaceContext,
  type WorkspaceInfo,
  WorkspaceProvider,
} from "./context/WorkspaceContext";
import { WorkspaceUnreadProvider } from "./context/WorkspaceUnreadContext";
import { chatStore } from "./hooks/chat-store";
import { useEvents } from "./hooks/useEvents";
import { useServerNotificationRelay } from "./hooks/useServerNotificationRelay";
import { useShell } from "./hooks/useShell";
import { bootstrapWorkspacesToInfo } from "./lib/bootstrap";
import { identityAppSegment, isIdentityApp } from "./lib/identity-apps";
import { type AppRouteState, isOpenAppCall, resolveAppRouteIn } from "./lib/open-app";
import { routablePlacements } from "./lib/routable-placements";
import {
  landingTab,
  ORG_SETTINGS_TABS,
  PROFILE_TABS,
  WORKSPACE_SETTINGS_TABS,
} from "./lib/settings-tabs";
import { connectorSettingsPath } from "./lib/workspace-apps";
import { recoverFromWorkspaceError } from "./lib/workspace-recovery";
import { toSlug } from "./lib/workspace-slug";
import { ContextInspectorPage } from "./pages/ContextInspectorPage";
import { GlobalHomePage } from "./pages/GlobalHomePage";
import { NotFoundPage, WorkspaceNotFoundPage } from "./pages/NotFoundPage";
import { NotificationsPage } from "./pages/NotificationsPage";
import { ProfilePage } from "./pages/ProfilePage";
import { ConnectorBrowsePage } from "./pages/settings/ConnectorBrowsePage";
import { ConnectorDetailPage } from "./pages/settings/ConnectorDetailPage";
import { ModelTab } from "./pages/settings/ModelTab";
import { OrgAboutTab } from "./pages/settings/OrgAboutTab";
import { OrgArchivesTab } from "./pages/settings/OrgArchivesTab";
import { OrgSettingsPage } from "./pages/settings/OrgSettingsPage";
import { OrgSkillsTab } from "./pages/settings/OrgSkillsTab";
import { OrgUsageTab } from "./pages/settings/OrgUsageTab";
import { ProfileConnectorsTab } from "./pages/settings/ProfileConnectorsTab";
import { ProfileSkillsTab } from "./pages/settings/ProfileSkillsTab";
import { ProfileTab } from "./pages/settings/ProfileTab";
import { SkillsTab } from "./pages/settings/SkillsTab";
import { UsersTab } from "./pages/settings/UsersTab";
import { WorkspaceConnectorsTab } from "./pages/settings/WorkspaceConnectorsTab";
import { WorkspaceDetailPage } from "./pages/settings/WorkspaceDetailPage";
import { WorkspaceGeneralTab } from "./pages/settings/WorkspaceGeneralTab";
import { WorkspaceMcpTab } from "./pages/settings/WorkspaceMcpTab";
import { WorkspaceMembersTab } from "./pages/settings/WorkspaceMembersTab";
import { WorkspaceNotificationsTab } from "./pages/settings/WorkspaceNotificationsTab";
import { WorkspaceSettingsPage } from "./pages/settings/WorkspaceSettingsPage";
import { WorkspacesTab } from "./pages/settings/WorkspacesTab";
import { WorkspaceWebhooksTab } from "./pages/settings/WorkspaceWebhooksTab";
import { WorkspaceOverviewPage } from "./pages/WorkspaceOverviewPage";
import { clearSentryContext, setSentryUser } from "./sentry";
import { initTelemetry } from "./telemetry";
import type { BootstrapResponse, ConfigInfo, FileLimits, PlacementEntry } from "./types";
import "./index.css";

/** Stores a theme toggled from the palette or shortcut as the person's preference. */
async function saveThemePreference(theme: ThemePreference): Promise<void> {
  const res = await callToolWithoutWorkspace("nb", "set_preferences", { theme });
  if (res.isError) throw new Error(res.content?.[0]?.text ?? "Theme preference not saved.");
}

function AuthenticatedApp({
  token,
  onLogout,
  bootstrap,
}: {
  token: string;
  onLogout: () => void;
  bootstrap: BootstrapResponse;
}) {
  // Tag Sentry events with the opaque user id (no email/displayName). The
  // workspace_id tag is kept in sync separately by setActiveWorkspaceId.
  useEffect(() => {
    setSentryUser(bootstrap.user.id);
  }, [bootstrap.user.id]);

  // Fire-and-forget telemetry init (non-blocking)
  useEffect(() => {
    callToolWithoutWorkspace("nb", "workspace_info", {})
      .then((res) => {
        let raw: unknown = res.structuredContent;
        if (!raw && res.content?.[0]?.text) {
          try {
            raw = JSON.parse(res.content[0].text);
          } catch {
            raw = {};
          }
        }
        const ws = (raw ?? {}) as Record<string, unknown>;
        if (ws.telemetryEnabled && ws.installId) {
          initTelemetry(ws.installId as string);
        }
      })
      .catch(() => {});
  }, []);

  const initialWorkspaces: WorkspaceInfo[] = bootstrapWorkspacesToInfo(bootstrap.workspaces);

  const initialConfig = {
    configuredProviders: bootstrap.config.configuredProviders,
    newConversationModel: bootstrap.config.newConversationModel,
    availableModels: bootstrap.config.availableModels,
    preferences: bootstrap.user.preferences,
    fileLimits: bootstrap.config.files,
  };

  // Build session info from bootstrap user data
  const session = {
    authenticated: true as const,
    user: {
      id: bootstrap.user.id,
      email: bootstrap.user.email,
      displayName: bootstrap.user.displayName,
      orgRole: bootstrap.user.orgRole,
    },
  };

  return (
    <ThemeProvider savePreference={saveThemePreference}>
      <NoticeProvider>
        <SessionProvider session={session}>
          <WorkspaceProvider initialWorkspaces={initialWorkspaces}>
            <WorkspaceUnreadProvider workspaces={bootstrap.workspaces}>
              <BootstrappedShell
                token={token}
                initialConfig={initialConfig}
                currentUserId={bootstrap.user.id}
                onLogout={onLogout}
              />
            </WorkspaceUnreadProvider>
          </WorkspaceProvider>
        </SessionProvider>
      </NoticeProvider>
    </ThemeProvider>
  );
}

/** Inner component that has access to WorkspaceContext (needed for useShell workspace switch). */
function BootstrappedShell({
  token,
  initialConfig,
  currentUserId,
  onLogout,
}: {
  token: string;
  initialConfig: {
    configuredProviders: string[];
    newConversationModel?: string;
    availableModels?: ConfigInfo["availableModels"];
    preferences?: { displayName?: string; timezone?: string; locale?: string; theme?: string };
    fileLimits?: FileLimits;
  };
  currentUserId: string;
  onLogout: () => void;
}) {
  const { activeWorkspace } = useWorkspaceContext();
  const {
    loading,
    error,
    shellWorkspaceId,
    forSlot,
    mainRoutes,
    refresh: refreshShell,
  } = useShell(token, activeWorkspace?.id);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-background text-muted-foreground text-sm">
        Loading workspace...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-background text-destructive text-sm gap-3">
        <span>Failed to load workspace: {error}</span>
        <button
          type="button"
          className="px-4 py-2 text-sm bg-secondary text-secondary-foreground rounded-sm hover:bg-accent transition-colors"
          onClick={() => window.location.reload()}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <SidebarProvider>
      <WorkspaceAppIconsProvider workspaceId={activeWorkspace?.id}>
        <NotificationsProvider workspaceId={activeWorkspace?.id}>
          <ChatProvider initialConfig={initialConfig} currentUserId={currentUserId}>
            <ChatPanelProvider>
              <ArtifactPanelProvider>
                <PaletteProvider>
                  <FocusedAppProvider>
                    <AppLocationProvider>
                      <AuthenticatedAppContent
                        forSlot={forSlot}
                        mainRoutes={mainRoutes}
                        shellWorkspaceId={shellWorkspaceId}
                        refreshShell={refreshShell}
                        onLogout={onLogout}
                      />
                    </AppLocationProvider>
                  </FocusedAppProvider>
                </PaletteProvider>
              </ArtifactPanelProvider>
            </ChatPanelProvider>
          </ChatProvider>
        </NotificationsProvider>
      </WorkspaceAppIconsProvider>
    </SidebarProvider>
  );
}

/**
 * Shell-level component. Only consumes ChatConfigContext (stable) — never
 * ChatContext (streaming). This prevents the entire shell from re-rendering
 * on every text delta during chat streaming.
 *
 * Action handling (which needs sendMessage from ChatContext) is isolated in
 * ActionBridge, a non-rendering child component.
 */
function AuthenticatedAppContent({
  forSlot,
  mainRoutes,
  shellWorkspaceId,
  refreshShell,
  onLogout,
}: {
  forSlot: (slot: string) => PlacementEntry[];
  mainRoutes: () => PlacementEntry[];
  shellWorkspaceId: string | undefined;
  refreshShell: () => Promise<void>;
  onLogout: () => void;
}) {
  const config = useChatConfigContext();
  const { applyPreference } = useTheme();
  const wsCtx = useWorkspaceContext();
  const onServerNotification = useServerNotificationRelay();
  useEvents({
    onServerNotification,
    onConfigChanged: () => config.refreshConfig(),
    // Auto-title arrived — update the matching conversation's slice so the
    // chat panel header reflects it live (routed by conversationId). The
    // conversations list hears the same write from its own server.
    onConversationTitle: ({ conversationId, title }) => {
      chatStore.setTitle(conversationId, title);
    },
    // Connector install / uninstall changes the placement set; refetch
    // the shell so the sidebar's Apps group reflects the new state
    // without a page reload.
    onConnectorLifecycleChanged: () => {
      void refreshShell();
    },
    // After a reconnect, any connector / config events emitted during the
    // disconnect gap were dropped (the workspace stream has no
    // Last-Event-Id replay). Refetch the two state owners that consume
    // those events so the UI snaps back to truth.
    onReconnect: () => {
      void refreshShell();
      config.refreshConfig();
    },
  });

  // Sync server-side theme preference to the client theme context
  const serverTheme = config.preferences?.theme;
  useEffect(() => {
    if (serverTheme === "light" || serverTheme === "dark" || serverTheme === "system") {
      applyPreference(serverTheme);
    }
  }, [serverTheme, applyPreference]);

  const navigate = useNavigate();
  const location = useLocation();
  const activeSlug = wsCtx.activeWorkspace ? toSlug(wsCtx.activeWorkspace.id) : null;

  // Recover from a stale/invalid workspace context. A data call to a workspace
  // path the server rejects (deleted workspace, lost
  // membership, or a dynamic /w/:slug deep-link the user can't see) returns
  // `workspace_error`. Bootstrap validates the active workspace on load, so
  // this is the mid-session net: drop the bad selection (excluding the
  // rejected id), fall back to a valid workspace, and route home rather than
  // surface raw error JSON. See recoverFromWorkspaceError for the contract.
  useEffect(() => {
    setOnWorkspaceError(() => {
      recoverFromWorkspaceError(
        wsCtx.workspaces,
        wsCtx.activeWorkspace?.id,
        wsCtx.setActiveWorkspace,
        () => navigate("/", { replace: true }),
        () => window.location.assign("/"),
      );
    });
    return () => setOnWorkspaceError(null);
  }, [wsCtx, navigate]);

  const handleNavigate = useCallback(
    (route: string, state?: AppRouteState) => {
      if (route.startsWith("/")) {
        navigate(route, { state });
      } else {
        // App routes get workspace prefix: /w/<slug>/app/<route>
        const prefix = activeSlug ? `/w/${activeSlug}` : "";
        navigate(`${prefix}/app/${route}`, { state });
      }
    },
    [navigate, activeSlug],
  );

  // Resolve an app name to where it renders. Apps emit just a name (e.g. "typst-pdf"),
  // the agent's `nb__open_app` a name or sidebar label; the shell owns the route
  // mapping (e.g. "@nimblebraininc/typst-pdf"). The forms match the server's
  // `findOpenableApp`, so whatever the tool accepts, this opens.
  const resolveAppRoute = useCallback(
    (name: string): string | null =>
      // Search ALL placements (not just mainRoutes) so sidebar.apps are included
      resolveAppRouteIn(
        forSlot("sidebar").concat(forSlot("main")).concat(forSlot("sidebar.bottom")),
        name,
        activeSlug,
      ),
    [forSlot, activeSlug],
  );

  // Collect all routable placements from main + sidebar, one per route, a
  // platform placement ahead of any connector's. Sidebar placements can have
  // routes too (e.g., Conversations).
  const allRoutable = routablePlacements(forSlot("sidebar"), mainRoutes());

  // App placements: everything routable except route "/", which is the shell's
  // own: `/` is `GlobalHomePage` (workspace-agnostic) and `/w/<slug>/` is
  // `WorkspaceOverviewPage` (app grid).
  // Identity apps (conversations, …) are also excluded from the app grid set —
  // they render at their own segment under `/w/<slug>` (see
  // `identityAppPlacements`), not as `app/<route>`.
  const appPlacements = allRoutable.filter((p) => p.route !== "/" && !isIdentityApp(p.serverName));

  // Identity apps — owned by the user; their tools dispatch bare through the
  // identity door, but their VIEW is workspace-scoped (every list is one
  // workspace's), so each renders at `/w/<slug>/<serverName>` under the same
  // workspace guard as the overview / apps / settings.
  const identityAppPlacements = allRoutable.filter((p) => isIdentityApp(p.serverName));

  return (
    <ShellProvider value={{ forSlot, mainRoutes, shellWorkspaceId }}>
      {/* ActionBridge handles iframe action events. It consumes ChatContext
          (streaming) but renders nothing, so its re-renders are free. */}
      <ActionBridge
        handleNavigate={handleNavigate}
        resolveAppRoute={resolveAppRoute}
        activeSlug={activeSlug}
      />
      {/* Command palette (⌘K) — global surface, sibling of the shell layout
          and chat chrome, so it's reachable from any route. */}
      <CommandPalette onLogout={onLogout} />
      <ShellLayout forSlot={forSlot} onLogout={onLogout}>
        <ErrorBoundary resetKeys={[location.pathname]}>
          <Routes>
            {/* Global Home — workspace-agnostic landing (greeting +
                workspaces grid). Chat, Conversations, Tasks, Files
                are all identity-bound now, so the root URL is the
                user's cross-workspace home. */}
            <Route path="/" element={<GlobalHomePage />} />

            {/* Workspace-scoped routes: /w/:slug/... — the slug is the single
                source of truth for the focused workspace. WorkspaceRouteGuard
                validates membership (unknown / non-member slug → home) and
                syncs the slug into context. Everything workspace-scoped —
                overview, apps, AND settings — lives here so it can never open
                on a workspace the user can't see. */}
            <Route path="/w/:slug" element={<WorkspaceRouteGuard />}>
              {/* Workspace overview — header + app grid. */}
              <Route index element={<WorkspaceOverviewPage />} />
              {/* Identity views (Conversations / Tasks / Files) — each at
                  its own segment (e.g. `/w/<slug>/conversations`). The view is
                  workspace-scoped (the slug = the focused workspace); the tools
                  still dispatch bare through the identity door (see the bridge,
                  keyed on `isIdentityApp`, not the URL). */}
              {identityAppPlacements.map((p) => (
                <Route
                  key={p.route}
                  path={identityAppSegment(p.serverName)}
                  element={<AppWithChat placement={p} />}
                />
              ))}
              {/* Apps within workspace */}
              {appPlacements.map((p) => (
                <Route
                  key={p.route}
                  path={`app/${p.route}`}
                  element={<AppWithChat placement={p} />}
                />
              ))}
              {/* Full-page context inspector for a conversation — opened from the
                  chat's In-context panel. Renders in the main area beside the
                  docked chat (the `/w/` prefix keeps ChatChrome mounted). */}
              <Route path="context/:convId" element={<ContextInspectorPage />} />
              {/* The inbox is host chrome, not a placement: it belongs to the
                  workspace rather than to any connector, and no connector may
                  claim, reorder, or replace it. */}
              <Route path="notifications" element={<NotificationsPage />} />
              {/* Workspace settings — General/Members/Connectors/Skills/MCP/Notifications/Webhooks. */}
              <Route path="settings" element={<WorkspaceSettingsPage />}>
                <Route
                  index
                  element={<Navigate to={landingTab(WORKSPACE_SETTINGS_TABS)} replace />}
                />
                <Route path="general" element={<WorkspaceGeneralTab />} />
                <Route path="members" element={<WorkspaceMembersTab />} />
                <Route path="connectors" element={<WorkspaceConnectorsTab />} />
                <Route path="connectors/browse" element={<ConnectorBrowsePage />} />
                <Route path="connectors/:serverName" element={<ConnectorDetailPage />} />
                <Route path="skills" element={<SkillsTab />} />
                <Route path="mcp" element={<WorkspaceMcpTab />} />
                <Route path="notifications" element={<WorkspaceNotificationsTab />} />
                <Route path="webhooks" element={<WorkspaceWebhooksTab />} />
              </Route>
              {/* Unmatched path INSIDE a workspace. This has to be a child of
                  `/w/:slug`, not the top-level splat: the router ranks by
                  specificity, so a top-level `*` swallows `/w/<slug>/…` whole
                  and `WorkspaceRouteGuard` never mounts. The guard is what
                  projects the slug onto the ambient workspace, so without it the
                  shell keeps serving the previously-focused workspace's
                  placements — and an app that IS installed one workspace over
                  gets reported as gone (Back after a switch, or a shared
                  `/w/<other>/app/<x>` link). Entering the branch also lets the
                  guard switch the workspace so the route can materialise. */}
              <Route
                path="*"
                element={<WorkspaceNotFoundPage shellWorkspaceId={shellWorkspaceId} />}
              />
            </Route>

            {/* Profile — top-level, identity-bound. Tabbed surface
                following the /org/* pattern. Future identity-level
                config (custom instructions, model prefs) slots in
                alongside the Skills tab. */}
            <Route path="/profile" element={<ProfilePage />}>
              <Route
                index
                element={<Navigate to={`/profile/${landingTab(PROFILE_TABS)}`} replace />}
              />
              <Route path="general" element={<ProfileTab />} />
              <Route path="connectors" element={<ProfileConnectorsTab />} />
              <Route path="skills" element={<ProfileSkillsTab />} />
            </Route>

            {/* Organization settings — dedicated top-level home, org-admin
                scoped. Everything here affects the org as a whole (global
                model config, the full workspace/user roster), so
                it lives outside any workspace URL. About is role-exempt. */}
            <Route path="/org" element={<OrgSettingsPage />}>
              <Route
                index
                element={<Navigate to={`/org/${landingTab(ORG_SETTINGS_TABS)}`} replace />}
              />
              <Route
                path="model"
                element={
                  <RouteGuard requireRole="org_admin">
                    <ModelTab />
                  </RouteGuard>
                }
              />
              <Route
                path="workspaces"
                element={
                  <RouteGuard requireRole="org_admin">
                    <WorkspacesTab />
                  </RouteGuard>
                }
              />
              <Route
                path="workspaces/:slug"
                element={
                  <RouteGuard requireRole="org_admin">
                    <WorkspaceDetailPage />
                  </RouteGuard>
                }
              />
              <Route
                path="archives"
                element={
                  <RouteGuard requireRole="org_admin">
                    <OrgArchivesTab />
                  </RouteGuard>
                }
              />
              <Route
                path="users"
                element={
                  <RouteGuard requireRole="org_admin">
                    <UsersTab />
                  </RouteGuard>
                }
              />
              <Route
                path="usage"
                element={
                  <RouteGuard requireRole="org_admin">
                    <OrgUsageTab />
                  </RouteGuard>
                }
              />
              <Route
                path="skills"
                element={
                  <RouteGuard requireRole="org_admin">
                    <OrgSkillsTab />
                  </RouteGuard>
                }
              />
              <Route path="about" element={<OrgAboutTab />} />
            </Route>

            {/* Nothing matched, outside any workspace. Must exist: an unmatched
                path otherwise renders `null` into the main area, which reads as
                a broken app rather than a bad URL. Workspace-scoped misses are
                handled by the sibling splat under `/w/:slug` — see the note
                there for why they can't be served from here. Nothing outside a
                workspace depends on shell placements, so this one is always
                settled. */}
            <Route path="*" element={<NotFoundPage settled />} />
          </Routes>
        </ErrorBoundary>
      </ShellLayout>
    </ShellProvider>
  );
}

/**
 * Non-rendering component that handles iframe action events (nb:action).
 * Isolated here so that consuming the chat panel context doesn't re-render
 * the shell layout.
 */
function ActionBridge({
  handleNavigate,
  resolveAppRoute,
  activeSlug,
}: {
  handleNavigate: (route: string, state?: AppRouteState) => void;
  resolveAppRoute: (name: string) => string | null;
  activeSlug: string | null;
}) {
  const chatPanel = useChatPanelContext();

  // Use refs so the event handler doesn't need to re-register on every
  // render — only the ref contents update.
  const chatPanelRef = useRef(chatPanel);
  chatPanelRef.current = chatPanel;
  const navigateRef = useRef(handleNavigate);
  navigateRef.current = handleNavigate;
  const resolveRef = useRef(resolveAppRoute);
  resolveRef.current = resolveAppRoute;
  const slugRef = useRef(activeSlug);
  slugRef.current = activeSlug;

  useEffect(() => {
    // Dispatch table keyed by action name. Each handler reads current state
    // through the refs, so the listener registers once and unknown actions
    // no-op. Params carry the event detail (`id`, `name`, and the bridge's
    // `serverName`).
    const actions: Record<string, (params: Record<string, unknown>) => void> = {
      openConversation(params) {
        if (params.id) chatPanelRef.current.openPanel(params.id as string);
      },
      // `target` is a view inside the app (its stable address); the routed
      // app view hands it to the app as `ai.nimblebrain/navigate`.
      openApp(params) {
        const name = params.name as string | undefined;
        if (!name) return;
        const route = resolveRef.current(name);
        if (!route) return;
        const target = typeof params.target === "string" ? params.target : undefined;
        navigateRef.current(route, target ? { appTarget: target } : undefined);
      },
      // The sending connector's own settings page. The connector is the one the
      // bridge names, never a param, so an app can open only its own. Identity
      // apps have no workspace settings page, so they no-op.
      openConnectorSettings(params) {
        const serverName = params.serverName as string | undefined;
        if (!serverName) return;
        const path = connectorSettingsPath(slugRef.current, serverName);
        if (path) navigateRef.current(path);
      },
    };

    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.action) return;
      // Own-key guard so an inherited name (constructor/__proto__) on the event
      // detail can't resolve to an Object.prototype member; unknown actions no-op.
      const action = detail.action as string;
      if (Object.hasOwn(actions, action)) {
        actions[action]?.(detail as Record<string, unknown>);
      }
    };

    window.addEventListener("nb:action", handler);

    // The agent's `nb__open_app`, once it finishes in a turn this tab sent: the
    // same `openApp` an app asks for. The store never reports a call from
    // history, a resumed stream, or another tab, so only the screen of the
    // person who asked moves.
    const offToolDone = chatStore.onToolDone((call) => {
      if (!call.ok || !isOpenAppCall(call.name)) return;
      actions.openApp?.({ name: call.input.app, target: call.input.target });
    });

    return () => {
      window.removeEventListener("nb:action", handler);
      offToolDone();
    };
  }, []); // Stable — all dependencies are refs

  return null;
}

export function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [checking, setChecking] = useState(true);

  // Tab-lifetime cleanup. `pagehide` fires on tab close, navigation away,
  // and bfcache enter — earlier and more reliable than `beforeunload`,
  // and it lets the server reclaim the SSE slots immediately rather than
  // waiting for the TCP teardown to be noticed by the next failed
  // enqueue. The TCP teardown path still works as a fallback.
  useEffect(() => {
    const onPageHide = (): void => {
      closeEventsClient();
      // Close per-conversation turn-stream sockets so the server reclaims
      // SSE slots immediately. Slices stay intact for a bfcache restore.
      chatStore.closeAllConnections();
    };
    // bfcache restore: the page is revived from memory with sockets closed but
    // slice state (incl. `isStreaming`) intact, and React effects do NOT re-run.
    // Re-open a resume stream for every still-streaming slice — otherwise the
    // spinner is wedged forever (no connection, isStreaming pinned true). The
    // resume reconciles: still-running turns re-tail; finished ones clear.
    const onPageShow = (e: PageTransitionEvent): void => {
      if (e.persisted) chatStore.reattachStreaming();
    };
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, []);

  const handleLogout = useCallback(async () => {
    // Wait for the server to clear the session cookies before showing the
    // login screen. Its first act is a bootstrap probe, and one sent while the
    // cookie is still set succeeds and signs the user straight back in.
    await logout();
    setAuthToken(null);
    setBootstrap(null);
    setAuthenticated(false);
    clearSentryContext();
  }, []);

  const initFromBootstrap = useCallback(
    (data: BootstrapResponse) => {
      setAuthToken("__cookie__");
      // onAuthError fires only after silent token refresh has already failed
      setOnAuthError(handleLogout);
      // The active workspace is not set here: WorkspaceProvider seeds it on
      // mount and the route guard projects the URL onto it. A write from here
      // lands whenever bootstrap resolves, which can be after the guard's.

      setPlatformVersion(data.version, data.buildSha);
      setBootstrap(data);
      setAuthenticated(true);
    },
    [handleLogout],
  );

  // Single auth check: try bootstrap. Authenticated → render app. Not → show login.
  // Bootstrap carries no workspace hint — the focused workspace is owned by
  // the URL (`/w/:slug`), and login lands on `/` (the workspace-agnostic home).
  useEffect(() => {
    let cancelled = false;
    tryBootstrap().then((data) => {
      if (cancelled) return;
      if (data) initFromBootstrap(data);
      setChecking(false);
    });
    return () => {
      cancelled = true;
    };
  }, [initFromBootstrap]);

  if (checking) return <AppFrameSkeleton />;

  if (!authenticated || !bootstrap) {
    return <Login onLogin={initFromBootstrap} />;
  }

  return (
    <BrowserRouter>
      <AuthenticatedApp token="__cookie__" onLogout={handleLogout} bootstrap={bootstrap} />
    </BrowserRouter>
  );
}
