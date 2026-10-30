// ---------------------------------------------------------------------------
// An app's own page is told whether the viewer can manage its connector.
//
// `AppWithChat` mounts a workspace app's routed placement. It hands the app the
// same `hostContext.connector.canManage` the connector's settings page hands its
// settings component, by the same rule: workspace membership role `admin`, with
// no org-admin bypass. A role change reaches the mounted iframe through
// `host-context-changed`. An identity app (Conversations, Files, Tasks) is the
// user's own, not a workspace connector, so its mount carries no `connector` key.
//
// The settings-page mount is pinned in connector-settings-section.test.tsx.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, mock, test } from "bun:test";
import { realClient } from "../../test/setup";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

mock.module("../api/client", () => ({
  ...realClient,
  getResources: mock(async () => ({ html: "<p>app</p>" })),
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
const { SessionProvider } = await import("../context/SessionContext");
const { AppWithChat } = await import("../components/AppWithChat");

import type { WorkspaceInfo } from "../context/WorkspaceContext";
import type { PlacementEntry } from "../types";

const WS_ID = "ws_00079598e311c160";

function workspace(userRole?: "admin" | "member"): WorkspaceInfo {
  return {
    id: WS_ID,
    name: "Alpha",
    connectorCount: 1,
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

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof ReactDOMClient.createRoot> | null = null;

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

async function mountApp(
  ws: WorkspaceInfo,
  placement: PlacementEntry,
  { orgRole = "member" } = {},
): Promise<HTMLDivElement> {
  const el = document.createElement("div");
  document.body.appendChild(el);
  container = el;
  root = ReactDOMClient.createRoot(el);
  await act(async () => {
    root?.render(
      <NoticeProvider>
        <MemoryRouter initialEntries={[`/w/00079598e311c160/app/${placement.route}`]}>
          <ThemeProvider>
            <SessionProvider
              session={{
                authenticated: true,
                user: { id: "u1", email: "u@example.test", displayName: "U", orgRole },
              }}
            >
              <WorkspaceProvider initialWorkspaces={[ws]} initialActiveId={WS_ID}>
                <CaptureSetter />
                <ChatProvider currentUserId="u1" initialConfig={{ configuredProviders: [] }}>
                  <ChatPanelProvider>
                    <AppWithChat placement={placement} />
                  </ChatPanelProvider>
                </ChatProvider>
              </WorkspaceProvider>
            </SessionProvider>
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

describe("AppWithChat — the manage flag for the app's connector", () => {
  test("is true for a workspace admin", async () => {
    const el = await mountApp(workspace("admin"), appPlacement("crm"));
    expect((await handshake(appSide(el))).connector).toEqual({ canManage: true });
  });

  test("is false for a workspace member", async () => {
    const el = await mountApp(workspace("member"), appPlacement("crm"));
    expect((await handshake(appSide(el))).connector).toEqual({ canManage: false });
  });

  test("is false for an org admin who is not a workspace admin", async () => {
    const el = await mountApp(workspace("member"), appPlacement("crm"), { orgRole: "admin" });
    expect((await handshake(appSide(el))).connector).toEqual({ canManage: false });
  });

  test("a role change reaches the mounted iframe", async () => {
    const el = await mountApp(workspace("member"), appPlacement("crm"));
    const app = appSide(el);
    expect((await handshake(app)).connector).toEqual({ canManage: false });

    await act(async () => {
      setWorkspace?.(workspace("admin"));
    });
    await settle();

    expect(lastHostContextChange(app)?.connector).toEqual({ canManage: true });
  });

  test("an identity app's mount carries no connector key, at handshake or live", async () => {
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
