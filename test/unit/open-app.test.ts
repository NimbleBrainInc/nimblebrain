// ---------------------------------------------------------------------------
// nb__open_app — the agent's way to put an app on the user's screen.
//
// Pins:
//   1. An app resolves by exact route, then server name, then sidebar label;
//      a placement with no route or outside the nav cannot be opened.
//   2. The tool answers the resolved app and passes the target through; an
//      unknown app is an error that names the apps the model can retry with.
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";
import type { PlacementEntry } from "../../src/connectors/runtime/types.ts";
import type { Runtime } from "../../src/runtime/runtime.ts";
import { createOpenAppTool, findOpenableApp, openableAppNames } from "../../src/tools/open-app.ts";

const placement = (over: Partial<PlacementEntry>): PlacementEntry => ({
  serverName: "people",
  slot: "sidebar.apps",
  resourceUri: "ui://people/main",
  priority: 100,
  ...over,
});

const PLACEMENTS: PlacementEntry[] = [
  placement({ serverName: "people", label: "People", route: "people" }),
  placement({
    serverName: "conversations",
    slot: "sidebar",
    label: "Conversations",
    route: "conversations",
  }),
  placement({ serverName: "tasks", route: "tasks-app" }),
  // Not openable: no route, and a placement outside the nav.
  placement({ serverName: "widget", label: "Widget" }),
  placement({ serverName: "panel", slot: "chat.panel", label: "Panel", route: "panel" }),
];

describe("findOpenableApp", () => {
  test("matches an exact route, then a server name, then a label", () => {
    expect(findOpenableApp(PLACEMENTS, "people")?.serverName).toBe("people");
    expect(findOpenableApp(PLACEMENTS, "tasks")?.route).toBe("tasks-app");
    expect(findOpenableApp(PLACEMENTS, "Conversations")?.serverName).toBe("conversations");
    expect(findOpenableApp(PLACEMENTS, "  people ")?.serverName).toBe("people");
  });

  test("a placement with no route or outside the nav cannot be opened", () => {
    expect(findOpenableApp(PLACEMENTS, "Widget")).toBeUndefined();
    expect(findOpenableApp(PLACEMENTS, "panel")).toBeUndefined();
    expect(openableAppNames(PLACEMENTS)).toEqual(["People", "Conversations", "tasks-app"]);
  });
});

function fakeRuntime(placements: PlacementEntry[]): Runtime {
  const runtime = {
    requireWorkspaceId: () => "ws_a",
    getPlacementRegistry: () => ({
      forWorkspace: (wsId: string) => (wsId === "ws_a" ? placements : []),
    }),
  };
  // The tool reads only these two members.
  return runtime as unknown as Runtime;
}

describe("nb__open_app", () => {
  const tool = createOpenAppTool(fakeRuntime(PLACEMENTS));

  test("answers the resolved app and passes the target through", async () => {
    const result = await tool.handler({ app: "People", target: "people://contacts/123" });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      app: "people",
      name: "People",
      target: "people://contacts/123",
    });
  });

  // The app decides whether it can go to a target and nothing reports back, so
  // the answer must not tell the model the record is on screen.
  test("with a target, the answer claims the app is opening, not that the record is shown", async () => {
    const text = (await tool.handler({ app: "People", target: "people://contacts/123" })).content
      .map((c) => ("text" in c ? c.text : ""))
      .join("");
    expect(text).toContain("Opening People");
    expect(text).toContain("if it supports opening at that address");
    // An app already on screen that cannot follow the target stays where it was, so the
    // fallback must not claim it went home.
    expect(text).toContain("stays on what it was showing if it was already open");
    expect(text).not.toContain("Opened");
  });

  test("an unknown app is an error naming the apps to retry with", async () => {
    const result = await tool.handler({ app: "Payroll" });
    expect(result.isError).toBe(true);
    const text = result.content.map((c) => ("text" in c ? c.text : "")).join("");
    expect(text).toContain('No app named "Payroll"');
    expect(text).toContain("People, Conversations, tasks-app");
  });
});
