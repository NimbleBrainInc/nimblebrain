// ---------------------------------------------------------------------------
// WorkspaceOverviewPage — a composer and a few ranked next steps.
//
// The page reads four sources for this workspace: the briefing (`nb__briefing`),
// the connectors list (from the app icons context), the last conversation
// (`conversations__list`), and the runs waiting for review (`tasks__runs`). Its
// cards render once all four have answered, so they appear once in their
// final order. Choosing a card navigates, or opens the chat over the whole main
// area; so does a question sent from the composer. Real chat providers wrap
// every mount, as the shell's do.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, mock, test } from "bun:test";
import type { WorkspaceInfo } from "../src/context/WorkspaceContext";
import type { ChatRequest } from "../src/types";
import { realClient } from "./setup";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Stub only `callTool` and `startChatTurn`. Spread the preload's real-module
// snapshot (see web/test/setup.ts) so every other export stays intact: a bare
// mock leaks across files in the same process and strips functions other
// suites depend on.
type CallTool = (server: string, tool: string) => Promise<unknown>;
let callToolImpl: CallTool = () => new Promise(() => {});
type StartChatTurn = (req: ChatRequest) => Promise<unknown>;
let startChatTurnImpl: StartChatTurn | null = null;
mock.module("../src/api/client", () => ({
  ...realClient,
  callTool: (server: string, tool: string) => callToolImpl(server, tool),
  startChatTurn: (req: ChatRequest) =>
    startChatTurnImpl ? startChatTurnImpl(req) : realClient.startChatTurn(req),
}));

const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter, Route, Routes, useLocation } = await import("react-router-dom");
const { WorkspaceOverviewPage } = await import("../src/pages/WorkspaceOverviewPage");
const { WorkspaceProvider } = await import("../src/context/WorkspaceContext");
const { toSlug } = await import("../src/lib/workspace-slug");
const { WorkspaceAppIconsContext } = await import("../src/context/WorkspaceAppIconsContext");
const { ChatProvider } = await import("../src/context/ChatContext");
const { ChatPanelProvider, useChatPanelContext } = await import("../src/context/ChatPanelContext");
const { SessionProvider } = await import("../src/context/SessionContext");
const { FIRST_QUESTION } = await import("../src/components/overview/actions");
type InstalledConnector = import("../src/api/client").InstalledConnector;
type BriefingItem = import("../src/_generated/platform-schemas/home").BriefingItem;

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
  localStorage.clear();
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

function rowIds(container: HTMLElement): string[] {
  const list = findByTestId(container, "overview-actions");
  return Array.from(list?.getElementsByTagName("li") ?? []).map(
    (li) => li.getAttribute("data-testid") ?? "",
  );
}

async function choose(container: HTMLElement, testid: string) {
  await act(async () => {
    findByTestId(container, testid)?.getElementsByTagName("button")[0]?.click();
  });
}

const WS: WorkspaceInfo = {
  id: "ws_000f7ed6658f9d30",
  name: "Acme",
  memberCount: 2,
  connectorCount: 0,
  userRole: "admin",
};
const SLUG = toSlug(WS.id);

function installedConnector(
  serverName: string,
  status: InstalledConnector["status"] = "ready",
): InstalledConnector {
  return {
    serverName,
    connectorName: serverName,
    displayName: serverName,
    disconnectable: false,
    version: "1.0.0",
    state: "running",
    scope: "workspace",
    interactive: false,
    toolCount: 1,
    allowedTools: [],
    status,
  };
}

interface Sources {
  items?: BriefingItem[];
  conversations?: Array<{ id: string; title: string | null; preview: string; updatedAt: string }>;
  reviewRuns?: number;
}

/** Answer each read the page makes. */
function answer({ items = [], conversations = [], reviewRuns = 0 }: Sources = {}) {
  callToolImpl = (server, tool) => {
    if (server === "nb" && tool === "briefing") {
      return Promise.resolve({
        isError: false,
        structuredContent: { items, generated_at: "" },
      });
    }
    if (server === "conversations") {
      return Promise.resolve({ isError: false, structuredContent: { conversations } });
    }
    if (server === "tasks" && tool === "runs") {
      return Promise.resolve({
        isError: false,
        structuredContent: {
          runs: Array.from({ length: reviewRuns }, (_, i) => ({ id: `r${i}` })),
        },
      });
    }
    return new Promise(() => {});
  };
}

const probe = { panelState: "", path: "" };
function Probe() {
  probe.panelState = useChatPanelContext().panelState;
  probe.path = useLocation().pathname + useLocation().search;
  return null;
}

/** The page with the shell's providers. `installed` undefined means no connectors list yet. */
function harness(
  ws: WorkspaceInfo = WS,
  installed: InstalledConnector[] | undefined = [],
  connectorsWorkspaceId: string = ws.id,
) {
  return (
    <WorkspaceAppIconsContext.Provider
      value={{
        iconFor: () => undefined,
        connectors: installed ? { workspaceId: connectorsWorkspaceId, installed } : undefined,
      }}
    >
      <MemoryRouter initialEntries={[`/w/${toSlug(ws.id)}`]}>
        <WorkspaceProvider initialWorkspaces={[ws]} initialActiveId={ws.id}>
          <ChatProvider currentUserId="u1" initialConfig={{ configuredProviders: ["anthropic"] }}>
            <ChatPanelProvider>
              <Probe />
              <Routes>
                <Route path="/w/:slug" element={<WorkspaceOverviewPage />} />
                <Route path="*" element={null} />
              </Routes>
            </ChatPanelProvider>
          </ChatProvider>
        </WorkspaceProvider>
      </MemoryRouter>
    </WorkspaceAppIconsContext.Provider>
  );
}

describe("WorkspaceOverviewPage — what it shows", () => {
  test("the workspace line and the chat's composer, and no settings button, app grid, or conversation list", async () => {
    answer();
    mounted = await mount(harness(WS, [installedConnector("crm")]));
    expect(mounted.container.getElementsByTagName("h1")[0]?.textContent).toBe("Working in Acme");
    const box = findByTestId(mounted.container, "workspace-overview-ask")?.getElementsByTagName(
      "textarea",
    )[0];
    expect(box?.getAttribute("aria-label")).toBe("Ask anything in Acme");
    expect(findByTestId(mounted.container, "workspace-overview-ask")).not.toBeNull();
    expect(findByTestId(mounted.container, "workspace-overview-settings")).toBeNull();
    expect(findByTestId(mounted.container, "workspace-overview-app-grid")).toBeNull();
    expect(findByTestId(mounted.container, "workspace-overview-recent")).toBeNull();
  });

  test("no rows until the connectors list names this workspace", async () => {
    answer();
    mounted = await mount(harness(WS, [], "ws_005820c54ca342ad"));
    expect(findByTestId(mounted.container, "overview-actions")).toBeNull();
  });

  test("no rows until every read has answered", async () => {
    callToolImpl = (server) =>
      server === "nb"
        ? Promise.resolve({ isError: false, structuredContent: { items: [], generated_at: "" } })
        : new Promise(() => {});
    mounted = await mount(harness());
    expect(findByTestId(mounted.container, "overview-actions")).toBeNull();
  });
});

describe("WorkspaceOverviewPage — a new workspace", () => {
  const SOLO: WorkspaceInfo = { ...WS, memberCount: 1 };

  test("an admin alone in it gets the three setup steps", async () => {
    answer();
    mounted = await mount(harness(SOLO));
    expect(rowIds(mounted.container)).toEqual([
      "overview-action-setup-plugin",
      "overview-action-setup-ask",
      "overview-action-setup-invite",
    ]);
  });

  test("a member who may not write gets neither Connect a plugin nor Invite", async () => {
    answer();
    mounted = await mount(harness({ ...SOLO, userRole: "member" }));
    expect(rowIds(mounted.container)).toEqual(["overview-action-setup-ask"]);
  });

  test("an org admin outside the membership role may still invite", async () => {
    answer();
    const member: WorkspaceInfo = { ...SOLO, userRole: "member" };
    mounted = await mount(
      <SessionProvider
        session={{
          authenticated: true,
          user: { id: "u1", email: "a@b.c", displayName: "A", orgRole: "admin" },
        }}
      >
        {harness(member)}
      </SessionProvider>,
    );
    expect(rowIds(mounted.container)).toContain("overview-action-setup-invite");
  });

  test("Connect a plugin opens Browse plugins", async () => {
    answer();
    mounted = await mount(harness(SOLO));
    await choose(mounted.container, "overview-action-setup-plugin");
    expect(probe.path).toBe(`/w/${SLUG}/plugins/browse`);
  });

  test("Ask what it can do sends the question and opens the chat full-screen", async () => {
    answer();
    const sent: string[] = [];
    startChatTurnImpl = (req) => {
      sent.push(req.message);
      return new Promise(() => {});
    };
    mounted = await mount(harness(SOLO));
    await choose(mounted.container, "overview-action-setup-ask");
    expect(sent).toEqual([FIRST_QUESTION]);
    expect(probe.panelState).toBe("fullscreen");
  });
});

describe("WorkspaceOverviewPage — a busy workspace", () => {
  test("alerts lead, then the last conversation; setup steps already taken are gone", async () => {
    answer({
      items: [
        {
          app: "Outbound",
          facet: "drafts",
          label: "Drafts awaiting review",
          count: 1,
          level: "warning",
          route: "@acme/outbound",
          state: "ok",
        },
      ],
      conversations: [{ id: "c1", title: "Q3 pipeline", preview: "", updatedAt: "" }],
      reviewRuns: 2,
    });
    mounted = await mount(harness(WS, [installedConnector("gmail", "needs_auth")]));
    expect(rowIds(mounted.container)).toEqual([
      "overview-action-connector",
      "overview-action-review",
      "overview-action-facet",
      "overview-action-resume",
    ]);
    expect(findByTestId(mounted.container, "overview-actions-more")).toBeNull();
  });

  test("a connector needing reconnection opens its connector page", async () => {
    answer();
    mounted = await mount(harness(WS, [installedConnector("gmail", "needs_auth")]));
    await choose(mounted.container, "overview-action-connector");
    expect(probe.path).toBe(`/w/${SLUG}/settings/connectors/gmail`);
  });

  test("runs to review open Automations", async () => {
    answer({ reviewRuns: 1 });
    mounted = await mount(harness(WS, [installedConnector("crm")]));
    await choose(mounted.container, "overview-action-review");
    expect(probe.path).toBe(`/w/${SLUG}/tasks`);
  });

  test("the last conversation reopens in the chat, full-screen", async () => {
    answer({ conversations: [{ id: "c1", title: "Q3 pipeline", preview: "", updatedAt: "" }] });
    mounted = await mount(harness(WS, [installedConnector("crm")]));
    expect(rowIds(mounted.container)).toEqual(["overview-action-resume"]);
    await choose(mounted.container, "overview-action-resume");
    expect(probe.panelState).toBe("fullscreen");
  });
});

describe("WorkspaceOverviewPage — the composer", () => {
  function sendButton(container: HTMLElement): HTMLButtonElement | undefined {
    const box = findByTestId(container, "workspace-overview-ask");
    return Array.from(box?.getElementsByTagName("button") ?? []).find(
      (b) => b.getAttribute("aria-label") === "Send message",
    );
  }

  test("is the chat's composer, with no shortcut hints, and cannot send empty", async () => {
    mounted = await mount(harness());
    expect(sendButton(mounted.container)?.disabled).toBe(true);
    expect(mounted.container.textContent).not.toContain("shortcuts");
  });

  test("sends the trimmed question and opens the chat full-screen", async () => {
    const sent: string[] = [];
    startChatTurnImpl = (req) => {
      sent.push(req.message);
      return new Promise(() => {});
    };
    // The panel persists its state; start closed so opening is observable.
    localStorage.setItem("nb:chatPanelState", "closed");
    mounted = await mount(harness());
    expect(probe.panelState).toBe("closed");
    const box = findByTestId(mounted.container, "workspace-overview-ask")?.getElementsByTagName(
      "textarea",
    )[0] as HTMLTextAreaElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    const WindowEvent = window.Event;
    await act(async () => {
      setValue?.call(box, "  what changed this week?  ");
      box.dispatchEvent(new WindowEvent("input", { bubbles: true }));
    });
    await act(async () => {
      sendButton(mounted?.container as HTMLElement)?.click();
    });

    expect(sent).toEqual(["what changed this week?"]);
    expect(probe.panelState).toBe("fullscreen");
  });
});
