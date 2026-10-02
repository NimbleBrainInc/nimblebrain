// ---------------------------------------------------------------------------
// workspaceApps — the shared app-set projection used by both the sidebar
// quick-list and the workspace overview grid. Pins three contracts:
//   1. Only grouped sidebar slots (`sidebar.<group>`) count as apps —
//      bare `sidebar` (core nav), `sidebar.bottom` (utility tray), and
//      `main` are excluded.
//   2. One entry per app (`serverName`), keeping the highest-priority
//      (lowest-number) placement when an app declares several.
//   3. Sorted by priority ascending, so "top N" is meaningful.
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";
import {
  appsByConnector,
  connectorSettingsPath,
  iconMapFromInstalled,
  MAX_INLINE_APPS,
  workspaceApps,
} from "../lib/workspace-apps";
import type { PlacementEntry } from "../types";

function p(over: Partial<PlacementEntry> & { serverName: string; slot: string }): PlacementEntry {
  return {
    resourceUri: `ui://${over.serverName}/main`,
    priority: 100,
    route: over.serverName,
    label: over.serverName,
    ...over,
  };
}

describe("workspaceApps", () => {
  test("keeps only grouped sidebar slots", () => {
    const out = workspaceApps([
      p({ serverName: "core-nav", slot: "sidebar" }), // core nav — excluded
      p({ serverName: "tray", slot: "sidebar.bottom" }), // utility tray — excluded
      p({ serverName: "main-app", slot: "main" }), // not a sidebar slot — excluded
      p({ serverName: "crm", slot: "sidebar.apps" }), // app — kept
      p({ serverName: "research", slot: "sidebar.research" }), // app — kept
    ]);
    expect(out.map((e) => e.serverName).sort()).toEqual(["crm", "research"]);
  });

  test("keeps every matching placement (no dedup) — a route is a destination", () => {
    // An app may declare multiple sidebar placements (distinct routes /
    // views). Each is its own navigable card, so we keep them all; callers
    // key by resourceUri, not serverName.
    const out = workspaceApps([
      p({ serverName: "crm", slot: "sidebar.apps", priority: 50, route: "crm/list" }),
      p({ serverName: "crm", slot: "sidebar.apps", priority: 10, route: "crm/board" }),
    ]);
    expect(out).toHaveLength(2);
    // Sorted by priority — the board view (10) comes before the list (50).
    expect(out.map((e) => e.route)).toEqual(["crm/board", "crm/list"]);
  });

  test("sorts by priority ascending", () => {
    const out = workspaceApps([
      p({ serverName: "c", slot: "sidebar.apps", priority: 30 }),
      p({ serverName: "a", slot: "sidebar.apps", priority: 10 }),
      p({ serverName: "b", slot: "sidebar.apps", priority: 20 }),
    ]);
    expect(out.map((e) => e.serverName)).toEqual(["a", "b", "c"]);
  });

  test("returns [] when there are no app placements", () => {
    expect(workspaceApps([p({ serverName: "core-nav", slot: "sidebar" })])).toEqual([]);
    expect(workspaceApps([])).toEqual([]);
  });

  test("MAX_INLINE_APPS is a small positive cap", () => {
    expect(MAX_INLINE_APPS).toBeGreaterThan(0);
    expect(MAX_INLINE_APPS).toBeLessThanOrEqual(10);
  });
});

describe("iconMapFromInstalled", () => {
  test("maps serverName -> iconUrl, omitting connectors without an icon", () => {
    const map = iconMapFromInstalled([
      { serverName: "crm", iconUrl: "https://cdn/crm.png" },
      { serverName: "todo" }, // no icon → omitted; caller falls back to a letter avatar
      { serverName: "sf", iconUrl: "https://cdn/sf.svg" },
    ]);
    expect(map.get("crm")).toBe("https://cdn/crm.png");
    expect(map.get("sf")).toBe("https://cdn/sf.svg");
    expect(map.has("todo")).toBe(false);
    expect(map.size).toBe(2);
  });

  test("empty list -> empty map", () => {
    expect(iconMapFromInstalled([]).size).toBe(0);
  });
});

describe("connectorSettingsPath", () => {
  test("a connector's settings page in the workspace, its name encoded", () => {
    expect(connectorSettingsPath("acme", "com-acme-tasks")).toBe(
      "/w/acme/settings/connectors/com-acme-tasks",
    );
    expect(connectorSettingsPath("acme", "a/b")).toBe("/w/acme/settings/connectors/a%2Fb");
  });

  test("no workspace -> null", () => {
    expect(connectorSettingsPath(null, "com-acme-tasks")).toBeNull();
    expect(connectorSettingsPath(undefined, "com-acme-tasks")).toBeNull();
  });

  test("an identity app has no workspace settings page -> null", () => {
    expect(connectorSettingsPath("acme", "conversations")).toBeNull();
  });
});

describe("appsByConnector", () => {
  test("a connector that places several views is one app holding them in order", () => {
    const apps = appsByConnector(
      workspaceApps([
        p({ serverName: "tasks", slot: "sidebar.apps", priority: 50 }),
        p({ serverName: "people", slot: "sidebar.apps", priority: 11, route: "people/orgs" }),
        p({ serverName: "people", slot: "sidebar.apps", priority: 10, route: "people" }),
        p({ serverName: "people", slot: "sidebar.apps", priority: 60, route: "people/deals" }),
      ]),
    );
    // Apps keep the order of their first view, so a later view of an earlier app
    // does not move it.
    expect(apps.map((a) => a.serverName)).toEqual(["people", "tasks"]);
    expect(apps[0]?.views.map((v) => v.route)).toEqual(["people", "people/orgs", "people/deals"]);
    expect(apps[1]?.views).toHaveLength(1);
  });

  test("no placements, no apps", () => {
    expect(appsByConnector([])).toEqual([]);
  });
});
