import { useCallback, useEffect, useRef, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import type { ShellData } from "./api/client";
import {
  callTool,
  logout,
  setActiveWorkspaceId,
  setAuthToken,
  setOnAuthError,
  setOnWorkspaceError,
  setPlatformVersion,
  tryBootstrap,
} from "./api/client";
import { closeEventsClient } from "./api/events-client";
import { AppWithChat } from "./components/AppWithChat";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Login } from "./components/Login";
import { CommandPalette } from "./components/palette/CommandPalette";
import { RouteGuard } from "./components/RouteGuard";
import { ShellLayout } from "./components/ShellLayout";
import { WorkspaceRouteGuard } from "./components/WorkspaceRouteGuard";
import { ChatProvider, useChatConfigContext, useChatContext } from "./context/ChatContext";
import { ArtifactPanelProvider } from "./context/ArtifactPanelContext";
import { ChatPanelProvider, useChatPanelContext } from "./context/ChatPanelContext";
import { FocusedAppProvider } from "./context/FocusedAppContext";
import { PaletteProvider } from "./context/PaletteContext";
import { SessionProvider } from "./context/SessionContext";
import { ShellProvider } from "./context/ShellContext";
import { SidebarProvider } from "./context/SidebarContext";
import { ThemeProvider, useTheme } from "./context/ThemeContext.tsx";
import { WorkspaceAppIconsProvider } from "./context/WorkspaceAppIconsProvider";
import {
  useWorkspaceContext,
  type WorkspaceInfo,
  WorkspaceProvider,
} from "./context/WorkspaceContext";
import { chatStore } from "./hooks/chat-store";
import { useDataSync } from "./hooks/useDataSync";
import { forwardConversationTitleToIframes } from "./lib/forward-conversation-title";
import { useEvents } from "./hooks/useEvents";
import { useShell } from "./hooks/useShell";
import { bootstrapWorkspacesToInfo } from "./lib/bootstrap";
import { identityAppRoute, isIdentityApp } from "./lib/identity-apps";
import { recoverFromWorkspaceError } from "./lib/workspace-recovery";
import { toSlug } from "./lib/workspace-slug";
import { GlobalHomePage } from "./pages/GlobalHomePage";
import { ProfilePage } from "./pages/ProfilePage";
import { ProfileSkillsTab } from "./pages/settings/ProfileSkillsTab";
import { ProfileTab } from "./pages/settings/ProfileTab";
import { ConnectorBrowsePage } from "./pages/settings/ConnectorBrowsePage";
import { ConnectorDetailPage } from "./pages/settings/ConnectorDetailPage";
import { ModelTab } from "./pages/settings/ModelTab";
import { OrgAboutTab } from "./pages/settings/OrgAboutTab";
import { OrgRegistriesTab } from "./pages/settings/OrgRegistriesTab";
import { OrgSettingsPage } from "./pages/settings/OrgSettingsPage";
import { OrgSkillsTab } from "./pages/settings/OrgSkillsTab";
import { OrgUsageTab } from "./pages/settings/OrgUsageTab";
import { SettingsAppPanel } from "./pages/settings/SettingsAppPanel";
import { SkillsTab } from "./pages/settings/SkillsTab";
import { UsersTab } from "./pages/settings/UsersTab";
import { WorkspaceAppsTab } from "./pages/settings/WorkspaceAppsTab";
import { WorkspaceConnectorsTab } from "./pages/settings/WorkspaceConnectorsTab";
import { WorkspaceDetailPage } from "./pages/settings/WorkspaceDetailPage";
import { WorkspaceGeneralTab } from "./pages/settings/WorkspaceGeneralTab";
import { WorkspaceMembersTab } from "./pages/settings/WorkspaceMembersTab";
import { WorkspaceSettingsPage } from "./pages/settings/WorkspaceSettingsPage";
import { WorkspacesTab } from "./pages/settings/WorkspacesTab";
import { WorkspaceOverviewPage } from "./pages/WorkspaceOverviewPage";
import { clearSentryContext, setSentryUser } from "./sentry";
import { initTelemetry } from "./telemetry";
import type { BootstrapResponse, PlacementEntry } from "./types";
import "./index.css";

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
    callTool("nb", "workspace_info", {})
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

  const initialShell: ShellData = bootstrap.shell;

  const initialConfig = {
    configuredProviders: bootstrap.config.configuredProviders,
    defaultModel: bootstrap.config.models.default ?? "",
    preferences: bootstrap.user.preferences,
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
    <ThemeProvider>
      <SessionProvider session={session}>
        <WorkspaceProvider
          initialWorkspaces={initialWorkspaces}
          initialActiveId={bootstrap.activeWorkspace ?? undefined}
        >
          <BootstrappedShell
            token={token}
            initialShell={initialShell}
            initialConfig={initialConfig}
            currentUserId={bootstrap.user.id}
            onLogout={onLogout}
          />
        </WorkspaceProvider>
      </SessionProvider>
    </ThemeProvider>
  );
}

/** Inner component that has access to WorkspaceContext (needed for useShell workspace switch). */
function BootstrappedShell({
  token,
  initialShell,
  initialConfig,
  currentUserId,
  onLogout,
}: {
  token: string;
  initialShell: ShellData;
  initialConfig: {
    configuredProviders: string[];
    defaultModel: string;
    preferences?: { displayName?: string; timezone?: string; locale?: string; theme?: string };
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
  } = useShell(token, activeWorkspace?.id, initialShell);

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
          className="px-4 py-2 text-sm bg-secondary text-secondary-foreground rounded-md hover:bg-accent transition-colors"
          onClick={() => window.location.reload()}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <SidebarProvider>
      <WorkspaceAppIconsProvider token={token} workspaceId={activeWorkspace?.id}>
        <ChatProvider initialConfig={initialConfig} currentUserId={currentUserId}>
          <ChatPanelProvider>
            <ArtifactPanelProvider>
              <PaletteProvider>
                <FocusedAppProvider>
                  <AuthenticatedAppContent
                    token={token}
                    forSlot={forSlot}
                    mainRoutes={mainRoutes}
                    shellWorkspaceId={shellWorkspaceId}
                    refreshShell={refreshShell}
                    onLogout={onLogout}
                  />
                </FocusedAppProvider>
              </PaletteProvider>
            </ArtifactPanelProvider>
          </ChatPanelProvider>
        </ChatProvider>
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
  token,
  forSlot,
  mainRoutes,
  shellWorkspaceId,
  refreshShell,
  onLogout,
}: {
  token: string;
  forSlot: (slot: string) => PlacementEntry[];
  mainRoutes: () => PlacementEntry[];
  shellWorkspaceId: string | undefined;
  refreshShell: () => Promise<void>;
  onLogout: () => void;
}) {
  const config = useChatConfigContext();
  const { applyPreference } = useTheme();
  const wsCtx = useWorkspaceContext();
  const onDataChanged = useDataSync();
  useEvents(token, wsCtx.activeWorkspace?.id, {
    onDataChanged,
    onConfigChanged: () => config.refreshConfig(),
    // Auto-title arrived — update the matching conversation's slice so the
    // chat panel header reflects it live (routed by conversationId), and
    // forward to the conversations-list iframe so its sidebar row updates
    // in place without a full list refetch.
    onConversationTitle: ({ conversationId, title }) => {
      chatStore.setTitle(conversationId, title);
      forwardConversationTitleToIframes(conversationId, title);
    },
    // Bundle install / uninstall changes the placement set; refetch
    // the shell so the sidebar's Apps group reflects the new state
    // without a page reload.
    onBundleLifecycleChanged: () => {
      void refreshShell();
    },
    // After a reconnect, any bundle / config events emitted during the
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

  // Recover from a stale/invalid workspace context. A data call that fires
  // with an X-Workspace-Id the server rejects (deleted workspace, lost
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
      );
    });
    return () => setOnWorkspaceError(null);
  }, [wsCtx, navigate]);

  const handleNavigate = useCallback(
    (route: string) => {
      if (route.startsWith("/")) {
        navigate(route);
      } else {
        // App routes get workspace prefix: /w/<slug>/app/<route>
        const prefix = activeSlug ? `/w/${activeSlug}` : "";
        navigate(`${prefix}/app/${route}`);
      }
    },
    [navigate, activeSlug],
  );

  // Resolve an app name to its placement route. Apps emit just a name (e.g. "typst-pdf");
  // the shell owns the route mapping (e.g. "@nimblebraininc/typst-pdf").
  const resolveAppRoute = useCallback(
    (name: string): string | null => {
      // Search ALL placements (not just mainRoutes) so sidebar.apps are included
      const all = forSlot("sidebar").concat(forSlot("main")).concat(forSlot("sidebar.bottom"));
      // Exact route match first
      const exact = all.find((p) => p.route === name);
      if (exact) return exact.route!;
      // Match by serverName (what bundles know themselves as)
      const byServer = all.find((p) => p.serverName === name);
      if (byServer?.route) return byServer.route;
      return null;
    },
    [forSlot],
  );

  // Collect all routable placements from main + sidebar (deduplicated by route).
  // Sidebar placements can have routes too (e.g., Home at "/", Conversations).
  const mainPlacementRoutes = mainRoutes();
  const sidebarRoutes = forSlot("sidebar").filter(
    (p) => p.route && !p.slot.startsWith("sidebar.bottom"),
  );
  const seen = new Set<string>();
  const allRoutable: PlacementEntry[] = [];
  for (const p of [...sidebarRoutes, ...mainPlacementRoutes]) {
    if (p.route && !seen.has(p.route)) {
      seen.add(p.route);
      allRoutable.push(p);
    }
  }

  // App placements: everything routable except the bundle-home placement
  // (route "/"), which the shell no longer renders directly. Home `/` is
  // now `GlobalHomePage` (workspace-agnostic) and `/w/<slug>/` is
  // `WorkspaceOverviewPage` (app grid). The bundle-home concept stays in
  // the placement registry for now in case a future surface needs it.
  // Identity apps (conversations, …) are also excluded — they render at a
  // top-level root route outside any workspace (see `identityAppPlacements`).
  const appPlacements = allRoutable.filter((p) => p.route !== "/" && !isIdentityApp(p.serverName));

  // Identity apps — owned by the user, hosted OUTSIDE any workspace, each at
  // its own top-level route (e.g. `/conversations`). They route through the
  // identity door (the bridge dispatches their tools bare), so they don't
  // belong under `/w/<slug>`.
  const identityAppPlacements = allRoutable.filter((p) => isIdentityApp(p.serverName));

  return (
    <ShellProvider value={{ forSlot, mainRoutes, shellWorkspaceId }}>
      {/* ActionBridge handles iframe action events. It consumes ChatContext
          (streaming) but renders nothing, so its re-renders are free. */}
      <ActionBridge handleNavigate={handleNavigate} resolveAppRoute={resolveAppRoute} />
      {/* Command palette (⌘P) — global surface, sibling of the shell layout
          and chat chrome, so it's reachable from any route. */}
      <CommandPalette onLogout={onLogout} />
      <ShellLayout forSlot={forSlot} onLogout={onLogout}>
        <ErrorBoundary resetKeys={[location.pathname]}>
          <Routes>
            {/* Global Home — workspace-agnostic landing (greeting +
                workspaces grid). Chat, Conversations, Automations, Files
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
              {/* Apps within workspace */}
              {appPlacements.map((p) => (
                <Route
                  key={p.route}
                  path={`app/${p.route}`}
                  element={<AppWithChat placement={p} onNavigate={handleNavigate} />}
                />
              ))}
              {/* Workspace settings — General/Members/Usage/Apps/Connectors/Skills. */}
              <Route path="settings" element={<WorkspaceSettingsPage />}>
                <Route index element={<Navigate to="general" replace />} />
                <Route path="general" element={<WorkspaceGeneralTab />} />
                <Route path="members" element={<WorkspaceMembersTab />} />
                <Route path="apps" element={<WorkspaceAppsTab />} />
                <Route path="apps/:serverName" element={<SettingsAppPanel />} />
                <Route path="connectors" element={<WorkspaceConnectorsTab />} />
                <Route path="connectors/browse" element={<ConnectorBrowsePage />} />
                <Route path="connectors/:serverName" element={<ConnectorDetailPage />} />
                <Route path="skills" element={<SkillsTab />} />
              </Route>
            </Route>

            {/* Identity apps — owned by the user, hosted OUTSIDE any
                workspace, each at a top-level route (e.g. /conversations).
                They dispatch their tools bare through the identity door; no
                /w/<slug> prefix, no workspace required to load. */}
            {identityAppPlacements.map((p) => (
              <Route
                key={p.route}
                path={identityAppRoute(p.serverName)}
                element={<AppWithChat placement={p} onNavigate={handleNavigate} />}
              />
            ))}

            {/* Profile — top-level, identity-bound. Tabbed surface
                following the /org/* pattern. Future identity-level
                config (custom instructions, model prefs) slots in
                alongside the Skills tab. */}
            <Route path="/profile" element={<ProfilePage />}>
              <Route index element={<Navigate to="/profile/general" replace />} />
              <Route path="general" element={<ProfileTab />} />
              <Route path="skills" element={<ProfileSkillsTab />} />
            </Route>

            {/* Organization settings — dedicated top-level home, org-admin
                scoped. Everything here affects the org as a whole (global
                model config, the full workspace/user roster, registries), so
                it lives outside any workspace URL. About is role-exempt. */}
            <Route path="/org" element={<OrgSettingsPage />}>
              <Route index element={<Navigate to="/org/workspaces" replace />} />
              <Route
                path="model"
                element={
                  <RouteGuard role="org_admin">
                    <ModelTab />
                  </RouteGuard>
                }
              />
              <Route
                path="workspaces"
                element={
                  <RouteGuard role="org_admin">
                    <WorkspacesTab />
                  </RouteGuard>
                }
              />
              <Route
                path="workspaces/:slug"
                element={
                  <RouteGuard role="org_admin">
                    <WorkspaceDetailPage />
                  </RouteGuard>
                }
              />
              <Route
                path="users"
                element={
                  <RouteGuard role="org_admin">
                    <UsersTab />
                  </RouteGuard>
                }
              />
              <Route
                path="usage"
                element={
                  <RouteGuard role="org_admin">
                    <OrgUsageTab />
                  </RouteGuard>
                }
              />
              <Route
                path="registries"
                element={
                  <RouteGuard role="org_admin">
                    <OrgRegistriesTab />
                  </RouteGuard>
                }
              />
              <Route
                path="skills"
                element={
                  <RouteGuard role="org_admin">
                    <OrgSkillsTab />
                  </RouteGuard>
                }
              />
              <Route path="about" element={<OrgAboutTab />} />
            </Route>
          </Routes>
        </ErrorBoundary>
      </ShellLayout>
    </ShellProvider>
  );
}

/**
 * Non-rendering component that handles iframe action events (nb:action).
 * Isolated here so that consuming ChatContext (streaming) doesn't re-render
 * the shell layout.
 */
function ActionBridge({
  handleNavigate,
  resolveAppRoute,
}: {
  handleNavigate: (route: string) => void;
  resolveAppRoute: (name: string) => string | null;
}) {
  const chatPanel = useChatPanelContext();
  const chat = useChatContext();

  // Use refs so the event handler doesn't need to re-register on every
  // streaming tick — only the ref contents update.
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const chatPanelRef = useRef(chatPanel);
  chatPanelRef.current = chatPanel;
  const navigateRef = useRef(handleNavigate);
  navigateRef.current = handleNavigate;
  const resolveRef = useRef(resolveAppRoute);
  resolveRef.current = resolveAppRoute;

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.action) return;

      const action = detail.action as string;
      const params = detail as Record<string, unknown>;

      switch (action) {
        case "openConversation":
          if (params.id) chatPanelRef.current.openPanel(params.id as string);
          break;
        case "startChat": {
          chatPanelRef.current.openPanel();
          const prompt = params.prompt as string | undefined;
          if (prompt) chatRef.current.sendMessage(prompt);
          break;
        }
        case "openApp": {
          const name = params.name as string | undefined;
          if (!name) break;
          const route = resolveRef.current(name);
          if (route) navigateRef.current(route);
          break;
        }
        case "navigate":
          if (params.route) navigateRef.current(params.route as string);
          break;
      }
    };

    window.addEventListener("nb:action", handler);
    return () => window.removeEventListener("nb:action", handler);
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

  const handleLogout = useCallback(() => {
    logout();
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

      if (data.activeWorkspace) {
        setActiveWorkspaceId(data.activeWorkspace);
      } else if (data.workspaces.length > 0) {
        setActiveWorkspaceId(data.workspaces[0].id);
      }

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
    tryBootstrap().then((data) => {
      if (data) initFromBootstrap(data);
      setChecking(false);
    });
  }, [initFromBootstrap]);

  const handleLogin = useCallback(() => {
    // After OIDC redirect callback, the page reloads and bootstrap succeeds.
    // This is called when Login detects a successful bootstrap after redirect.
    tryBootstrap().then((data) => {
      if (data) initFromBootstrap(data);
    });
  }, [initFromBootstrap]);

  if (checking) {
    return (
      <div className="flex items-center justify-center h-screen bg-background text-muted-foreground text-sm">
        Loading...
      </div>
    );
  }

  if (!authenticated || !bootstrap) {
    return <Login onLogin={handleLogin} />;
  }

  return (
    <BrowserRouter>
      <AuthenticatedApp token="__cookie__" onLogout={handleLogout} bootstrap={bootstrap} />
    </BrowserRouter>
  );
}
