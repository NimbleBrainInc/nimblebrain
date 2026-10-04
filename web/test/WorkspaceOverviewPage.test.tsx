// ---------------------------------------------------------------------------
// WorkspaceOverviewPage — app grid is a three-state surface
//
// The bug this pins: the grid used to render "No apps installed" whenever
// `forSlot` returned [] — which also happens while the shell hasn't caught up
// to this workspace (deep-link / switch window). Loading was conflated with
// empty, so a workspace that DOES have apps flashed a false-empty dashboard.
//
// Readiness is `shell.shellWorkspaceId === <this page's workspace id>`. The
// three states:
//   not-ready  → a stable spacer    (never the empty card; no pulsing skeleton)
//   ready+empty → "No apps installed"
//   ready+populated → the app grid
//
// Briefing is independent (its own async timeline) — callTool is stubbed to a
// never-resolving promise so it sits in its skeleton and doesn't interfere.
//
// The page also offers actions, each to someone who can take it: an invite in a
// workspace of one, "Add app" to a workspace admin, recent conversations, and a
// composer that sends into the chat panel. Real chat providers wrap every mount,
// as the shell's do.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, mock, test } from "bun:test";
import type { WorkspaceInfo } from "../src/context/WorkspaceContext";
import type { PlacementEntry } from "../src/types";
import { realClient } from "./setup";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Stub only `callTool` so the briefing fetch hangs in its skeleton (its own
// async timeline — not what this file tests). Spread the preload's real-module
// snapshot (see web/test/setup.ts) so every other export stays intact: a bare
// `{ callTool }` mock leaks across files in the same test process and strips
// functions the client/bridge suites depend on (getAuthToken,
// getActiveWorkspaceId, …). The snapshot predates every mock.module, so it
// can't itself be an incomplete stub the way `import * as` from the registry
// could. WorkspaceContext skips its list call when given bootstrap data, so the
// real setActiveWorkspaceId it calls is harmless — sibling suites reset client
// state in their own beforeEach.
type CallTool = (server: string, tool: string) => Promise<unknown>;
let callToolImpl: CallTool = () => new Promise(() => {});
// The composer's send reaches `startChatTurn`; a test records it here. Unset, the
// real function runs, so the mock changes nothing for other suites.
type StartChatTurn = (req: { message: string }) => Promise<unknown>;
let startChatTurnImpl: StartChatTurn | null = null;
mock.module("../src/api/client", () => ({
  ...realClient,
  callTool: (server: string, tool: string) => callToolImpl(server, tool),
  startChatTurn: (req: { message: string }) =>
    startChatTurnImpl ? startChatTurnImpl(req) : realClient.startChatTurn(req as never),
}));

const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter, Route, Routes } = await import("react-router-dom");
const { WorkspaceOverviewPage } = await import("../src/pages/WorkspaceOverviewPage");
const { WorkspaceProvider } = await import("../src/context/WorkspaceContext");
const { ShellProvider } = await import("../src/context/ShellContext");
const { toSlug } = await import("../src/lib/workspace-slug");
const { WorkspaceAppIconsContext } = await import("../src/context/WorkspaceAppIconsContext");
const { ChatProvider } = await import("../src/context/ChatContext");
const { ChatPanelProvider, useChatPanelContext } = await import("../src/context/ChatPanelContext");
const { SessionProvider } = await import("../src/context/SessionContext");
const { useLocation } = await import("react-router-dom");
type InstalledConnector = import("../src/api/client").InstalledConnector;

interface Mounted {
  container: HTMLDivElement;
  unmount(): void;
}

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  callToolImpl = () => new Promise(() => {});
  startChatTurnImpl = null;
});

async function mount(element: React.ReactElement): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(element);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return {
    container,
    unmount() {
      root.unmount();
      container.remove();
    },
  };
}

function findByTestId(container: HTMLElement, testid: string): HTMLElement | null {
  for (const el of Array.from(container.getElementsByTagName("*"))) {
    if (el.getAttribute("data-testid") === testid) return el as HTMLElement;
  }
  return null;
}

function findAllByTestId(container: HTMLElement, testid: string): HTMLElement[] {
  return Array.from(container.getElementsByTagName("*")).filter(
    (el) => el.getAttribute("data-testid") === testid,
  ) as HTMLElement[];
}

const WS: WorkspaceInfo = {
  id: "ws_000f7ed6658f9d30",
  name: "Acme",
  memberCount: 2,
  connectorCount: 0,
  userRole: "admin",
};

/** The shell's chat providers, around the routes as `App` places them. */
function Chat({ children }: { children: React.ReactNode }) {
  return (
    <ChatProvider currentUserId="u1" initialConfig={{ configuredProviders: ["anthropic"] }}>
      <ChatPanelProvider>{children}</ChatPanelProvider>
    </ChatProvider>
  );
}

function appPlacement(over: Partial<PlacementEntry>): PlacementEntry {
  return {
    serverName: "crm",
    slot: "sidebar.apps",
    resourceUri: "ui://crm/main",
    priority: 10,
    label: "CRM",
    route: "crm",
    ...over,
  };
}

// `shellWorkspaceId` is the lever: equal to WS.id → ready; anything else → not.
function harness(
  shellWorkspaceId: string | undefined,
  placements: PlacementEntry[],
  ws: WorkspaceInfo = WS,
) {
  const shellValue = {
    forSlot: (slot: string): PlacementEntry[] =>
      placements.filter((p) => p.slot === slot || p.slot.startsWith(`${slot}.`)),
    mainRoutes: (): PlacementEntry[] => [],
    shellWorkspaceId,
  };
  return (
    <MemoryRouter initialEntries={[`/w/${toSlug(ws.id)}`]}>
      <ShellProvider value={shellValue}>
        <WorkspaceProvider initialWorkspaces={[ws]} initialActiveId={ws.id}>
          <Chat>
            <Routes>
              <Route path="/w/:slug" element={<WorkspaceOverviewPage />} />
            </Routes>
          </Chat>
        </WorkspaceProvider>
      </ShellProvider>
    </MemoryRouter>
  );
}

describe("WorkspaceOverviewPage — app grid three states", () => {
  test("not ready (shell lags this workspace) → a stable spacer, never the empty card", async () => {
    // Shell still reflects a different workspace (the switch/deep-link window).
    mounted = await mount(harness("ws_005820c54ca342ad", [appPlacement({})]));

    // A held space, not a pulsing skeleton — the page stays mounted across a
    // switch, so the apps section just holds its place until the shell resolves.
    expect(findByTestId(mounted.container, "workspace-overview-apps-pending")).not.toBeNull();
    // The false-empty regression: must NOT show "No apps installed" while loading.
    expect(findByTestId(mounted.container, "workspace-overview-empty")).toBeNull();
    expect(findByTestId(mounted.container, "workspace-overview-app-grid")).toBeNull();
  });

  test("ready + empty → the empty card, no pending spacer", async () => {
    mounted = await mount(harness(WS.id, []));

    expect(findByTestId(mounted.container, "workspace-overview-empty")).not.toBeNull();
    expect(findByTestId(mounted.container, "workspace-overview-apps-pending")).toBeNull();
    expect(findByTestId(mounted.container, "workspace-overview-app-grid")).toBeNull();
  });

  test("ready + populated → the grid with cards", async () => {
    mounted = await mount(
      harness(WS.id, [
        appPlacement({ route: "crm", label: "CRM", resourceUri: "ui://crm/main" }),
        // Its own connector: the header counts apps, and two placements of one
        // connector are one app with two views.
        appPlacement({
          serverName: "todo",
          route: "todo",
          label: "Todo",
          resourceUri: "ui://todo/main",
        }),
      ]),
    );

    expect(findByTestId(mounted.container, "workspace-overview-app-grid")).not.toBeNull();
    expect(findAllByTestId(mounted.container, "workspace-overview-app-card")).toHaveLength(2);
    expect(findByTestId(mounted.container, "workspace-overview-apps-pending")).toBeNull();
    expect(findByTestId(mounted.container, "workspace-overview-empty")).toBeNull();
  });
});

describe("WorkspaceOverviewPage — actions", () => {
  const SOLO: WorkspaceInfo = { ...WS, memberCount: 1 };

  test("a workspace admin alone in it is offered an invite, and Add app", async () => {
    mounted = await mount(harness(SOLO.id, [appPlacement({})], SOLO));
    const invite = findByTestId(mounted.container, "workspace-overview-invite");
    expect(invite?.getAttribute("href")).toBe(`/w/${toSlug(SOLO.id)}/settings/members?add`);
    expect(findByTestId(mounted.container, "workspace-overview-add-app")).not.toBeNull();
  });

  test("no invite once someone else is in it", async () => {
    mounted = await mount(harness(WS.id, [appPlacement({})]));
    expect(findByTestId(mounted.container, "workspace-overview-invite")).toBeNull();
  });

  test("a member who may not write sees neither invite nor Add app", async () => {
    const member: WorkspaceInfo = { ...SOLO, userRole: "member" };
    mounted = await mount(harness(member.id, [appPlacement({})], member));
    expect(findByTestId(mounted.container, "workspace-overview-invite")).toBeNull();
    expect(findByTestId(mounted.container, "workspace-overview-add-app")).toBeNull();
  });

  test("an org admin outside the membership role may still invite", async () => {
    const member: WorkspaceInfo = { ...SOLO, userRole: "member" };
    mounted = await mount(
      <SessionProvider session={{ authenticated: true, user: { id: "u1", email: "a@b.c", displayName: "A", orgRole: "admin" } }}>
        {harness(member.id, [], member)}
      </SessionProvider>,
    );
    expect(findByTestId(mounted.container, "workspace-overview-invite")).not.toBeNull();
  });

  test("recent conversations list and reopen in the panel", async () => {
    callToolImpl = (server) =>
      server === "conversations"
        ? Promise.resolve({
            isError: false,
            structuredContent: {
              conversations: [
                { id: "conv_1", title: "Q3 pipeline", preview: "", updatedAt: new Date().toISOString() },
                { id: "conv_2", title: null, preview: "draft the memo", updatedAt: new Date().toISOString() },
              ],
            },
          })
        : new Promise(() => {});
    let panelState = "";
    function Probe() {
      panelState = useChatPanelContext().panelState;
      return null;
    }
    mounted = await mount(
      <MemoryRouter initialEntries={[`/w/${toSlug(WS.id)}`]}>
        <WorkspaceProvider initialWorkspaces={[WS]} initialActiveId={WS.id}>
          <Chat>
            <Probe />
            <Routes>
              <Route path="/w/:slug" element={<WorkspaceOverviewPage />} />
            </Routes>
          </Chat>
        </WorkspaceProvider>
      </MemoryRouter>,
    );
    const rows = findAllByTestId(mounted.container, "workspace-overview-recent-row");
    expect(rows.map((r) => r.textContent?.replace(/now$/, ""))).toEqual([
      "Q3 pipeline",
      "draft the memo",
    ]);
    await act(async () => {
      rows[0]?.click();
    });
    expect(panelState).toBe("sidebar");
  });

  test("no recent section for a workspace with no conversations", async () => {
    callToolImpl = (server) =>
      server === "conversations"
        ? Promise.resolve({ isError: false, structuredContent: { conversations: [] } })
        : new Promise(() => {});
    mounted = await mount(harness(WS.id, []));
    expect(findByTestId(mounted.container, "workspace-overview-recent")).toBeNull();
  });

  test("the composer is disabled until there is something to send", async () => {
    mounted = await mount(harness(WS.id, []));
    const form = findByTestId(mounted.container, "workspace-overview-ask");
    const send = form?.getElementsByTagName("button")[0] as HTMLButtonElement | undefined;
    expect(send?.disabled).toBe(true);
  });

  test("the composer sends the trimmed question, opens the panel, and clears", async () => {
    const sent: string[] = [];
    startChatTurnImpl = (req) => {
      sent.push(req.message);
      return new Promise(() => {});
    };
    // The panel persists its state; start closed so opening is observable.
    localStorage.setItem("nb:chatPanelState", "closed");
    let panelState = "";
    function Probe() {
      panelState = useChatPanelContext().panelState;
      return null;
    }
    mounted = await mount(
      <MemoryRouter initialEntries={[`/w/${toSlug(WS.id)}`]}>
        <WorkspaceProvider initialWorkspaces={[WS]} initialActiveId={WS.id}>
          <Chat>
            <Probe />
            <Routes>
              <Route path="/w/:slug" element={<WorkspaceOverviewPage />} />
            </Routes>
          </Chat>
        </WorkspaceProvider>
      </MemoryRouter>,
    );
    expect(panelState).toBe("closed");
    const input = findByTestId(mounted.container, "workspace-overview-ask-input") as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    const WindowEvent = (globalThis as unknown as { window: { Event: typeof Event } }).window.Event;
    await act(async () => {
      setValue?.call(input, "  what changed this week?  ");
      input.dispatchEvent(new WindowEvent("input", { bubbles: true }));
    });
    await act(async () => {
      (findByTestId(mounted?.container as HTMLElement, "workspace-overview-ask") as HTMLFormElement).requestSubmit();
    });

    expect(sent).toEqual(["what changed this week?"]);
    expect(panelState).toBe("sidebar");
    expect(input.value).toBe("");
  });
});

describe("WorkspaceOverviewPage — briefing", () => {
  function Where() {
    return <div data-testid="location">{useLocation().pathname}</div>;
  }

  test("a connector needing reconnection opens its connector page", async () => {
    callToolImpl = (server) =>
      server === "nb"
        ? Promise.resolve({ isError: false, structuredContent: { items: [], generated_at: "" } })
        : new Promise(() => {});
    const gmail: InstalledConnector = {
      serverName: "gmail",
      connectorName: "gmail",
      displayName: "gmail",
      disconnectable: true,
      version: "1.0.0",
      state: "reauth_required",
      scope: "workspace",
      interactive: false,
      toolCount: 0,
      status: "needs_auth",
    };
    const slug = toSlug(WS.id);
    mounted = await mount(
      <WorkspaceAppIconsContext.Provider
        value={{ iconFor: () => undefined, connectors: { workspaceId: WS.id, installed: [gmail] } }}
      >
        <MemoryRouter initialEntries={[`/w/${slug}`]}>
          <WorkspaceProvider initialWorkspaces={[WS]} initialActiveId={WS.id}>
            <Chat>
              <Routes>
                <Route path="/w/:slug" element={<WorkspaceOverviewPage />} />
                <Route path="*" element={<Where />} />
              </Routes>
            </Chat>
          </WorkspaceProvider>
        </MemoryRouter>
      </WorkspaceAppIconsContext.Provider>,
    );

    const row = findByTestId(mounted.container, "briefing-connector-status");
    expect(row?.textContent).toBe("Critical: Reconnection needed · gmail");
    expect(findByTestId(mounted.container, "workspace-briefing-empty")).toBeNull();
    await act(async () => {
      row?.getElementsByTagName("button")[0]?.click();
    });
    expect(findByTestId(mounted.container, "location")?.textContent).toBe(
      `/w/${slug}/settings/connectors/gmail`,
    );
  });

  test("renders nothing until the connectors list names this workspace", async () => {
    callToolImpl = (server) =>
      server === "nb"
        ? Promise.resolve({ isError: false, structuredContent: { items: [], generated_at: "" } })
        : new Promise(() => {});
    mounted = await mount(
      <WorkspaceAppIconsContext.Provider
        value={{ iconFor: () => undefined, connectors: { workspaceId: "ws_005820c54ca342ad", installed: [] } }}
      >
        <MemoryRouter initialEntries={[`/w/${toSlug(WS.id)}`]}>
          <WorkspaceProvider initialWorkspaces={[WS]} initialActiveId={WS.id}>
            <Chat>
              <Routes>
                <Route path="/w/:slug" element={<WorkspaceOverviewPage />} />
              </Routes>
            </Chat>
          </WorkspaceProvider>
        </MemoryRouter>
      </WorkspaceAppIconsContext.Provider>,
    );
    expect(findByTestId(mounted.container, "workspace-briefing")).toBeNull();
  });
});
