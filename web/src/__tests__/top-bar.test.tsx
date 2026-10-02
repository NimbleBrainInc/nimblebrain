// ---------------------------------------------------------------------------
// TopBar — the main area's header.
//
// Pins:
//   1. With no app trail, the title is the route's own name.
//   2. An app trail one deep shows its label and no back control.
//   3. A deeper trail shows its last label and a back control that asks the
//      app (through the navigate it published) for the entry before the last.
//   4. The same trail's ancestors form a breadcrumb; each asks the app for its
//      own entry. Past three ancestors the middle folds, root and parent stay.
//   5. Chat sits in the bar on workspace routes only, where chat exists.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { realClient } from "../../test/setup";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module("../api/client", () => ({
  ...realClient,
  callTool: mock(async () => ({ structuredContent: null, content: [] })),
}));

mock.module("../api/conversation-stream", () => ({
  connectConversationStream: () => ({ close() {} }),
}));

const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter } = await import("react-router-dom");
const { AppLocationProvider, useAppLocation } = await import("../context/AppLocationContext");
const { ChatProvider } = await import("../context/ChatContext");
const { ChatPanelProvider } = await import("../context/ChatPanelContext");
const { ShellProvider } = await import("../context/ShellContext");
const { SidebarProvider } = await import("../context/SidebarContext");
const { TopBar } = await import("../components/shell/TopBar");

import type { AppLocationContextValue } from "../context/AppLocationContext";
import type { PlacementEntry } from "../types";

const PEOPLE: PlacementEntry = {
  serverName: "people",
  slot: "sidebar.apps",
  resourceUri: "ui://people/main",
  priority: 100,
  label: "People",
  route: "people",
};

// Captures the context's setter so a test can publish a trail the way
// AppWithChat does.
let location: AppLocationContextValue;
function LocationProbe() {
  location = useAppLocation();
  return null;
}

let container: HTMLDivElement;
let root: ReturnType<typeof ReactDOMClient.createRoot>;

async function mountBar(path: string): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <ChatProvider currentUserId="u1" initialConfig={{ configuredProviders: ["anthropic"] }}>
          <ChatPanelProvider>
            <SidebarProvider>
              <ShellProvider
                value={{
                  forSlot: (slot) => (slot === "sidebar" ? [PEOPLE] : []),
                  mainRoutes: () => [],
                  shellWorkspaceId: "ws_a",
                }}
              >
                <AppLocationProvider>
                  <LocationProbe />
                  <TopBar />
                </AppLocationProvider>
              </ShellProvider>
            </SidebarProvider>
          </ChatPanelProvider>
        </ChatProvider>
      </MemoryRouter>,
    );
  });
}

const byTestId = (id: string) =>
  Array.from(container.getElementsByTagName("*")).find(
    (el) => el.getAttribute("data-testid") === id,
  ) as HTMLElement | undefined;

const crumbButtons = () =>
  Array.from(container.getElementsByTagName("button")).filter(
    (el) => el.getAttribute("data-testid") === "top-bar-crumb",
  );

beforeEach(() => {
  localStorage.setItem("nb:chatPanelState", "closed");
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.removeItem("nb:chatPanelState");
});

describe("TopBar", () => {
  test("with no app trail, the title is the route's own name", async () => {
    await mountBar("/w/acme/app/people");
    expect(byTestId("top-bar-title")?.textContent).toBe("People");
    expect(byTestId("top-bar-back")).toBeUndefined();
  });

  test("a trail one deep shows its label and no back control", async () => {
    await mountBar("/w/acme/app/people");
    await act(async () =>
      location.setAppLocation({ trail: [{ id: "list", label: "Contacts" }], navigate: () => {} }),
    );
    expect(byTestId("top-bar-title")?.textContent).toBe("Contacts");
    expect(byTestId("top-bar-back")).toBeUndefined();
  });

  test("a deeper trail shows its last label, and back asks the app for the entry before it", async () => {
    await mountBar("/w/acme/app/people");
    const navigate = mock((_id: string) => {});
    await act(async () =>
      location.setAppLocation({
        trail: [
          { id: "people", label: "People" },
          { id: "contact/c-1", label: "Jane Doe" },
          { id: "company/acme", label: "Acme Corp" },
        ],
        navigate,
      }),
    );

    expect(byTestId("top-bar-title")?.textContent).toBe("Acme Corp");
    const back = byTestId("top-bar-back");
    expect(back?.getAttribute("aria-label")).toBe("Back to Jane Doe");
    await act(async () => back?.click());
    expect(navigate.mock.calls).toEqual([["contact/c-1"]]);
  });

  test("each breadcrumb entry asks the app for its own entry", async () => {
    await mountBar("/w/acme/app/people");
    const navigate = mock((_id: string) => {});
    await act(async () =>
      location.setAppLocation({
        trail: [
          { id: "people://contacts", label: "People" },
          { id: "people://contacts/c-1", label: "Jane Doe" },
          { id: "people://companies/acme", label: "Acme Corp" },
        ],
        navigate,
      }),
    );

    expect(byTestId("top-bar-breadcrumb")?.getAttribute("aria-label")).toBe("Breadcrumb");
    const crumbs = crumbButtons();
    expect(crumbs.map((c) => c.textContent)).toEqual(["People", "Jane Doe"]);
    await act(async () => crumbs[0].click());
    expect(navigate.mock.calls).toEqual([["people://contacts"]]);
  });

  test("a trail one deep has no breadcrumb", async () => {
    await mountBar("/w/acme/app/people");
    await act(async () =>
      location.setAppLocation({ trail: [{ id: "list", label: "Contacts" }], navigate: () => {} }),
    );
    expect(byTestId("top-bar-breadcrumb")).toBeUndefined();
  });

  test("three ancestors all show, unfolded", async () => {
    await mountBar("/w/acme/app/people");
    const trail = ["a", "b", "c", "d"].map((id) => ({ id, label: id.toUpperCase() }));
    await act(async () => location.setAppLocation({ trail, navigate: () => {} }));

    expect(crumbButtons().map((c) => c.textContent)).toEqual(["A", "B", "C"]);
    expect(byTestId("top-bar-breadcrumb")?.textContent).not.toContain("…");
  });

  test("past three ancestors, the middle folds and the root and parent stay", async () => {
    await mountBar("/w/acme/app/people");
    const trail = ["a", "b", "c", "d", "e"].map((id) => ({ id, label: id.toUpperCase() }));
    await act(async () => location.setAppLocation({ trail, navigate: () => {} }));

    expect(crumbButtons().map((c) => c.textContent)).toEqual(["A", "D"]);
    expect(byTestId("top-bar-breadcrumb")?.textContent).toContain("…");
    expect(byTestId("top-bar-title")?.textContent).toBe("E");
  });

  test("Chat is in the bar on workspace routes only", async () => {
    await mountBar("/w/acme/");
    expect(byTestId("chat-chrome-open-button")).toBeDefined();
    act(() => root.unmount());
    container.remove();

    await mountBar("/profile/general");
    expect(byTestId("top-bar-title")?.textContent).toBe("Profile");
    expect(byTestId("chat-chrome-open-button")).toBeUndefined();
  });
});
