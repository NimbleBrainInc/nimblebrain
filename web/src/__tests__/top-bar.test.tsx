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
//   6. The inbox's bell sits left of Chat on workspace routes and shows a dot
//      only while something is unread, the count in its accessible name. What
//      it opens is pinned in inbox-preview.test.tsx.
//   7. On an app whose connector has a settings section, a gear left of the
//      bell links to that connector's settings page; nowhere else.
//   8. An app that places several views leads the trail with a crumb naming the
//      app, linked to its first view; a single-view app gets none.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { realClient } from "../../test/setup";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

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
const { NotificationsContext } = await import("../context/NotificationsContext");
const { ShellProvider } = await import("../context/ShellContext");
const { SidebarProvider } = await import("../context/SidebarContext");
const { WorkspaceProvider } = await import("../context/WorkspaceContext");
const { WorkspaceAppIconsContext } = await import("../context/WorkspaceAppIconsContext");
const { TopBar } = await import("../components/shell/TopBar");

import type { InstalledConnector } from "../api/client";
import type { AppLocationContextValue } from "../context/AppLocationContext";
import type { NotificationsValue } from "../context/NotificationsContext";
import type { WorkspaceConnectors } from "../context/WorkspaceAppIconsContext";
import type { WorkspaceInfo } from "../context/WorkspaceContext";
import type { PlacementEntry } from "../types";

const PEOPLE: PlacementEntry = {
  serverName: "people",
  slot: "sidebar.apps",
  resourceUri: "ui://people/main",
  priority: 100,
  label: "People",
  route: "people",
};

const PEOPLE_SETTINGS: PlacementEntry = {
  serverName: "people",
  slot: "settings",
  resourceUri: "ui://people/settings",
  priority: 100,
};

// One app, two views: grouped under one sidebar entry by the host.
const OUTREACH_REPLIES: PlacementEntry = {
  serverName: "outreach",
  slot: "sidebar.apps",
  resourceUri: "ui://outreach/replies",
  priority: 50,
  label: "Replies",
  route: "outreach",
};

const OUTREACH_CAMPAIGNS: PlacementEntry = {
  serverName: "outreach",
  slot: "sidebar.apps",
  resourceUri: "ui://outreach/campaigns",
  priority: 51,
  label: "Campaigns",
  route: "outreach/campaigns",
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

const ACME: WorkspaceInfo = {
  id: "ws_000f7ed6658f9d30",
  name: "Acme",
  connectorCount: 0,
  memberCount: 1,
  userRole: "admin",
};

function inbox(unread: number): NotificationsValue {
  return { unread, revision: 0, refresh: () => {}, markRead: async () => {} };
}

async function mountBar(
  path: string,
  unread = 0,
  shell: {
    settings?: PlacementEntry[];
    sidebar?: PlacementEntry[];
    shellWorkspaceId?: string;
    connectors?: WorkspaceConnectors;
  } = {},
): Promise<void> {
  const settings = shell.settings ?? [];
  const sidebar = shell.sidebar ?? [PEOPLE];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <WorkspaceProvider initialWorkspaces={[ACME]} initialActiveId="ws_000f7ed6658f9d30">
          <NotificationsContext.Provider value={inbox(unread)}>
            <ChatProvider currentUserId="u1" initialConfig={{ configuredProviders: ["anthropic"] }}>
              <ChatPanelProvider>
                <SidebarProvider>
                  <ShellProvider
                    value={{
                      forSlot: (slot) =>
                        slot === "sidebar" ? sidebar : slot === "settings" ? settings : [],
                      mainRoutes: () => [],
                      shellWorkspaceId: shell.shellWorkspaceId ?? "ws_00079598e311c160",
                    }}
                  >
                    <WorkspaceAppIconsContext.Provider
                      value={{ iconFor: () => undefined, connectors: shell.connectors }}
                    >
                      <AppLocationProvider>
                        <LocationProbe />
                        <TopBar />
                      </AppLocationProvider>
                    </WorkspaceAppIconsContext.Provider>
                  </ShellProvider>
                </SidebarProvider>
              </ChatPanelProvider>
            </ChatProvider>
          </NotificationsContext.Provider>
        </WorkspaceProvider>
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
    await mountBar("/w/000f7ed6658f9d30/app/people");
    expect(byTestId("top-bar-title")?.textContent).toBe("People");
    expect(byTestId("top-bar-back")).toBeUndefined();
  });

  test("a settings tab names itself after a Settings crumb that links to General", async () => {
    await mountBar("/w/000f7ed6658f9d30/settings/members");
    expect(byTestId("top-bar-title")?.textContent).toBe("Members");
    const crumbs = Array.from(container.getElementsByTagName("a")).filter(
      (el) => el.getAttribute("data-testid") === "top-bar-crumb",
    );
    expect(crumbs.map((c) => c.textContent)).toEqual(["Settings"]);
    expect(crumbs[0].getAttribute("href")).toBe("/w/000f7ed6658f9d30/settings/general");
    expect(byTestId("top-bar-back")?.getAttribute("href")).toBe(
      "/w/000f7ed6658f9d30/settings/general",
    );
  });

  test("a trail one deep shows its label and no back control", async () => {
    await mountBar("/w/000f7ed6658f9d30/app/people");
    await act(async () =>
      location.setAppLocation({ trail: [{ id: "list", label: "Contacts" }], navigate: () => {} }),
    );
    expect(byTestId("top-bar-title")?.textContent).toBe("Contacts");
    expect(byTestId("top-bar-back")).toBeUndefined();
  });

  test("a deeper trail shows its last label, and back asks the app for the entry before it", async () => {
    await mountBar("/w/000f7ed6658f9d30/app/people");
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
    await mountBar("/w/000f7ed6658f9d30/");
    expect(byTestId("chat-chrome-open-button")).toBeDefined();
    act(() => root.unmount());
    container.remove();

    await mountBar("/profile/general");
    expect(byTestId("top-bar-title")?.textContent).toBe("General");
    expect(byTestId("chat-chrome-open-button")).toBeUndefined();
  });

  test("the bell sits left of Chat on workspace routes", async () => {
    await mountBar("/w/000f7ed6658f9d30/");
    const bell = byTestId("top-bar-inbox");
    expect(bell?.getAttribute("aria-label")).toBe("Inbox");
    expect(byTestId("top-bar-inbox-dot")).toBeUndefined();
    const chat = byTestId("chat-chrome-open-button");
    expect(bell && chat && bell.compareDocumentPosition(chat)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    act(() => root.unmount());
    container.remove();

    await mountBar("/profile/general");
    expect(byTestId("top-bar-inbox")).toBeUndefined();
  });

  test("the bell shows a dot while something is unread, and the count in its name", async () => {
    await mountBar("/w/000f7ed6658f9d30/", 3);
    expect(byTestId("top-bar-inbox-dot")).toBeDefined();
    expect(byTestId("top-bar-inbox")?.getAttribute("aria-label")).toBe("Inbox, 3 unread");
  });

  test("an app with a settings section gets a gear to its settings page, left of the bell", async () => {
    await mountBar("/w/000f7ed6658f9d30/app/people", 0, {
      settings: [PEOPLE_SETTINGS],
      shellWorkspaceId: ACME.id,
    });
    const gear = byTestId("top-bar-app-settings");
    expect(gear?.getAttribute("aria-label")).toBe("People settings");
    expect(gear?.getAttribute("href")).toBe("/w/000f7ed6658f9d30/settings/connectors/people");
    const bell = byTestId("top-bar-inbox");
    expect(gear && bell && gear.compareDocumentPosition(bell)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  test("on a view whose route holds a slash, the gear finds that view's connector", async () => {
    const crm: PlacementEntry[] = [
      { ...PEOPLE, route: "people/list" },
      {
        serverName: "crm",
        slot: "sidebar.apps",
        resourceUri: "ui://crm/companies",
        priority: 100,
        label: "Companies",
        route: "people/companies",
      },
    ];
    await mountBar("/w/000f7ed6658f9d30/app/people/companies", 0, {
      sidebar: crm,
      settings: [{ ...PEOPLE_SETTINGS, serverName: "crm" }],
      shellWorkspaceId: ACME.id,
    });
    const gear = byTestId("top-bar-app-settings");
    expect(gear?.getAttribute("aria-label")).toBe("Companies settings");
    expect(gear?.getAttribute("href")).toBe("/w/000f7ed6658f9d30/settings/connectors/crm");
  });

  test("no gear for an app without a settings section, or off an app route", async () => {
    await mountBar("/w/000f7ed6658f9d30/app/people", 0, { shellWorkspaceId: ACME.id });
    expect(byTestId("top-bar-app-settings")).toBeUndefined();
    act(() => root.unmount());
    container.remove();

    await mountBar("/w/000f7ed6658f9d30/", 0, {
      settings: [PEOPLE_SETTINGS],
      shellWorkspaceId: ACME.id,
    });
    expect(byTestId("top-bar-app-settings")).toBeUndefined();
  });

  test("a settings sub-slot placement is not a settings section", async () => {
    await mountBar("/w/000f7ed6658f9d30/app/people", 0, {
      settings: [{ ...PEOPLE_SETTINGS, slot: "settings.extra" }],
      shellWorkspaceId: ACME.id,
    });
    expect(byTestId("top-bar-app-settings")).toBeUndefined();
  });

  test("no gear while the shell still holds another workspace's placements", async () => {
    await mountBar("/w/000f7ed6658f9d30/app/people", 0, { settings: [PEOPLE_SETTINGS] });
    expect(byTestId("top-bar-app-settings")).toBeUndefined();
  });

  describe("an app with several views", () => {
    const OUTREACH = {
      sidebar: [PEOPLE, OUTREACH_REPLIES, OUTREACH_CAMPAIGNS],
      shellWorkspaceId: ACME.id,
      connectors: {
        workspaceId: ACME.id,
        installed: [{ serverName: "outreach", displayName: "Outreach" } as InstalledConnector],
      },
    };
    const crumbLinks = () =>
      Array.from(container.getElementsByTagName("a")).filter(
        (el) => el.getAttribute("data-testid") === "top-bar-crumb",
      );

    test("a single-view app gets no app crumb", async () => {
      await mountBar("/w/000f7ed6658f9d30/app/people", 0, OUTREACH);
      await act(async () =>
        location.setAppLocation({ trail: [{ id: "list", label: "Contacts" }], navigate: () => {} }),
      );
      expect(byTestId("top-bar-breadcrumb")).toBeUndefined();
      expect(byTestId("top-bar-back")).toBeUndefined();
      expect(byTestId("top-bar-title")?.textContent).toBe("Contacts");
    });

    test("a view's root is named after the app, which links to its first view", async () => {
      await mountBar("/w/000f7ed6658f9d30/app/outreach/campaigns", 0, OUTREACH);
      const navigate = mock((_id: string) => {});
      await act(async () =>
        location.setAppLocation({ trail: [{ id: "campaigns", label: "Campaigns" }], navigate }),
      );

      expect(byTestId("top-bar-title")?.textContent).toBe("Campaigns");
      const crumbs = crumbLinks();
      expect(crumbs.map((c) => c.textContent)).toEqual(["Outreach"]);
      expect(crumbs[0].getAttribute("href")).toBe("/w/000f7ed6658f9d30/app/outreach");
      const back = byTestId("top-bar-back");
      expect(back?.getAttribute("aria-label")).toBe("Back to Outreach");
      expect(back?.getAttribute("href")).toBe("/w/000f7ed6658f9d30/app/outreach");
      expect(navigate.mock.calls).toEqual([]);
    });

    test("a deep trail follows the app crumb, and back still asks the app one step up", async () => {
      await mountBar("/w/000f7ed6658f9d30/app/outreach/campaigns", 0, OUTREACH);
      const navigate = mock((_id: string) => {});
      await act(async () =>
        location.setAppLocation({
          trail: [
            { id: "campaigns", label: "Campaigns" },
            { id: "campaigns/q3", label: "Q3 Pilot" },
          ],
          navigate,
        }),
      );

      expect(byTestId("top-bar-title")?.textContent).toBe("Q3 Pilot");
      expect(crumbLinks().map((c) => c.textContent)).toEqual(["Outreach"]);
      expect(crumbButtons().map((c) => c.textContent)).toEqual(["Campaigns"]);
      const back = byTestId("top-bar-back");
      expect(back?.getAttribute("aria-label")).toBe("Back to Campaigns");
      await act(async () => back?.click());
      expect(navigate.mock.calls).toEqual([["campaigns"]]);
    });

    test("the app crumb stays outside the fold of a long trail", async () => {
      await mountBar("/w/000f7ed6658f9d30/app/outreach/campaigns", 0, OUTREACH);
      const trail = ["a", "b", "c", "d", "e"].map((id) => ({ id, label: id.toUpperCase() }));
      await act(async () => location.setAppLocation({ trail, navigate: () => {} }));

      expect(crumbLinks().map((c) => c.textContent)).toEqual(["Outreach"]);
      expect(crumbButtons().map((c) => c.textContent)).toEqual(["A", "D"]);
    });

    test("on the first view's root the crumb names the app, with no back to the same page", async () => {
      await mountBar("/w/000f7ed6658f9d30/app/outreach", 0, OUTREACH);
      await act(async () =>
        location.setAppLocation({
          trail: [{ id: "replies", label: "Replies" }],
          navigate: () => {},
        }),
      );
      expect(crumbLinks().map((c) => c.textContent)).toEqual(["Outreach"]);
      expect(byTestId("top-bar-back")).toBeUndefined();
    });

    test("before the installed list lands, the crumb takes the first view's label", async () => {
      await mountBar("/w/000f7ed6658f9d30/app/outreach/campaigns", 0, {
        ...OUTREACH,
        connectors: undefined,
      });
      expect(crumbLinks().map((c) => c.textContent)).toEqual(["Replies"]);
    });

    test("no app crumb while the shell still holds another workspace's placements", async () => {
      await mountBar("/w/000f7ed6658f9d30/app/outreach/campaigns", 0, {
        ...OUTREACH,
        shellWorkspaceId: undefined,
      });
      expect(byTestId("top-bar-breadcrumb")).toBeUndefined();
    });
  });
});
