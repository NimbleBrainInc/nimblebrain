/**
 * The notification settings tools — ceilings and routes.
 *
 * Three properties carry the design, and all three are asserted here.
 *
 *   1. **Only a workspace admin.** A route decides what a connector does
 *      without being asked, under a stored principal. A member may read the
 *      inbox and may not touch this.
 *   2. **The principal is stamped, never supplied.** `createdBy` is the
 *      identity a route dispatches under, so a body that names one is refused
 *      before the handler runs, and the writer's own identity is what lands.
 *   3. **A route may only name what the workspace has.** A tool outside the
 *      installed set, an automation that does not exist, or a placeholder the
 *      runtime does not resolve is refused at write time — each of those fails
 *      silently at delivery, which is the failure this surface exists to
 *      prevent.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { isInternalTool } from "../../../../src/engine/types.ts";
import {
  NOTIFICATION_SOURCES_MAX,
  type NotificationRouteInput,
  type NotificationsSettingsOutput,
} from "../../../../src/tools/platform/schemas/notifications.ts";
import type { McpSource } from "../../../../src/tools/mcp-source.ts";
import { createNotificationsSource } from "../../../../src/tools/platform/notifications.ts";
import { runWithRequestContext } from "../../../../src/runtime/request-context.ts";
import type { Workspace } from "../../../../src/workspace/types.ts";

const WS = "ws_outbound";
const USER = "usr_admin";
const OTHER = "usr_other";
const TOOL = "slack__send_message";

class FakeRuntime {
  identity: { id: string } | null = { id: USER };
  workspaces = new Map<string, Workspace>();
  automations = [{ id: "auto_triage", name: "Triage replies" }];

  getCurrentIdentity() {
    return this.identity;
  }
  resolveRequestUserId(identity?: { id: string }) {
    return identity?.id ?? "usr_dev";
  }
  getWorkspaceStore() {
    return {
      get: async (id: string) => this.workspaces.get(id) ?? null,
      update: async (id: string, patch: Partial<Workspace>) => {
        const ws = this.workspaces.get(id);
        if (!ws) return null;
        const next = { ...ws, ...patch };
        this.workspaces.set(id, next);
        return next;
      },
    };
  }
  async listNotificationSources() {
    return [
      { source: "precision-outbound", label: "Precision Outbound", description: "Domain lifecycle." },
    ];
  }
  async ensureWorkspaceRegistry() {
    return { availableTools: async () => [{ name: TOOL }, { name: "slack__list_channels" }] };
  }
  getAutomationsContext() {
    return { definitions: () => new Map(this.automations.map((a) => [a.id, a])) };
  }

  seed(role: "admin" | "member"): void {
    this.workspaces.set(WS, {
      id: WS,
      name: WS,
      members: [{ userId: USER, role }],
      bundles: [],
      createdAt: "",
      updatedAt: "",
    } as unknown as Workspace);
  }
}

let runtime: FakeRuntime;
let source: McpSource;
const noopSink = { emit: () => {} } as unknown as never;

beforeEach(async () => {
  runtime = new FakeRuntime();
  runtime.seed("admin");
  source = createNotificationsSource(runtime as unknown as never, noopSink);
  await source.start();
});

/** Run a tool with `WS` as the request's bound workspace. */
function exec(tool: string, args: Record<string, unknown> = {}) {
  return runWithRequestContext({ identity: { id: runtime.identity?.id } as never, workspaceId: WS }, () =>
    source.execute(tool, args),
  );
}

async function settings(): Promise<NotificationsSettingsOutput> {
  const res = await exec("settings");
  expect(res.isError).toBe(false);
  return res.structuredContent as unknown as NotificationsSettingsOutput;
}

function textOf(res: { content?: Array<{ text?: string }> }): string {
  return res.content?.[0]?.text ?? "";
}

const route = (over: Partial<NotificationRouteInput> = {}): NotificationRouteInput => ({
  match: { source: "precision-outbound", name: "domain.*", level: "attention" },
  deliver: [{ kind: "tool", tool: TOOL, input: { channel: "#outbound", text: "{{title}}" } }],
  ...over,
});

describe("the settings tools are operator surface, not agent capability", () => {
  test("all three are internal, so no LLM listing carries them", async () => {
    const tools = await source.tools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of [
      "notifications__settings",
      "notifications__set_source_level",
      "notifications__set_routes",
    ]) {
      const tool = byName.get(name);
      expect(tool).toBeDefined();
      expect(isInternalTool(tool!)).toBe(true);
    }
    // The inbox itself stays reachable: reading notifications is what the
    // agent is for. Only authoring the operator plane is walled off.
    expect(isInternalTool(byName.get("notifications__list")!)).toBe(false);
  });
});

describe("a member cannot configure the workspace", () => {
  beforeEach(() => runtime.seed("member"));

  test("cannot read the settings", async () => {
    const res = await exec("settings");
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("admin");
  });

  test("cannot raise a ceiling", async () => {
    const res = await exec("set_source_level", { source: "precision-outbound", maxLevel: "urgent" });
    expect(res.isError).toBe(true);
    // And nothing was written.
    expect(runtime.workspaces.get(WS)?.notifications).toBeUndefined();
  });

  test("cannot write a route", async () => {
    const res = await exec("set_routes", { routes: [route()] });
    expect(res.isError).toBe(true);
    expect(runtime.workspaces.get(WS)?.notifications).toBeUndefined();
  });
});

describe("the ceiling", () => {
  test("a declared source starts at info, and says nobody set it", async () => {
    const [source_] = (await settings()).sources;
    expect(source_).toEqual({
      source: "precision-outbound",
      label: "Precision Outbound",
      description: "Domain lifecycle.",
      maxLevel: "info",
      configured: false,
    });
  });

  test("raising it persists and reads back as configured", async () => {
    const res = await exec("set_source_level", { source: "precision-outbound", maxLevel: "urgent" });
    expect(res.isError).toBe(false);
    const out = res.structuredContent as unknown as NotificationsSettingsOutput;
    expect(out.sources[0]).toMatchObject({ maxLevel: "urgent", configured: true });
    expect(runtime.workspaces.get(WS)?.notifications?.sources).toEqual({
      "precision-outbound": { maxLevel: "urgent" },
    });
  });

  test("stops admitting new sources at the cap, and still lets an existing one change", async () => {
    // The map lives on the workspace record, and the inbound-delivery door
    // reads every workspace record in full on every delivery. An uncapped key
    // space there is a workspace degrading a path shared with every other one.
    for (let i = 0; i < NOTIFICATION_SOURCES_MAX; i++) {
      const res = await exec("set_source_level", { source: `src-${i}`, maxLevel: "info" });
      expect(res.isError).toBe(false);
    }
    const overflow = await exec("set_source_level", { source: "one-too-many", maxLevel: "info" });
    expect(overflow.isError).toBe(true);
    expect(textOf(overflow)).toContain(String(NOTIFICATION_SOURCES_MAX));

    // The cap bounds how many sources are held, not whether a held one moves.
    const existing = await exec("set_source_level", { source: "src-0", maxLevel: "urgent" });
    expect(existing.isError).toBe(false);
  });

  test("a ceiling whose connector is gone still shows, so it can still be lowered", async () => {
    await exec("set_source_level", { source: "departed", maxLevel: "urgent" });
    const out = await settings();
    expect(out.sources.map((s) => s.source)).toContain("departed");
  });
});

describe("the principal a route dispatches under", () => {
  test("is stamped from the authenticated identity", async () => {
    await exec("set_routes", { routes: [route()] });
    const stored = runtime.workspaces.get(WS)?.notifications?.routes ?? [];
    expect(stored).toHaveLength(1);
    expect(stored[0]?.createdBy).toBe(USER);
    expect(stored[0]?.id).toMatch(/^rt_[0-9a-f]{12}$/);
  });

  test("cannot be supplied in the body — the schema is closed", async () => {
    // Refused by the validator, before the handler runs. That is the point of
    // the field being absent from the schema rather than filtered in code:
    // there is no path through which a caller-supplied principal is seen.
    const res = await exec("set_routes", {
      routes: [{ ...route(), createdBy: OTHER }],
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("must NOT have additional properties");
    expect(runtime.workspaces.get(WS)?.notifications?.routes).toBeUndefined();
  });

  test("cannot be supplied as an `as` field either", async () => {
    const res = await exec("set_routes", { routes: [{ ...route(), as: OTHER }] });
    expect(res.isError).toBe(true);
    expect(runtime.workspaces.get(WS)?.notifications?.routes).toBeUndefined();
  });

  test("moves to whoever rewrites the route, rather than staying with its first author", async () => {
    // An editor who could change a target while keeping somebody else's
    // principal could reach tools their own grants do not.
    await exec("set_routes", { routes: [route()] });
    const id = runtime.workspaces.get(WS)?.notifications?.routes?.[0]?.id;
    runtime.identity = { id: OTHER };
    runtime.workspaces.set(WS, {
      ...(runtime.workspaces.get(WS) as Workspace),
      members: [
        { userId: USER, role: "admin" },
        { userId: OTHER, role: "admin" },
      ],
    });
    await exec("set_routes", { routes: [route({ id })] });
    expect(runtime.workspaces.get(WS)?.notifications?.routes?.[0]?.createdBy).toBe(OTHER);
  });
});

describe("a route may only name what the workspace has", () => {
  test("a tool outside the installed set is rejected", async () => {
    const res = await exec("set_routes", {
      routes: [route({ deliver: [{ kind: "tool", tool: "pagerduty__page" }] })],
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("pagerduty__page");
    expect(runtime.workspaces.get(WS)?.notifications?.routes).toBeUndefined();
  });

  test("an automation that does not exist is rejected", async () => {
    const res = await exec("set_routes", {
      routes: [route({ deliver: [{ kind: "agent", automation: "auto_nope" }] })],
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("auto_nope");
  });

  test("an automation the caller owns is accepted", async () => {
    const res = await exec("set_routes", {
      routes: [route({ deliver: [{ kind: "agent", automation: "auto_triage" }] })],
    });
    expect(res.isError).toBe(false);
  });

  test("a placeholder the runtime does not resolve is rejected", async () => {
    // It would be delivered as the literal characters `{{campaign}}`, which
    // reads as an almost-right message nobody investigates.
    const res = await exec("set_routes", {
      routes: [
        route({ deliver: [{ kind: "tool", tool: TOOL, input: { text: "{{campaign}}" } }] }),
      ],
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("{{campaign}}");
  });

  test("the four documented placeholders are accepted, nested and all", async () => {
    const res = await exec("set_routes", {
      routes: [
        route({
          deliver: [
            {
              kind: "tool",
              tool: TOOL,
              input: {
                blocks: [{ text: "{{title}} — {{subject}}" }, { text: "{{body}}" }],
                url: "{{link.resource}}",
              },
            },
          ],
        }),
      ],
    });
    expect(res.isError).toBe(false);
  });

  test("two routes sharing an id are rejected", async () => {
    const res = await exec("set_routes", {
      routes: [route({ id: "rt_same" }), route({ id: "rt_same" })],
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("rt_same");
  });
});

describe("what the editor is told", () => {
  test("routes are reported as saved-but-not-executed until the dispatch half lands", async () => {
    expect((await settings()).routesExecuted).toBe(false);
  });

  test("the pickers are the sets the write validates against", async () => {
    const out = await settings();
    expect(out.deliverableTools).toEqual(["slack__list_channels", TOOL]);
    expect(out.automations).toEqual([{ id: "auto_triage", name: "Triage replies" }]);
    expect(out.placeholders).toEqual(["title", "body", "subject", "link.resource"]);
  });
});

describe("without a bound workspace", () => {
  test("the settings read denies rather than guessing one", async () => {
    const res = await runWithRequestContext({ identity: { id: USER } as never }, () =>
      source.execute("settings", {}),
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("No workspace in scope");
  });
});
