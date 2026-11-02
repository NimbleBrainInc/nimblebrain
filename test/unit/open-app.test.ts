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
//   4. A template whose match could backtrack without bound (two unbounded
//      expressions, or two not separated by a literal containing `/` or `,`)
//      matches nothing.
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

describe("nb__open_app with a conversation URI", () => {
  /** A runtime whose caller owns `conv_mine` in `ws_a`; any other id or owner is refused, as the store refuses it. */
  function conversationRuntime(callerId: string | undefined): Runtime {
    return stub<Runtime>({
      requireWorkspaceId: () => "ws_a",
      getPlacementRegistry: () => stub<PlacementRegistry>({ forWorkspace: () => PLACEMENTS }),
      getRegistryForWorkspace: () => stub<ReturnType<Runtime["getRegistryForWorkspace"]>>({}),
      getCurrentIdentity: () =>
        callerId
          ? stub<NonNullable<ReturnType<Runtime["getCurrentIdentity"]>>>({ id: callerId })
          : null,
      assertConversationInWorkspace: (id: string, wsId: string, ownerId: string) => {
        if (id !== "conv_mine" || wsId !== "ws_a" || ownerId !== "u_owner") {
          throw new Error("conversation not found");
        }
      },
    });
  }

  test("opens the caller's own conversation in the chat panel", async () => {
    const result = await createOpenAppTool(conversationRuntime("u_owner")).handler({
      uri: "conversation://conv_mine",
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ conversationId: "conv_mine" });
  });

  test("refuses another user's conversation, and any conversation with no caller", async () => {
    for (const callerId of ["u_other", undefined]) {
      const result = await createOpenAppTool(conversationRuntime(callerId)).handler({
        uri: "conversation://conv_mine",
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe("No conversation conversation://conv_mine in this workspace.");
    }
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

  test("a record opens in the view its template names, among its own server's views", async () => {
    const views = [
      placement({ serverName: "people", label: "Contacts", route: "people" }),
      placement({
        serverName: "people",
        label: "Organizations",
        route: "people/organizations",
        resourceUri: "ui://people/organizations",
      }),
      placement({
        serverName: "tasks",
        label: "Tasks",
        route: "tasks-app",
        resourceUri: "ui://tasks/main",
      }),
    ];
    const named = scope({
      placements: views,
      templatesOf: async (name) =>
        name === "people"
          ? [
              { uriTemplate: "people://organizations/{id}", view: "ui://people/organizations" },
              // A view of another server's app is never honoured: the record opens in its own app.
              { uriTemplate: "people://contacts/{id}", view: "ui://tasks/main" },
              { uriTemplate: "people://notes/{id}", view: "ui://people/missing" },
            ]
          : [],
    });
    expect(await resolveOpen(named, "people://organizations/o1")).toEqual({
      destination: {
        app: "people/organizations",
        name: "Organizations",
        target: "people://organizations/o1",
      },
    });
    expect(await resolveOpen(named, "people://contacts/c1")).toEqual({
      destination: { app: "people", name: "Contacts", target: "people://contacts/c1" },
    });
    expect(await resolveOpen(named, "people://notes/n1")).toEqual({
      destination: { app: "people", name: "Contacts", target: "people://notes/n1" },
    });
  });

  test("a template that could backtrack without bound matches nothing; others still match", async () => {
    const only = (uriTemplate: string) =>
      scope({ templatesOf: async (name) => (name === "people" ? [{ uriTemplate }] : []) });
    // Two unbounded expressions before a third: two boundaries that can split many ways.
    expect(await resolveOpen(only("acme://{+a}/{+b}/{c}"), "acme://a/b/c")).toEqual({
      error: "Nothing in this workspace opens acme://a/b/c.",
    });
    // Three expressions with no literal between them.
    expect(await resolveOpen(only("acme://{kind}{id}{rev}"), "acme://abc")).toEqual({
      error: "Nothing in this workspace opens acme://abc.",
    });
    // Expressions separated only by a literal the expressions' class can consume.
    expect(await resolveOpen(only("a{w}b{x}b{y}b{z}c"), "abbbbbbc")).toEqual({
      error: "Nothing in this workspace opens abbbbbbc.",
    });
    // `{;x}` consumes `,`, and `{?x}` consumes `/` and `,`, so neither separates.
    expect(await resolveOpen(only("acme://{;a},{;b},{c}"), "acme://a,b,c")).toEqual({
      error: "Nothing in this workspace opens acme://a,b,c.",
    });
    expect(await resolveOpen(only("acme://x{?a}/{b}{?c}"), "acme://x?a=1/b?c=2")).toEqual({
      error: "Nothing in this workspace opens acme://x?a=1/b?c=2.",
    });
    // An unclosed expression is refused in one pass, however many braces open.
    const started = performance.now();
    expect(await resolveOpen(only("{".repeat(40_000)), "x")).toEqual({
      error: "Nothing in this workspace opens x.",
    });
    expect(performance.now() - started).toBeLessThan(50);
    // One unbounded expression, and expressions separated by `/`, match as before.
    expect(await resolveOpen(only("acme://files/{+path}"), "acme://files/a/b")).toEqual({
      destination: { app: "people", name: "People", target: "acme://files/a/b" },
    });
    expect(await resolveOpen(only("acme://{+path}/x/{#frag}"), "acme://a/x/b")).toEqual({
      destination: { app: "people", name: "People", target: "acme://a/x/b" },
    });
    // A query expression directly after a path expression: one boundary that can split.
    expect(
      await resolveOpen(only("acme://items/{id}{?cursor}"), "acme://items/i1?cursor=x"),
    ).toEqual({
      destination: { app: "people", name: "People", target: "acme://items/i1?cursor=x" },
    });
    expect(
      await resolveOpen(only("acme://items/{id}{/rev}{?cursor}"), "acme://items/i1/r2?cursor=x"),
    ).toEqual({
      destination: { app: "people", name: "People", target: "acme://items/i1/r2?cursor=x" },
    });
    expect(await resolveOpen(only("acme://{kind}/{id}"), "acme://notes/n1")).toEqual({
      destination: { app: "people", name: "People", target: "acme://notes/n1" },
    });
    expect(
      await resolveOpen(only("acme://orgs/{org}/contacts/{id}"), "acme://orgs/o1/contacts/c1"),
    ).toEqual({
      destination: { app: "people", name: "People", target: "acme://orgs/o1/contacts/c1" },
    });
    expect(
      await resolveOpen(only("acme://contacts{?cursor,limit}"), "acme://contacts?cursor=x&limit=5"),
    ).toEqual({
      destination: { app: "people", name: "People", target: "acme://contacts?cursor=x&limit=5" },
    });
  });

  test("a hostile URI costs little: pathological templates are refused, and the rest are at most quadratic", async () => {
    // Unguarded, the second and third templates take seconds against these URIs. The last two
    // are allowed, with one boundary that can split.
    const hostile = scope({
      templatesOf: async (name) =>
        name === "people"
          ? [
              { uriTemplate: "a{+p}b{+q}b{+r}c" },
              { uriTemplate: "{a}{b}{c}{d}" },
              { uriTemplate: "a{w}b{x}b{y}b{z}c" },
              { uriTemplate: "a{w}{?q}c" },
              { uriTemplate: "a{+p}b{q}c" },
            ]
          : [],
    });
    const started = performance.now();
    for (const uri of [`a${"b".repeat(511)}`, `${"x".repeat(511)}/`]) {
      expect(uri).toHaveLength(512);
      expect(await resolveOpen(hostile, uri)).toEqual({
        error: `Nothing in this workspace opens ${uri}.`,
      });
    }
    expect(performance.now() - started).toBeLessThan(50);
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
