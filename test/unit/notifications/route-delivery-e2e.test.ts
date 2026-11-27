/**
 * A notification going the whole way: a connector's outbox to a Slack channel.
 *
 * Every piece between them is the real one — the poller reading a real MCP
 * server over a real transport, the real inbox store on a real directory, the
 * real route evaluator, and the real unattended dispatch with its real gates.
 * Only two things are fixtures, and both are the ends: the outbox that emits,
 * and a "slack" tool source that records what it was called with.
 *
 * That shape is the point. Each of those pieces has its own tests for its own
 * decisions; this one exists to catch what none of them can see — a stamp one
 * side writes and the other does not read, an order that only works in the
 * unit test's arrangement, a level clamped in one place and matched in another.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../../src/adapters/noop-events.ts";
import type { EngineEvent, EventSink, ToolResult } from "../../../src/engine/types.ts";
import { IdentityContext } from "../../../src/identity/context.ts";
import { resolvePollConfig } from "../../../src/notifications/poll-config.ts";
import { NotificationPoller, type PollTarget } from "../../../src/notifications/poller.ts";
import {
  RouteDispatcher,
  type TaskEventAnswer,
  type TaskEventOffer,
} from "../../../src/notifications/routes.ts";
import { NotificationStore } from "../../../src/notifications/store.ts";
import type { Notification } from "../../../src/notifications/types.ts";
import {
  dispatchUnattended,
  type UnattendedDispatchRuntime,
} from "../../../src/orchestrator/unattended-dispatch.ts";
import type { ToolRegistry } from "../../../src/tools/registry.ts";
import type { Tool, ToolSource } from "../../../src/tools/types.ts";
import { WorkspaceContext } from "../../../src/workspace/context.ts";
import { WorkspaceStore } from "../../../src/workspace/workspace-store.ts";
import {
  FIXTURE_OUTBOX_URI,
  fixtureEvent,
  makeOutboxFixture,
  type OutboxFixture,
} from "../../helpers/outbox-fixture.ts";
import { stub } from "../../helpers/stub.ts";

/** Longer than any backoff a default-configured source reaches. */
const PAST_ANY_BACKOFF_MS = 600_000;

/**
 * Pinned so `{{inbox.url}}` renders a literal this test can assert whole.
 * `webOrigin()` reads it per call, so setting it here reaches the dispatcher.
 */
const WEB_ORIGIN_ENV = "NB_WEB_URL";
const WEB_ORIGIN = "https://tenant.example";
let savedWebOrigin: string | undefined;

const AUTHOR = "usr_admin";
const OUTBOX_SOURCE = "fixture-outbox";

/** What the Slack fixture was asked to do. */
interface SlackCall {
  toolName: string;
  input: Record<string, unknown>;
}

let workDir: string;
let workspaceStore: WorkspaceStore;
let wsId: string;
let clock: number;
let slackCalls: SlackCall[];
let members: string[];
let events: EngineEvent[];
const teardown: Array<() => void | Promise<void>> = [];

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), "nb-notify-e2e-"));
  workspaceStore = new WorkspaceStore(workDir);
  wsId = (await workspaceStore.create("Outbound")).id;
  clock = 1_800_000_000_000;
  slackCalls = [];
  members = [AUTHOR];
  events = [];
  inFlight = [];
  savedWebOrigin = process.env[WEB_ORIGIN_ENV];
  process.env[WEB_ORIGIN_ENV] = WEB_ORIGIN;
});

afterEach(async () => {
  for (const stop of teardown.splice(0)) await stop();
  rmSync(workDir, { recursive: true, force: true });
  if (savedWebOrigin === undefined) delete process.env[WEB_ORIGIN_ENV];
  else process.env[WEB_ORIGIN_ENV] = savedWebOrigin;
});

/**
 * The far end: a tool source named `slack`, recording every call.
 *
 * A source rather than a mocked dispatch, so the real door resolves the name,
 * applies its gates and hands the rendered input over exactly as it would to a
 * connector.
 */
function slackSource(): ToolSource {
  return {
    name: "slack",
    async start(): Promise<void> {},
    async stop(): Promise<void> {},
    async tools(): Promise<Tool[]> {
      return [];
    },
    async execute(toolName: string, input: Record<string, unknown>): Promise<ToolResult> {
      slackCalls.push({ toolName, input });
      return { content: [{ type: "text", text: "posted" }], isError: false };
    },
  };
}

/** The runtime surface the real dispatch reaches, and nothing beyond it. */
function dispatchRuntime(): UnattendedDispatchRuntime {
  const slack = slackSource();
  const sink: EventSink = {
    emit(event) {
      events.push(event);
    },
  };
  return stub<UnattendedDispatchRuntime>({
    async isPrincipalWorkspaceMember(_wsId: string, principalId: string): Promise<boolean> {
      return members.includes(principalId);
    },
    getEventSink: () => sink,
    isUnattendedRefused: () => false,
    getWorkspaceContext: (id: string) => new WorkspaceContext({ wsId: id, workDir }),
    getRegistryForWorkspace: () =>
      stub<ToolRegistry>({
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
  });
}

function storeFor(id: string): NotificationStore {
  return new NotificationStore(new WorkspaceContext({ wsId: id, workDir }), {
    eventSink: new NoopEventSink(),
  });
}

async function outbox(): Promise<OutboxFixture> {
  const made = await makeOutboxFixture();
  teardown.push(() => made.stop());
  return made;
}

/**
 * Deliveries the poller started and did not wait for.
 *
 * The production wiring discards these promises on purpose — a poll that
 * awaited a Slack post would spend a workspace's budget on somebody else's
 * timeout — so a test has to hold them itself. Counting event-loop turns
 * instead would pass or fail depending on how loaded the machine is.
 */
let inFlight: Array<Promise<void>>;

/** The whole loop, wired the way `createNotificationsSource` wires it. */
function loop(
  target: PollTarget,
  offerToTask?: (offer: TaskEventOffer) => Promise<TaskEventAnswer>,
): { poller: NotificationPoller; routes: RouteDispatcher } {
  const runtime = dispatchRuntime();
  const routes = new RouteDispatcher({
    workspaceStore,
    storeFor,
    workspaceIds: async () => (await workspaceStore.list()).map((ws) => ws.id),
    dispatch: (opts) => dispatchUnattended(runtime, opts),
    offerToTask:
      offerToTask ??
      (async () => ({
        accepted: false,
        outcome: "denied",
        classification: "tasks_unavailable",
        reason: "no tasks plugin",
      })),
    eventSink: { emit: (event) => events.push(event) },
    now: () => clock,
  });
  const poller = new NotificationPoller({
    targets: async () => [target],
    storeFor,
    workspaceStore,
    onItemStored: (id, item) => {
      inFlight.push(routes.onItem(id, item));
    },
    config: resolvePollConfig(),
    now: () => clock,
  });
  teardown.push(() => {
    poller.stop();
    routes.stop();
  });
  return { poller, routes };
}

function targetFor(fixture: OutboxFixture): PollTarget {
  return {
    wsId,
    serverName: fixture.source.name,
    resource: FIXTURE_OUTBOX_URI,
    source: fixture.source,
  };
}

/** A sweep, and then every delivery it started. See {@link inFlight}. */
async function sweepAndSettle(poller: NotificationPoller): Promise<void> {
  await poller.sweep();
  while (inFlight.length > 0) await Promise.all(inFlight.splice(0));
}

function inbox(): Notification[] {
  return storeFor(wsId).list({ order: "asc" });
}

describe("a connector's fact reaching a Slack channel", () => {
  test("goes outbox → inbox → route → tool, and the ledger records it", async () => {
    await workspaceStore.update(wsId, {
      notifications: {
        sources: { [OUTBOX_SOURCE]: { maxLevel: "urgent" } },
        routes: [
          {
            id: "rt_outbound_slack",
            createdBy: AUTHOR,
            match: { source: OUTBOX_SOURCE, name: "domain.*", level: "attention" },
            deliver: [
              {
                kind: "tool",
                tool: "slack__send_message",
                input: {
                  channel: "#outbound",
                  text: "{{title}} — {{subject}}",
                  url: "{{inbox.url}}",
                },
              },
            ],
          },
        ],
      },
    });

    const fixture = await outbox();
    const { poller } = loop(targetFor(fixture));

    // The bootstrap read establishes a position and returns nothing.
    await sweepAndSettle(poller);
    expect(slackCalls).toHaveLength(0);

    fixture.emit(fixtureEvent("evt_domain_active"));
    // Past any backoff an empty bootstrap poll put the source on.
    clock += PAST_ANY_BACKOFF_MS;
    await sweepAndSettle(poller);

    // It reached the inbox …
    expect(inbox().map((item) => item.envelope.eventId)).toEqual(["evt_domain_active"]);

    // … and it reached Slack, as the route's author, rendered. `url` is the one
    // placeholder no server can supply: the dispatcher has to pair THIS
    // workspace with THIS item's `<source>:<eventId>` id, and neither half is
    // checked by the renderer's own tests — they are handed a host block
    // already built. Spelled out rather than composed from the helpers under
    // test, so a wrong argument at the seam cannot agree with itself.
    expect(slackCalls).toEqual([
      {
        toolName: "send_message",
        input: {
          channel: "#outbound",
          text: "evt_domain_active.example is active — evt_domain_active.example",
          url:
            `${WEB_ORIGIN}/w/${wsId.slice("ws_".length)}/notifications` +
            `?item=${OUTBOX_SOURCE}%3Aevt_domain_active`,
        },
      },
    ]);

    // … and the ledger says so, on the item the browser reads.
    expect(inbox()[0]?.deliveries).toEqual([
      {
        routeId: "rt_outbound_slack",
        target: "slack__send_message",
        index: 0,
        kind: "tool",
        attempts: 1,
        outcome: "delivered",
        updatedAt: new Date(clock).toISOString(),
      },
    ]);

    // The dispatch's own audit line names the route that fired it.
    const audit = events.find((e) => e.type === "audit.unattended_dispatch");
    expect(audit?.data).toMatchObject({
      principalId: AUTHOR,
      tool: "slack__send_message",
      reason: "route:rt_outbound_slack",
      outcome: "ok",
    });
  });

  test("the default ceiling holds the same route back until an admin raises it", async () => {
    // Identical to the case above but for the missing `sources` entry, so the
    // source sits at the `info` default. The fixture's events are `attention`,
    // the route asks for `attention`, and the clamp is the only thing between
    // them.
    await workspaceStore.update(wsId, {
      notifications: {
        routes: [
          {
            id: "rt_outbound_slack",
            createdBy: AUTHOR,
            match: { name: "domain.*", level: "attention" },
            deliver: [{ kind: "tool", tool: "slack__send_message", input: { text: "{{title}}" } }],
          },
        ],
      },
    });

    const fixture = await outbox();
    const { poller } = loop(targetFor(fixture));
    await sweepAndSettle(poller);
    fixture.emit(fixtureEvent("evt_clamped"));
    clock += PAST_ANY_BACKOFF_MS;
    await sweepAndSettle(poller);

    const item = inbox()[0];
    expect(item?.envelope.eventId).toBe("evt_clamped");
    // In the inbox at the level the connector chose, routed at the ceiling.
    expect(item?.effectiveLevel).toBe("info");
    expect(slackCalls).toHaveLength(0);
    expect(item?.deliveries).toEqual([]);
  });

  test("an author who has left the workspace disables the route and posts nothing", async () => {
    members = [];
    await workspaceStore.update(wsId, {
      notifications: {
        sources: { [OUTBOX_SOURCE]: { maxLevel: "urgent" } },
        routes: [
          {
            id: "rt_outbound_slack",
            createdBy: AUTHOR,
            match: {},
            deliver: [{ kind: "tool", tool: "slack__send_message", input: { text: "{{title}}" } }],
          },
        ],
      },
    });

    const fixture = await outbox();
    const { poller } = loop(targetFor(fixture));
    await sweepAndSettle(poller);
    fixture.emit(fixtureEvent("evt_orphaned"));
    clock += PAST_ANY_BACKOFF_MS;
    await sweepAndSettle(poller);

    expect(slackCalls).toHaveLength(0);
    expect(inbox()[0]?.deliveries?.[0]).toMatchObject({
      outcome: "skipped",
      classification: "owner_not_member",
    });

    const ws = await workspaceStore.get(wsId);
    const stored = (ws?.notifications as { routes?: Array<{ disabled?: { reason: string } }> })
      ?.routes?.[0];
    expect(stored?.disabled?.reason).toContain("no longer a member");
  });

  test("a re-read of the same event delivers nothing a second time", async () => {
    await workspaceStore.update(wsId, {
      notifications: {
        sources: { [OUTBOX_SOURCE]: { maxLevel: "urgent" } },
        routes: [
          {
            id: "rt_outbound_slack",
            createdBy: AUTHOR,
            match: {},
            deliver: [{ kind: "tool", tool: "slack__send_message", input: { text: "{{title}}" } }],
          },
        ],
      },
    });

    const fixture = await outbox();
    const { poller } = loop(targetFor(fixture));
    await sweepAndSettle(poller);
    fixture.emit(fixtureEvent("evt_once"));
    clock += PAST_ANY_BACKOFF_MS;
    await sweepAndSettle(poller);
    expect(slackCalls).toHaveLength(1);

    // Drop the cursor: the connector replays from the beginning, which is what
    // an at-least-once transport is allowed to do. The store's dedupe absorbs
    // it, and because routing runs only for an item the poll CREATED, nobody
    // gets a second message.
    const ws = await workspaceStore.get(wsId);
    await workspaceStore.update(wsId, {
      notifications: {
        ...(ws?.notifications as Record<string, unknown>),
        cursors: undefined,
      },
    });
    clock += PAST_ANY_BACKOFF_MS;
    await sweepAndSettle(poller);
    clock += PAST_ANY_BACKOFF_MS;
    await sweepAndSettle(poller);

    expect(inbox()).toHaveLength(1);
    expect(slackCalls).toHaveLength(1);
  });
});

describe("a connector's fact reaching a task", () => {
  const TASK = "reply-triage";

  /** Every offer the dispatcher made, in order. */
  let offers: TaskEventOffer[];

  /** The tasks side: accepts offers for its own event task, refuses the rest as the plugin would. */
  function tasksSide(eventScheduled = true): (offer: TaskEventOffer) => Promise<TaskEventAnswer> {
    offers = [];
    return async (offer) => {
      offers.push(offer);
      if (offer.ownerId !== AUTHOR || offer.taskId !== TASK) {
        return {
          accepted: false,
          outcome: "denied",
          classification: "task_not_found",
          reason: "no such task",
        };
      }
      if (!eventScheduled) {
        return {
          accepted: false,
          outcome: "denied",
          classification: "not_event_scheduled",
          reason: "the task does not run on events",
        };
      }
      return { accepted: true };
    };
  }

  async function configureAgentRoute(): Promise<void> {
    await workspaceStore.update(wsId, {
      notifications: {
        sources: { [OUTBOX_SOURCE]: { maxLevel: "urgent" } },
        routes: [
          {
            id: "rt_triage",
            createdBy: AUTHOR,
            match: { source: OUTBOX_SOURCE, name: "domain.*" },
            deliver: [{ kind: "agent", task: TASK }],
          },
        ],
      },
    });
  }

  /** Let every offer's answer land. */
  const answered = () => new Promise((resolve) => setImmediate(resolve));

  test("goes outbox → inbox → route → offer, and the task holding it is delivered", async () => {
    await configureAgentRoute();
    const fixture = await outbox();
    const { poller } = loop(targetFor(fixture), tasksSide());

    await sweepAndSettle(poller);
    fixture.emit(fixtureEvent("evt_domain_active"));
    clock += PAST_ANY_BACKOFF_MS;
    await sweepAndSettle(poller);
    await answered();

    expect(inbox().map((item) => item.envelope.eventId)).toEqual(["evt_domain_active"]);
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ wsId, taskId: TASK, ownerId: AUTHOR });
    expect(offers[0]?.item.envelope.eventId).toBe("evt_domain_active");
    expect(inbox()[0]?.deliveries?.[0]).toMatchObject({
      kind: "agent",
      outcome: "delivered",
      attempts: 1,
    });
    expect(
      events.filter((e) => e.type === "notification.delivered").map((e) => e.data),
    ).toHaveLength(1);
  });

  test("each fact is offered: coalescing a burst into one run is the task's", async () => {
    await configureAgentRoute();
    const fixture = await outbox();
    const { poller } = loop(targetFor(fixture), tasksSide());

    await sweepAndSettle(poller);
    fixture.emit(fixtureEvent("evt_first"));
    fixture.emit(fixtureEvent("evt_second"));
    clock += PAST_ANY_BACKOFF_MS;
    await sweepAndSettle(poller);
    await answered();

    expect(offers.map((o) => o.item.envelope.eventId).sort()).toEqual(["evt_first", "evt_second"]);
    for (const item of inbox()) {
      expect(item.deliveries?.[0]).toMatchObject({ outcome: "delivered" });
    }
  });

  test("a route naming a task that does not run on events is refused, and the ledger says why", async () => {
    await configureAgentRoute();
    const fixture = await outbox();
    const { poller } = loop(targetFor(fixture), tasksSide(false));

    await sweepAndSettle(poller);
    fixture.emit(fixtureEvent("evt_domain_active"));
    clock += PAST_ANY_BACKOFF_MS;
    await sweepAndSettle(poller);
    await answered();

    expect(inbox()[0]?.deliveries?.[0]).toMatchObject({
      outcome: "denied",
      classification: "not_event_scheduled",
    });
  });

  test("the source ceiling holds the offer back exactly as it holds a tool back", async () => {
    // No `sources` entry, so the connector sits at the `info` default while the
    // fixture emits `attention` and the route asks for it.
    await workspaceStore.update(wsId, {
      notifications: {
        routes: [
          {
            id: "rt_triage",
            createdBy: AUTHOR,
            match: { source: OUTBOX_SOURCE, level: "attention" },
            deliver: [{ kind: "agent", task: TASK }],
          },
        ],
      },
    });

    const fixture = await outbox();
    const { poller } = loop(targetFor(fixture), tasksSide());
    await sweepAndSettle(poller);
    fixture.emit(fixtureEvent("evt_domain_active"));
    clock += PAST_ANY_BACKOFF_MS;
    await sweepAndSettle(poller);
    await answered();

    expect(offers).toHaveLength(0);
    expect(inbox()[0]?.deliveries ?? []).toEqual([]);
  });
});
