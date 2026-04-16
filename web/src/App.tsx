import { useCallback, useEffect, useRef, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import type { ShellData } from "./api/client";
import {
  callTool,
  logout,
  setActiveWorkspaceId,
  setAuthToken,
  setOnAuthError,
  setPlatformVersion,
  tryBootstrap,
} from "./api/client";
import { AppWithChat } from "./components/AppWithChat";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Login } from "./components/Login";
import { ShellLayout } from "./components/ShellLayout";
import { WorkspaceRouteGuard } from "./components/WorkspaceRouteGuard";
import { ChatProvider, useChatConfigContext, useChatContext } from "./context/ChatContext";
import { ChatPanelProvider, useChatPanelContext } from "./context/ChatPanelContext";
import { SessionProvider } from "./context/SessionContext";
import { ShellProvider } from "./context/ShellContext";
import { SidebarProvider } from "./context/SidebarContext";
import { ThemeProvider, useTheme } from "./context/ThemeContext.tsx";
import type { WorkspaceInfo } from "./context/WorkspaceContext";
import { useWorkspaceContext, WorkspaceProvider } from "./context/WorkspaceContext";
import { useDataSync } from "./hooks/useDataSync";
import { useEvents } from "./hooks/useEvents";
import { useShell } from "./hooks/useShell";
import { toSlug } from "./lib/workspace-slug";
import { SettingsPage } from "./pages/SettingsPage";
import { ModelTab } from "./pages/settings/ModelTab";
import { ProfileTab } from "./pages/settings/ProfileTab";
import { SettingsAppPanel } from "./pages/settings/SettingsAppPanel";
import { UsageTab } from "./pages/settings/UsageTab";
import { UsersTab } from "./pages/settings/UsersTab";
import { WorkspaceDetailPage } from "./pages/settings/WorkspaceDetailPage";
import { WorkspacesTab } from "./pages/settings/WorkspacesTab";
import { AboutTab } from "./pages/settings/AboutTab";
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

  // Map bootstrap workspace shape to WorkspaceInfo for the provider
  const initialWorkspaces: WorkspaceInfo[] = bootstrap.workspaces.map((ws) => ({
    id: ws.id,
    name: ws.name,
    memberCount: ws.memberCount,
    bundles: [],
  }));

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
  const { loading, error, forSlot, mainRoutes } = useShell(
    token,
    activeWorkspace?.id,
    initialShell,
  );

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
      <ChatProvider initialConfig={initialConfig} currentUserId={currentUserId}>
        <ChatPanelProvider>
          <AuthenticatedAppContent
            token={token}
            forSlot={forSlot}
            mainRoutes={mainRoutes}
            onLogout={onLogout}
          />
        </ChatPanelProvider>
      </ChatProvider>
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
  onLogout,
}: {
  token: string;
  forSlot: (slot: string) => PlacementEntry[];
  mainRoutes: () => PlacementEntry[];
  onLogout: () => void;
}) {
  const config = useChatConfigContext();
  const { applyPreference } = useTheme();
  const wsCtx = useWorkspaceContext();
  const onDataChanged = useDataSync();
  useEvents(token, wsCtx.activeWorkspace?.id, {
    onDataChanged,
    onConfigChanged: () => config.refreshConfig(),
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

  const homePlacement = allRoutable.find((p) => p.route === "/");
  const appPlacements = allRoutable.filter((p) => p.route !== "/");

  return (
    <ShellProvider value={{ forSlot, mainRoutes }}>
      {/* ActionBridge handles iframe action events. It consumes ChatContext
          (streaming) but renders nothing, so its re-renders are free. */}
      <ActionBridge handleNavigate={handleNavigate} resolveAppRoute={resolveAppRoute} />
      <ShellLayout forSlot={forSlot} onLogout={onLogout}>
        <ErrorBoundary resetKeys={[location.pathname]}>
          <Routes>
            {/* Root → redirect to workspace-scoped home */}
            <Route path="/" element={<WorkspaceRedirect />} />

            {/* Workspace-scoped routes: /w/:slug/... */}
            <Route path="/w/:slug" element={<WorkspaceRouteGuard />}>
              {/* Workspace home */}
              {homePlacement ? (
                <Route
                  index
                  element={<AppWithChat placement={homePlacement} onNavigate={handleNavigate} />}
                />
              ) : (
                <Route
                  index
                  element={<div className="p-6 text-muted-foreground">No home app installed.</div>}
                />
              )}
              {/* Apps within workspace */}
              {appPlacements.map((p) => (
                <Route
                  key={p.route}
                  path={`app/${p.route}`}
                  element={<AppWithChat placement={p} onNavigate={handleNavigate} />}
                />
              ))}
            </Route>

            {/* Settings routes — global, not workspace-scoped */}
            <Route path="/settings" element={<SettingsPage />}>
              <Route index element={<ProfileTab />} />
              <Route path="model" element={<ModelTab />} />
              <Route path="usage" element={<UsageTab />} />
              <Route path="users" element={<UsersTab />} />
              <Route path="workspaces" element={<WorkspacesTab />} />
              <Route path="workspaces/:slug" element={<WorkspaceDetailPage />} />
              <Route path="about" element={<AboutTab />} />
              <Route path="apps/:serverName" element={<SettingsAppPanel />} />
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

/** Redirect "/" to "/w/<active-workspace-slug>/" */
function WorkspaceRedirect() {
  const { activeWorkspace, workspaces, loading } = useWorkspaceContext();
  if (loading)
    return (
      <div className="flex items-center justify-center h-screen text-muted-foreground text-sm">
        Loading...
      </div>
    );
  const ws = activeWorkspace ?? workspaces[0];
  if (!ws) return <Navigate to="/settings" replace />;
  return <Navigate to={`/w/${toSlug(ws.id)}/`} replace />;
}

export function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [checking, setChecking] = useState(true);

  const handleLogout = useCallback(() => {
    logout();
    setAuthToken(null);
    setBootstrap(null);
    setAuthenticated(false);
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
  useEffect(() => {
    const preferred = localStorage.getItem("nb_active_workspace") ?? undefined;
    tryBootstrap(preferred).then((data) => {
      if (data) initFromBootstrap(data);
      setChecking(false);
    });
  }, [initFromBootstrap]);

  const handleLogin = useCallback(() => {
    // After OIDC redirect callback, the page reloads and bootstrap succeeds.
    // This is called when Login detects a successful bootstrap after redirect.
    const preferred = localStorage.getItem("nb_active_workspace") ?? undefined;
    tryBootstrap(preferred).then((data) => {
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
