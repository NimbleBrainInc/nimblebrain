// ---------------------------------------------------------------------------
// nb__open_app — the one resolver for opening a URI or an app (ADR-0052).
//
// Pins:
//   1. An app resolves by exact route, then server name, then sidebar label;
//      a placement with no route or outside the nav cannot be opened.
//   2. The tool answers an app at its home; an unknown app is an error that
//      names the apps the model can retry with.
//   3. A URI resolves by ownership: a conversation to the chat panel, an app's
//      ui:// root to its home, anything else to the one app whose template it
//      expands from; no claimant or two is refused.
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";
import type { PlacementEntry } from "../../src/connectors/runtime/types.ts";
import type { ToolResult } from "../../src/engine/types.ts";
import type { PlacementRegistry } from "../../src/runtime/placement-registry.ts";
import type { Runtime } from "../../src/runtime/runtime.ts";
import {
  createOpenAppTool,
  findOpenableApp,
  type OpenScope,
  openableAppNames,
  resolveOpen,
} from "../../src/tools/open-app.ts";
import { stub } from "../helpers/stub.ts";

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

/** The tool reads only these members for an `app`, with no `uri` to resolve. */
function fakeRuntime(placements: PlacementEntry[]): Runtime {
  return stub<Runtime>({
    requireWorkspaceId: () => "ws_a",
    getPlacementRegistry: () =>
      stub<PlacementRegistry>({
        forWorkspace: (wsId: string) => (wsId === "ws_a" ? placements : []),
      }),
  });
}

function textOf(result: ToolResult): string {
  return result.content.map((c) => ("text" in c ? c.text : "")).join("");
}

describe("nb__open_app with an app", () => {
  const tool = createOpenAppTool(fakeRuntime(PLACEMENTS));

  test("answers the resolved app at its home", async () => {
    const result = await tool.handler({ app: "People" });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ app: "people", name: "People" });
    expect(textOf(result)).toBe("Opening People.");
  });

  test("an unknown app is an error naming the apps to retry with", async () => {
    const result = await tool.handler({ app: "Payroll" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('No app named "Payroll"');
    expect(textOf(result)).toContain("People, Conversations, tasks-app");
  });

  test("a workspace with no apps says so without listing an empty set", async () => {
    const result = await createOpenAppTool(fakeRuntime([])).handler({ app: "Payroll" });
    expect(textOf(result)).toBe('No app named "Payroll": this workspace has no apps to open.');
  });

  test("takes exactly one of uri or app", async () => {
    expect((await tool.handler({})).isError).toBe(true);
    expect((await tool.handler({ app: "People", uri: "people://contacts/1" })).isError).toBe(true);
  });
});

/** A scope where `people` serves `people://contacts/{id}` and `files` serves `files://{id}`. */
function scope(over: Partial<OpenScope> = {}): OpenScope {
  const templates: Record<string, { uriTemplate: string }[]> = {
    people: [{ uriTemplate: "people://contacts/{id}" }],
    conversations: [],
    tasks: [{ uriTemplate: "not a {valid template" }],
  };
  return {
    placements: PLACEMENTS,
    templatesOf: async (name) => templates[name] ?? [],
    hasConversation: (id) => id === "conv_1",
    ...over,
  };
}

describe("resolveOpen", () => {
  test("a conversation opens in the chat panel when it is the caller's", async () => {
    expect(await resolveOpen(scope(), "conversation://conv_1")).toEqual({
      destination: { conversationId: "conv_1" },
    });
    expect(await resolveOpen(scope(), "conversation://conv_2")).toEqual({
      error: "No conversation conversation://conv_2 in this workspace.",
    });
  });

  test("an app's own ui:// resource opens that app at its home", async () => {
    expect(await resolveOpen(scope(), "ui://people/main")).toEqual({
      destination: { app: "people", name: "People" },
    });
  });

  test("a URI goes to the one app whose template it expands from, carrying the URI", async () => {
    expect(await resolveOpen(scope(), "people://contacts/123")).toEqual({
      destination: { app: "people", name: "People", target: "people://contacts/123" },
    });
  });

  test("a URI no app claims, or one an unparseable template would, opens nowhere", async () => {
    expect(await resolveOpen(scope(), "artifact://a_1")).toEqual({
      error: "Nothing in this workspace opens artifact://a_1.",
    });
    expect(await resolveOpen(scope(), "not a valid template")).toEqual({
      error: "Nothing in this workspace opens not a valid template.",
    });
  });

  test("two apps claiming one URI is refused, naming both", async () => {
    const both = scope({ templatesOf: async () => [{ uriTemplate: "people://contacts/{id}" }] });
    const resolved = await resolveOpen(both, "people://contacts/123");
    expect(resolved).toEqual({
      error: "More than one app claims people://contacts/123: People, Conversations, tasks-app.",
    });
  });

  test("an app outside the nav is never a claimant", async () => {
    const onlyWidget = scope({
      templatesOf: async (name) => (name === "widget" ? [{ uriTemplate: "w://{id}" }] : []),
    });
    expect(await resolveOpen(onlyWidget, "w://1")).toEqual({
      error: "Nothing in this workspace opens w://1.",
    });
  });
});
