// ---------------------------------------------------------------------------
// AppWithChat — covering an app is presentation, not lifetime.
//
// On a phone the chat sidebar is a full-width overlay over the app. The app
// area stays mounted in every panel state: opening and closing the sidebar
// keeps the same iframe and the same bridge, so the view's local UI state and
// its `ui/update-model-context` state survive, and a message sent from the
// sidebar still carries what the user was looking at. While covered, the app
// area is invisible, inert, and hidden from assistive tech.
//
// Real providers throughout (ChatProvider → ChatPanelProvider), driven the way
// the shell drives them. `createBridge` is wrapped, not replaced, so the spy
// sees each bridge and its `destroy()` while the real bridge does the work.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { realClient } from "../../test/setup";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom's Window stub doesn't expose SyntaxError/TypeError; querySelector's
// selector parser constructs one and trips on the gap.
{
  const win = (globalThis as unknown as { window?: Record<string, unknown> }).window;
  if (win) {
    win.SyntaxError ??= SyntaxError;
    win.TypeError ??= TypeError;
  }
}

mock.module("../api/client", () => ({
  ...realClient,
  getResources: mock(async () => ({ html: "<p>app</p>" })),
}));

mock.module("../api/conversation-stream", () => ({
  connectConversationStream: () => ({ close() {} }),
}));

const realBridge = { ...(await import("../bridge/bridge")) };
const created: Array<{ iframe: HTMLIFrameElement; destroy: ReturnType<typeof mock> }> = [];
mock.module("../bridge/bridge", () => ({
  ...realBridge,
  createBridge: (...args: Parameters<typeof realBridge.createBridge>) => {
    const handle = realBridge.createBridge(...args);
    const destroy = mock(() => handle.destroy());
    created.push({ iframe: args[0], destroy });
    return { ...handle, destroy };
  },
}));

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter } = await import("react-router-dom");
const { ChatProvider } = await import("../context/ChatContext");
const { ChatPanelProvider, useChatPanelContext } = await import("../context/ChatPanelContext");
const { ThemeProvider } = await import("../context/ThemeContext");
const { WorkspaceProvider } = await import("../context/WorkspaceContext");
const { AppWithChat } = await import("../components/AppWithChat");
const { AppLocationProvider, useAppLocation } = await import("../context/AppLocationContext");
const { LOCATION_METHOD } = await import("../bridge/extensions");
const { getAppState } = realBridge;

import type { ChatPanelContextValue } from "../context/ChatPanelContext";
import type { WorkspaceInfo } from "../context/WorkspaceContext";
import type { PlacementEntry } from "../types";

const WS_A: WorkspaceInfo = {
  id: "ws_a",
  name: "Alpha",
  connectorCount: 0,
  memberCount: 1,
  userRole: "admin",
};

const APP = "app-with-chat-test";
const PLACEMENT = {
  serverName: APP,
  slot: "sidebar.apps",
  resourceUri: `ui://${APP}/main`,
  route: "notes",
  priority: 0,
} as unknown as PlacementEntry;

const happyWindow = window as unknown as {
  innerWidth: number;
  innerHeight: number;
  happyDOM: { setViewport(v: { width: number; height: number }): void };
  MessageEvent: typeof MessageEvent;
};
const DESKTOP = { width: happyWindow.innerWidth, height: happyWindow.innerHeight };

let container: HTMLDivElement;
let root: ReturnType<typeof ReactDOMClient.createRoot>;
/** The provider's live value, for opening and closing the panel the way ChatChrome does. */
let panel: ChatPanelContextValue;

function PanelProbe() {
  panel = useChatPanelContext();
  return null;
}

async function mountApp(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(
        MemoryRouter,
        { initialEntries: ["/w/a/app/notes"] },
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(WorkspaceProvider, {
            initialWorkspaces: [WS_A],
            initialActiveId: "ws_a",
            children: React.createElement(ChatProvider, {
              currentUserId: "u1",
              initialConfig: { configuredProviders: ["anthropic"] },
              children: React.createElement(
                ChatPanelProvider,
                null,
                React.createElement(PanelProbe),
                React.createElement(AppWithChat, { placement: PLACEMENT }),
              ),
            }),
          }),
        ),
      ),
    );
  });
  // Let SlotRenderer's async fetch → mount settle.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function setPanel(state: "open" | "closed"): Promise<void> {
  await act(async () => {
    if (state === "open") panel.openPanel();
    else panel.closePanel();
  });
}

function appArea(): HTMLElement {
  const el = container.querySelector<HTMLElement>('[data-testid="app-with-chat-area"]');
  if (!el) throw new Error("app area not rendered");
  return el;
}

function iframe(): HTMLIFrameElement | null {
  return container.querySelector("iframe");
}

/** Deliver a `ui/update-model-context` from the view, as the app inside the iframe would. */
function push(frame: HTMLIFrameElement, state: Record<string, unknown>): void {
  const event = new happyWindow.MessageEvent("message", {
    data: {
      jsonrpc: "2.0",
      method: "ui/update-model-context",
      params: { structuredContent: state },
    },
  });
  Object.defineProperty(event, "source", { configurable: true, get: () => frame.contentWindow });
  window.dispatchEvent(event);
}

beforeEach(() => {
  localStorage.clear();
  created.length = 0;
  happyWindow.happyDOM.setViewport({ width: 375, height: 812 });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  happyWindow.happyDOM.setViewport(DESKTOP);
});

describe("AppWithChat — the mobile sidebar covers the app without unmounting it", () => {
  test("opening and closing the sidebar keeps the same iframe and bridge", async () => {
    await mountApp();
    const frame = iframe();
    expect(frame).not.toBeNull();
    expect(created).toHaveLength(1);

    await setPanel("open");
    expect(iframe()).toBe(frame);

    await setPanel("closed");
    expect(iframe()).toBe(frame);
    expect(created).toHaveLength(1);
    expect(created[0].iframe).toBe(frame as HTMLIFrameElement);
    expect(created[0].destroy).not.toHaveBeenCalled();
  });

  test("with the sidebar open, the focused app's state is what the view pushed", async () => {
    await mountApp();
    const frame = iframe() as HTMLIFrameElement;
    push(frame, { selection: "row 7" });

    await setPanel("open");
    expect(getAppState(APP)?.state).toEqual({ selection: "row 7" });

    // The covered view is still live: a push while covered still lands.
    push(frame, { selection: "row 8" });
    expect(getAppState(APP)?.state).toEqual({ selection: "row 8" });
  });

  test("while covered, the app area is invisible, inert, and hidden from assistive tech", async () => {
    await mountApp();
    expect(appArea().hasAttribute("inert")).toBe(false);
    expect(appArea().getAttribute("aria-hidden")).toBeNull();

    await setPanel("open");
    expect(appArea().hasAttribute("inert")).toBe(true);
    expect(appArea().getAttribute("aria-hidden")).toBe("true");
    expect(appArea().className).toContain("invisible");

    await setPanel("closed");
    expect(appArea().hasAttribute("inert")).toBe(false);
    expect(appArea().getAttribute("aria-hidden")).toBeNull();
    expect(appArea().className).not.toContain("invisible");
  });

  test("on desktop the sidebar sits beside the app, which stays interactive", async () => {
    happyWindow.happyDOM.setViewport(DESKTOP);
    await mountApp();

    await setPanel("open");
    expect(appArea().hasAttribute("inert")).toBe(false);
    expect(appArea().getAttribute("aria-hidden")).toBeNull();
    expect(appArea().className).not.toContain("invisible");
  });
});

describe("AppWithChat — the top bar's trail belongs to the app on screen", () => {
  // Sibling app routes render this same element, so React Router keeps one
  // instance and hands it the next placement. This renders it the same way.
  const PLACEMENT_B = {
    ...PLACEMENT,
    serverName: `${APP}-b`,
    resourceUri: `ui://${APP}-b/main`,
    route: "tasks",
  } as unknown as PlacementEntry;

  let location: ReturnType<typeof useAppLocation>;
  function LocationProbe() {
    location = useAppLocation();
    return null;
  }

  function tree(placement: PlacementEntry) {
    return React.createElement(
      MemoryRouter,
      { initialEntries: ["/w/a/app/notes"] },
      React.createElement(
        ThemeProvider,
        null,
        React.createElement(WorkspaceProvider, {
          initialWorkspaces: [WS_A],
          initialActiveId: "ws_a",
          children: React.createElement(ChatProvider, {
            currentUserId: "u1",
            initialConfig: { configuredProviders: ["anthropic"] },
            children: React.createElement(
              ChatPanelProvider,
              null,
              React.createElement(
                AppLocationProvider,
                null,
                React.createElement(LocationProbe),
                React.createElement(AppWithChat, { placement }),
              ),
            ),
          }),
        }),
      ),
    );
  }

  async function settle(): Promise<void> {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }

  test("switching to another app clears the previous app's trail", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = ReactDOMClient.createRoot(container);
    await act(async () => root.render(tree(PLACEMENT)));
    await settle();

    const frame = iframe();
    if (!frame) throw new Error("no iframe");
    const event = new happyWindow.MessageEvent("message", {
      data: {
        jsonrpc: "2.0",
        method: LOCATION_METHOD,
        params: {
          trail: [
            { id: "notes", label: "Notes" },
            { id: "notes/1", label: "Note one" },
          ],
        },
      },
    });
    Object.defineProperty(event, "source", { configurable: true, get: () => frame.contentWindow });
    await act(async () => window.dispatchEvent(event));
    expect(location.appLocation?.trail.map((e) => e.label)).toEqual(["Notes", "Note one"]);

    await act(async () => root.render(tree(PLACEMENT_B)));
    await settle();

    expect(location.appLocation).toBeNull();
  });
});
