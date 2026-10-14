import { describe, expect, test } from "bun:test";
import type { PlacementEntry } from "../types";
import { platformFirst, routablePlacements } from "./routable-placements";

// The platform's Conversations placement, as `src/platform/conversations` declares it.
const conversations: PlacementEntry = {
  serverName: "conversations",
  slot: "sidebar",
  resourceUri: "ui://conversations/browser",
  route: "@nimblebraininc/conversations",
  label: "Conversations",
  priority: 1,
};

function connector(serverName: string, route: string, priority: number): PlacementEntry {
  return {
    serverName,
    slot: "sidebar.apps",
    resourceUri: `ui://${serverName}/main`,
    route,
    label: serverName,
    priority,
    wsId: "ws_a",
  };
}

describe("routablePlacements", () => {
  test("a connector placement on a platform route never takes it, whatever its priority", () => {
    const spoof = connector("acme-corp", "@nimblebraininc/conversations", 0);
    // `forSlot("sidebar")` sorts by priority, so the spoof arrives first.
    const out = routablePlacements([spoof, conversations], []);
    expect(out).toEqual([conversations]);
  });

  test("a route that differs only in case, escapes or slashes still collides", () => {
    for (const route of [
      "@NimbleBrainInc/Conversations",
      "%40nimblebraininc/conversations",
      "/@nimblebraininc//conversations/",
    ]) {
      const out = routablePlacements([connector("acme-corp", route, 0), conversations], []);
      expect(out).toEqual([conversations]);
    }
  });

  test("between two connectors, the first in priority order keeps the route", () => {
    const first = connector("tenant-a-crm", "@acme-corp/crm", 10);
    const second = connector("tenant-b-crm", "@acme-corp/crm", 20);
    expect(routablePlacements([first, second], [])).toEqual([first]);
  });

  test("distinct routes all register, platform placements first", () => {
    const tasks = connector("tasks", "@nimblebraininc/tasks", 0);
    const main: PlacementEntry = {
      serverName: "people",
      slot: "main",
      resourceUri: "ui://people/main",
      route: "@nimblebraininc/people",
      priority: 100,
      wsId: "ws_a",
    };
    expect(routablePlacements([tasks, conversations], [main])).toEqual([
      conversations,
      tasks,
      main,
    ]);
  });

  test("the sidebar.bottom tray is not routed from the sidebar", () => {
    const tray = { ...connector("tray", "@acme-corp/tray", 0), slot: "sidebar.bottom" };
    expect(routablePlacements([tray], [])).toEqual([]);
  });
});

describe("platformFirst", () => {
  test("puts platform placements ahead of connector ones, keeping each group's order", () => {
    const a = connector("a", "@acme-corp/a", 0);
    const b = connector("b", "@acme-corp/b", 5);
    expect(platformFirst([a, conversations, b])).toEqual([conversations, a, b]);
  });
});
