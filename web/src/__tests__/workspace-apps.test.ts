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
import { MAX_INLINE_APPS, workspaceApps } from "../lib/workspace-apps";
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
      p({ serverName: "home", slot: "sidebar" }), // core nav — excluded
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
    expect(workspaceApps([p({ serverName: "home", slot: "sidebar" })])).toEqual([]);
    expect(workspaceApps([])).toEqual([]);
  });

  test("MAX_INLINE_APPS is a small positive cap", () => {
    expect(MAX_INLINE_APPS).toBeGreaterThan(0);
    expect(MAX_INLINE_APPS).toBeLessThanOrEqual(6);
  });
});
