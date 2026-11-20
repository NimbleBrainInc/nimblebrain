// ---------------------------------------------------------------------------
// The old connector and skill addresses, now managed on Plugins.
//
// Pins:
//   1. Workspace settings no longer lists Connectors or Skills, the profile
//      no longer lists them, and each area's landing tab is still one it lists.
//   2. Each old address lands on a Plugins page, keeping its query (a sign-in
//      callback's `?connected=`): settings/connectors and settings/skills on
//      Installed, settings/connectors/browse on Browse.
//   3. The profile's old addresses, which name no workspace, land on the
//      focused workspace's Plugins, else the default workspace's, else the
//      first in sidebar order, and on home for a viewer with no workspace.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, mock, test } from "bun:test";
import { defineHappyDomErrorClasses } from "./happy-dom";
import { realClient } from "./setup";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

defineHappyDomErrorClasses();

mock.module("../src/api/client", () => ({
  ...realClient,
  setActiveWorkspaceId: () => {},
  getActiveWorkspaceId: () => null,
}));

const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter, Route, Routes, useLocation } = await import("react-router-dom");
const { WorkspaceProvider } = await import("../src/context/WorkspaceContext");
const { landingTab, PROFILE_TABS, WORKSPACE_SETTINGS_TABS } = await import(
  "../src/lib/settings-tabs"
);
const {
  pluginsTarget,
  ProfilePluginsRedirect,
  profileRedirectWorkspace,
  WorkspacePluginsRedirect,
  WorkspaceSkillsRedirect,
} = await import("../src/pages/PluginsRedirects");

import type { WorkspaceInfo } from "../src/context/WorkspaceContext";

const ws = (id: string, name: string): WorkspaceInfo => ({
  id,
  name,
  connectorCount: 0,
  memberCount: 1,
  userRole: "admin",
});
const ALPHA = ws("ws_00a1b2c3d4e5f607", "Alpha");
const BETA = ws("ws_0076759dbbe19fcc", "Beta");

const probe = { path: "" };
function Probe() {
  const location = useLocation();
  probe.path = location.pathname + location.search;
  return null;
}

let root: ReturnType<typeof ReactDOMClient.createRoot> | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  localStorage.clear();
});

/** The old addresses as `App.tsx` routes them, and where each lands. */
async function visit(
  path: string,
  workspaces: WorkspaceInfo[] = [ALPHA, BETA],
  activeId?: string,
): Promise<string> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[path]}>
        <WorkspaceProvider initialWorkspaces={workspaces} initialActiveId={activeId}>
          <Probe />
          <Routes>
            <Route path="/w/:slug/settings/connectors" element={<WorkspacePluginsRedirect />} />
            <Route
              path="/w/:slug/settings/connectors/browse"
              element={<WorkspacePluginsRedirect tab="browse" />}
            />
            <Route path="/w/:slug/settings/skills" element={<WorkspaceSkillsRedirect />} />
            <Route path="/profile/connectors" element={<ProfilePluginsRedirect />} />
            <Route path="/profile/skills" element={<ProfilePluginsRedirect page="skills" />} />
            <Route path="*" element={null} />
          </Routes>
        </WorkspaceProvider>
      </MemoryRouter>,
    );
  });
  return probe.path;
}

describe("settings and profile navigation", () => {
  test("workspace settings lists no Connectors or Skills tab, and lands on General", () => {
    const segments = WORKSPACE_SETTINGS_TABS.map((t) => t.segment);
    expect(segments).not.toContain("connectors");
    expect(segments).not.toContain("skills");
    expect(landingTab(WORKSPACE_SETTINGS_TABS)).toBe("general");
  });

  test("the profile lists General alone", () => {
    expect(PROFILE_TABS.map((t) => t.segment)).toEqual(["general"]);
    expect(landingTab(PROFILE_TABS)).toBe("general");
  });
});

describe("old workspace addresses", () => {
  const slug = "000f7ed6658f9d30";

  test("settings/connectors opens Plugins, keeping a callback's query", async () => {
    expect(await visit(`/w/${slug}/settings/connectors`)).toBe(`/w/${slug}/plugins`);
    expect(await visit(`/w/${slug}/settings/connectors?connected=com-acme-notes`)).toBe(
      `/w/${slug}/plugins?connected=com-acme-notes`,
    );
  });

  test("settings/connectors/browse opens Browse plugins", async () => {
    expect(await visit(`/w/${slug}/settings/connectors/browse`)).toBe(`/w/${slug}/plugins/browse`);
  });

  test("settings/skills opens Skills", async () => {
    expect(await visit(`/w/${slug}/settings/skills`)).toBe(`/w/${slug}/skills`);
  });
});

describe("old profile addresses", () => {
  test("open the focused workspace's Plugins, keeping the query", async () => {
    expect(await visit("/profile/connectors?connected=granola", [ALPHA, BETA], BETA.id)).toBe(
      "/w/0076759dbbe19fcc/plugins?connected=granola",
    );
    // A personal sign-in with no workspace to return to lands on the profile
    // address; its notice needs both parameters.
    expect(
      await visit("/profile/connectors?connected=granola&owner=person", [ALPHA, BETA], BETA.id),
    ).toBe("/w/0076759dbbe19fcc/plugins?connected=granola&owner=person");
    expect(await visit("/profile/skills", [ALPHA, BETA], BETA.id)).toBe(
      "/w/0076759dbbe19fcc/skills",
    );
  });

  test("without a focused workspace, open the first in sidebar order", async () => {
    expect(await visit("/profile/connectors", [BETA, ALPHA])).toBe("/w/00a1b2c3d4e5f607/plugins");
  });

  test("with no workspace, go home", async () => {
    expect(await visit("/profile/connectors", [])).toBe("/");
  });

  test("the focused workspace wins, then the last one, then the first in sidebar order", () => {
    expect(profileRedirectWorkspace([ALPHA, BETA], BETA.id, ALPHA.id)).toBe(BETA);
    expect(profileRedirectWorkspace([ALPHA, BETA], null, BETA.id)).toBe(BETA);
    expect(profileRedirectWorkspace([ALPHA, BETA], null, "ws_gone")).toBe(ALPHA);
    expect(profileRedirectWorkspace([], null, null)).toBeUndefined();
  });
});

describe("pluginsTarget", () => {
  test("keeps the query, drops the old tab, and picks the page", () => {
    expect(pluginsTarget("abc", "")).toBe("/w/abc/plugins");
    expect(pluginsTarget("abc", "?connected=x", "browse")).toBe(
      "/w/abc/plugins/browse?connected=x",
    );
    expect(pluginsTarget("abc", "?tab=installed", "browse")).toBe("/w/abc/plugins/browse");
    expect(pluginsTarget("abc", "", "skills")).toBe("/w/abc/skills");
  });
});
