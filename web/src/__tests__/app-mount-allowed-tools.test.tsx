// ---------------------------------------------------------------------------
// An app's own page is told which of its connector's tools the viewer may call.
//
// `AppWithChat` mounts a workspace app's routed placement and hands the app
// `hostContext.connector.allowedTools`: the list the server put on the app's
// installed-connector entry, decided per caller by the same gate that refuses a
// call (covered in test/integration/connector-admin-tools.test.ts). The page
// passes it through and never derives it: no role reaches the app, and
// `canManage` stays on the settings page alone. A role change re-reads the list
// and reaches the mounted iframe through `host-context-changed`. An identity app
// (Conversations, Files, Tasks) belongs to no connector, so its mount carries no
// `connector` key.
//
// The settings-page mount is pinned in connector-settings-section.test.tsx.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { realClient } from "../../test/setup";
import type * as ApiClient from "../api/client";
import type { InstalledConnector } from "../api/client";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** What the server answers each `list_installed`, by server name; a test sets it. */
let serverAllowed: Record<string, string[]> = {};

function entry(serverName: string, allowedTools: string[]): InstalledConnector {
  return {
    serverName,
    connectorName: serverName,
    displayName: serverName,
    disconnectable: false,
    version: "1.0.0",
    state: "running",
    status: "ready",
    scope: "workspace",
    interactive: true,
    toolCount: allowedTools.length,
    allowedTools,
  };
}

const getInstalledConnectors = mock<typeof ApiClient.getInstalledConnectors>(async () => ({
  installed: Object.entries(serverAllowed).map(([name, tools]) => entry(name, [...tools])),
}));

mock.module("../api/client", () => ({
  ...realClient,
  getResources: mock(async () => ({ html: "<p>app</p>" })),
  getInstalledConnectors,
}));

mock.module("../api/conversation-stream", () => ({
  connectConversationStream: () => ({ close() {} }),
}));

const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter } = await import("react-router-dom");
const { NoticeProvider } = await import("../components/notices");
const { ChatProvider } = await import("../context/ChatContext");
const { ChatPanelProvider } = await import("../context/ChatPanelContext");
const { ThemeProvider } = await import("../context/ThemeContext");
const { WorkspaceProvider, useWorkspaceContext } = await import("../context/WorkspaceContext");
const { WorkspaceAppIconsProvider } = await import("../context/WorkspaceAppIconsProvider");
const { AppWithChat } = await import("../components/AppWithChat");

import type { ReactNode } from "react";
import type { WorkspaceInfo } from "../context/WorkspaceContext";
import type { PlacementEntry } from "../types";

const WS_ID = "ws_00079598e311c160";

function workspace(userRole?: "admin" | "member"): WorkspaceInfo {
  return {
    id: WS_ID,
    name: "Alpha",
    connectorCount: 2,
    memberCount: 2,
    ...(userRole ? { userRole } : {}),
  };
}

function appPlacement(serverName: string): PlacementEntry {
  return {
    serverName,
    slot: "sidebar.apps",
    resourceUri: `ui://${serverName}/main`,
    route: serverName,
    priority: 0,
  };
}

let setWorkspace: ((ws: WorkspaceInfo) => void) | null = null;
function CaptureSetter() {
  setWorkspace = useWorkspaceContext().setActiveWorkspace;
  return null;
}

/** The shell's wiring (`App.tsx`): the provider follows the active workspace and the viewer's role in it. */
function ConnectorsFromActiveWorkspace({ children }: { children: ReactNode }) {
  const { activeWorkspace } = useWorkspaceContext();
  return (
    <WorkspaceAppIconsProvider
      workspaceId={activeWorkspace?.id}
      viewerRole={activeWorkspace?.userRole}
    >
      {children}
    </WorkspaceAppIconsProvider>
  );
}

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof ReactDOMClient.createRoot> | null = null;

beforeEach(() => {
  getInstalledConnectors.mockClear();
  serverAllowed = {};
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  setWorkspace = null;
});

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function mountApp(ws: WorkspaceInfo, placement: PlacementEntry): Promise<HTMLDivElement> {
  const el = document.createElement("div");
  document.body.appendChild(el);
  container = el;
  root = ReactDOMClient.createRoot(el);
  await act(async () => {
    root?.render(
      <NoticeProvider>
        <MemoryRouter initialEntries={[`/w/00079598e311c160/app/${placement.route}`]}>
          <ThemeProvider>
            <WorkspaceProvider initialWorkspaces={[ws]} initialActiveId={WS_ID}>
              <CaptureSetter />
              <ConnectorsFromActiveWorkspace>
                <ChatProvider currentUserId="u1" initialConfig={{ configuredProviders: [] }}>
                  <ChatPanelProvider>
                    <AppWithChat placement={placement} />
                  </ChatPanelProvider>
                </ChatProvider>
              </ConnectorsFromActiveWorkspace>
            </WorkspaceProvider>
          </ThemeProvider>
        </MemoryRouter>
      </NoticeProvider>,
    );
  });
  await settle();
  return el;
}

// ── The app's side of the bridge ────────────────────────────────────

interface AppSide {
  inbox: Array<Record<string, unknown>>;
  send(data: unknown): void;
}

/** Stand in for the app inside the one iframe in `el`. */
function appSide(el: HTMLElement): AppSide {
  const iframes = el.getElementsByTagName("iframe");
  expect(iframes.length).toBe(1);
  const iframe = iframes[0] as HTMLIFrameElement;
  const inbox: Array<Record<string, unknown>> = [];
  const stubWindow = {
    postMessage(data: Record<string, unknown>) {
      inbox.push(data);
    },
  } as Window;
  Object.defineProperty(iframe, "contentWindow", { configurable: true, get: () => stubWindow });
  return {
    inbox,
    send(data: unknown) {
      const event = new window.MessageEvent("message", { data });
      Object.defineProperty(event, "source", { configurable: true, get: () => stubWindow });
      window.dispatchEvent(event);
    },
  };
}

async function handshake(app: AppSide): Promise<Record<string, unknown>> {
  await act(async () => {
    app.send({
      jsonrpc: "2.0",
      id: "init",
      method: "ui/initialize",
      params: {
        protocolVersion: "2026-01-26",
        clientInfo: { name: "iframe", version: "1.0.0" },
        capabilities: {},
      },
    });
  });
  const reply = app.inbox.find((m) => m.id === "init") as {
    result: { hostContext: Record<string, unknown> };
  };
  expect(reply).toBeDefined();
  await act(async () => {
    app.send({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
  });
  return reply.result.hostContext;
}

function lastHostContextChange(app: AppSide): Record<string, unknown> | undefined {
  const pushes = app.inbox.filter((m) => m.method === "ui/notifications/host-context-changed");
  return pushes.at(-1)?.params as Record<string, unknown> | undefined;
}

// ── Tests ───────────────────────────────────────────────────────────

describe("AppWithChat — the tools of the app's connector the viewer may call", () => {
  test("an admin's app is sent the list the server decided, admin tools included", async () => {
    serverAllowed = { crm: ["configure", "search"] };
    const el = await mountApp(workspace("admin"), appPlacement("crm"));
    expect((await handshake(appSide(el))).connector).toEqual({
      allowedTools: ["configure", "search"],
    });
  });

  test("a member's app is sent the member's list: no admin tools, the rest kept", async () => {
    serverAllowed = { crm: ["search"] };
    const el = await mountApp(workspace("member"), appPlacement("crm"));
    expect((await handshake(appSide(el))).connector).toEqual({ allowedTools: ["search"] });
  });

  test("an app is sent its own connector's list, not another connector's", async () => {
    serverAllowed = { crm: ["configure", "search"], notes: ["read_note"] };
    const el = await mountApp(workspace("admin"), appPlacement("notes"));
    expect((await handshake(appSide(el))).connector).toEqual({ allowedTools: ["read_note"] });
  });

  test("a connector the server allows nothing on is sent an empty list", async () => {
    // A malformed `admin_tools` gates every tool: for a member the server lists none.
    serverAllowed = { crm: [] };
    const el = await mountApp(workspace("member"), appPlacement("crm"));
    expect((await handshake(appSide(el))).connector).toEqual({ allowedTools: [] });
  });

  test("never carries canManage: the app is told tools, not a role", async () => {
    serverAllowed = { crm: ["configure", "search"] };
    const el = await mountApp(workspace("admin"), appPlacement("crm"));
    expect((await handshake(appSide(el))).connector).not.toHaveProperty("canManage");
  });

  test("a role change re-reads the list and pushes it to the mounted iframe", async () => {
    serverAllowed = { crm: ["search"] };
    const el = await mountApp(workspace("member"), appPlacement("crm"));
    const app = appSide(el);
    expect((await handshake(app)).connector).toEqual({ allowedTools: ["search"] });
    const reads = getInstalledConnectors.mock.calls.length;

    serverAllowed = { crm: ["configure", "search"] };
    await act(async () => {
      setWorkspace?.(workspace("admin"));
    });
    await settle();

    expect(getInstalledConnectors.mock.calls.length).toBeGreaterThan(reads);
    expect(lastHostContextChange(app)?.connector).toEqual({
      allowedTools: ["configure", "search"],
    });
  });

  test("an identity app's mount carries no connector key, at handshake or live", async () => {
    serverAllowed = { crm: ["configure", "search"] };
    const el = await mountApp(workspace("admin"), appPlacement("files"));
    const app = appSide(el);
    const ctx = await handshake(app);
    expect(ctx).not.toHaveProperty("connector");
    expect(ctx.workspace).toMatchObject({ id: WS_ID });

    await act(async () => {
      setWorkspace?.({ ...workspace("admin"), name: "Renamed" });
    });
    await settle();
    const pushed = lastHostContextChange(app);
    expect(pushed?.workspace).toMatchObject({ name: "Renamed" });
    expect(pushed).not.toHaveProperty("connector");
  });
});
