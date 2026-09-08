/**
 * "Send a test message" — the affordance that answers *will this route deliver?*
 *
 * The real store, the real route dispatcher and the real unattended door, with
 * a recording tool source at the far end. A mocked dispatch would pass for
 * every failure this button exists to surface, so the only fixture is the
 * connector itself.
 *
 * The two properties worth pinning are the two an operator acts on: a test
 * that reaches the tool reports what the tool did, and a test that never
 * matched says *why* rather than reporting an empty ledger — which is what a
 * ceiling-blocked route and a broken one look like alike.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NoopEventSink } from "../../../src/adapters/noop-events.ts";
import type { EngineEvent, EventSink, ToolResult } from "../../../src/engine/types.ts";
import { IdentityContext } from "../../../src/identity/context.ts";
import type { NotificationRoute } from "../../../src/notifications/config.ts";
import { RouteDispatcher } from "../../../src/notifications/routes.ts";
import { sendTestNotification } from "../../../src/notifications/send-test.ts";
import { NotificationStore } from "../../../src/notifications/store.ts";
import { nameForGlob } from "../../../src/notifications/test-envelope.ts";
import {
  dispatchUnattended,
  type UnattendedDispatchRuntime,
} from "../../../src/orchestrator/unattended-dispatch.ts";
import type { Tool, ToolSource } from "../../../src/tools/types.ts";
import { WorkspaceContext } from "../../../src/workspace/context.ts";
import { WorkspaceStore } from "../../../src/workspace/workspace-store.ts";

const AUTHOR = "usr_admin";
const SOURCE = "acme-mcp";

let workDir: string;
let workspaceStore: WorkspaceStore;
let wsId: string;
let calls: Array<{ toolName: string; input: Record<string, unknown> }>;
let members: string[];
let toolFails: boolean;
const events: EngineEvent[] = [];

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), "nb-notify-send-test-"));
  workspaceStore = new WorkspaceStore(workDir);
  wsId = (await workspaceStore.create("Outbound")).id;
  calls = [];
  members = [AUTHOR];
  toolFails = false;
  events.length = 0;
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function slackSource(): ToolSource {
  return {
    name: "slack",
    async start(): Promise<void> {},
    async stop(): Promise<void> {},
    async tools(): Promise<Tool[]> {
      return [];
    },
    async execute(toolName: string, input: Record<string, unknown>): Promise<ToolResult> {
      calls.push({ toolName, input });
      if (toolFails) return { content: [{ type: "text", text: "no such channel" }], isError: true };
      return { content: [{ type: "text", text: "posted" }], isError: false };
    },
  };
}

function dispatchRuntime(): UnattendedDispatchRuntime {
  const slack = slackSource();
  const sink: EventSink = { emit: (event) => events.push(event) };
  return {
    async isPrincipalWorkspaceMember(_wsId: string, principalId: string): Promise<boolean> {
      return members.includes(principalId);
    },
    getEventSink: () => sink,
    getWorkspaceContext: (id: string) => new WorkspaceContext({ wsId: id, workDir }),
    getRegistryForWorkspace: () => ({
      getSource: (name: string) => (name === "slack" ? slack : undefined),
    }),
    getIdentitySource: () => undefined,
    async getIdentityConnectorSource() {
      return undefined;
    },
    getIdentityContext: (identityId: string) =>
      new IdentityContext({ userId: identityId, workDir }),
    async listToolsForWorkspace() {
      return [];
    },
  } as unknown as UnattendedDispatchRuntime;
}

function storeFor(id: string): NotificationStore {
  return new NotificationStore(new WorkspaceContext({ wsId: id, workDir }), {
    eventSink: new NoopEventSink(),
  });
}

function dispatcher(): RouteDispatcher {
  const runtime = dispatchRuntime();
  return new RouteDispatcher({
    workspaceStore,
    storeFor,
    workspaceIds: async () => (await workspaceStore.list()).map((ws) => ws.id),
    dispatch: (opts) => dispatchUnattended(runtime, opts),
    eventSink: { emit: (event) => events.push(event) },
  });
}

const ROUTE: NotificationRoute = {
  id: "rt_slack",
  createdBy: AUTHOR,
  match: { source: SOURCE, name: "domain.*", level: "attention" },
  deliver: [
    {
      kind: "tool",
      tool: "slack__send_message",
      input: { channel: "alerts", text: "{{title}} — {{subject}}" },
    },
  ],
};

/** Store the route and the source ceiling, then run one test send. */
async function send(ceiling: "info" | "attention" | "urgent", route = ROUTE) {
  const config = {
    sources: { [SOURCE]: { maxLevel: ceiling } },
    routes: [route],
  };
  await workspaceStore.update(wsId, { notifications: config });
  return sendTestNotification({
    wsId,
    route,
    config,
    requestedBy: AUTHOR,
    store: storeFor(wsId),
    dispatcher: dispatcher(),
    declaredSources: [SOURCE],
  });
}

describe("nameForGlob", () => {
  test("fills a wildcard with a segment the same glob admits", () => {
    expect(nameForGlob("domain.*")).toBe("domain.test");
    expect(nameForGlob("reply.**")).toBe("reply.test");
  });

  test("passes a concrete name through", () => {
    expect(nameForGlob("domain.active")).toBe("domain.active");
  });

  test("answers for a route that matches every name", () => {
    expect(nameForGlob(undefined)).toBe("notifications.test");
    expect(nameForGlob("**")).toBe("test");
  });
});

describe("a route that can deliver", () => {
  test("calls the tool and reports the ledger row", async () => {
    const out = await send("attention");

    expect(out.matched).toBe(true);
    expect(out.source).toBe(SOURCE);
    expect(out.effectiveLevel).toBe("attention");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.toolName).toBe("send_message");
    expect(out.deliveries).toHaveLength(1);
    expect(out.deliveries[0]?.outcome).toBe("delivered");
    expect(out.deliveries[0]?.routeId).toBe("rt_slack");
  });

  test("the item is in the inbox, marked as a test", async () => {
    const out = await send("attention");
    const stored = storeFor(wsId).list({ limit: 10 });

    expect(stored).toHaveLength(1);
    expect(stored[0]?.envelope.data).toMatchObject({ test: true, routeId: "rt_slack" });
    expect(stored[0]?.envelope._meta?.["ai.nimblebrain/notification"]?.title).toContain("Test");
  });

  test("two sends are two items, not one deduped away", async () => {
    await send("attention");
    await send("attention");
    expect(storeFor(wsId).list({ limit: 10 })).toHaveLength(2);
    expect(calls).toHaveLength(2);
  });

  test("a tool that refuses is reported, not swallowed", async () => {
    toolFails = true;
    const out = await send("attention");

    expect(out.matched).toBe(true);
    // The door answered, so the row is the door's verdict rather than a throw.
    expect(out.deliveries[0]?.outcome).not.toBe("delivered");
  });
});

describe("a route that cannot fire", () => {
  test("a ceiling below the route's minimum says so instead of an empty ledger", async () => {
    const out = await send("info");

    expect(out.matched).toBe(false);
    expect(out.effectiveLevel).toBe("info");
    expect(out.deliveries).toEqual([]);
    expect(out.reason).toContain("ceiling");
    expect(out.reason).toContain(SOURCE);
    // Nothing was called: the point is that the route would not have fired.
    expect(calls).toHaveLength(0);
  });

  test("an author who has left the workspace lands as a skip on the row", async () => {
    members = [];
    const out = await send("attention");

    expect(out.matched).toBe(true);
    expect(out.deliveries[0]?.outcome).toBe("skipped");
    expect(out.deliveries[0]?.classification).toBe("owner_not_member");
    expect(calls).toHaveLength(0);
  });
});

describe("only the route under test", () => {
  test("a second route matching the same item is not dispatched", async () => {
    const other: NotificationRoute = {
      id: "rt_other",
      createdBy: AUTHOR,
      match: { source: SOURCE },
      deliver: [{ kind: "tool", tool: "slack__send_message", input: { channel: "everything" } }],
    };
    const config = {
      sources: { [SOURCE]: { maxLevel: "attention" as const } },
      routes: [ROUTE, other],
    };
    await workspaceStore.update(wsId, { notifications: config });

    const out = await sendTestNotification({
      wsId,
      route: ROUTE,
      config,
      requestedBy: AUTHOR,
      store: storeFor(wsId),
      dispatcher: dispatcher(),
      declaredSources: [SOURCE],
    });

    expect(out.deliveries).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input.channel).toBe("alerts");
  });
});
