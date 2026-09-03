/**
 * The notifications door is walled to ONE workspace.
 *
 * Notifications are workspace-owned, so every read and every mark resolves
 * inside exactly one workspace — `RequestContext.workspaceId`, set by the door
 * the request came through, exactly as it works for `conversations__*` and
 * `files__*` (see `conversations-workspace-scope.test.ts`).
 *
 * The property that matters: the workspace is AMBIENT and validated, never a
 * coordinate the caller supplies. A caller that omits it gets a denial, not a
 * cross-workspace read; and an id that is real in another workspace marks
 * nothing here.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NoopEventSink } from "../../../../src/adapters/noop-events.ts";
import type { ToolResult } from "../../../../src/engine/types.ts";
import { parseNotificationEnvelope } from "../../../../src/notifications/envelope.ts";
import { NotificationStore } from "../../../../src/notifications/store.ts";
import { runWithRequestContext } from "../../../../src/runtime/request-context.ts";
import type { Runtime } from "../../../../src/runtime/runtime.ts";
import type { McpSource } from "../../../../src/tools/mcp-source.ts";
import { createNotificationsSource } from "../../../../src/tools/platform/notifications.ts";
import {
  NotificationsListInput,
  type NotificationsListOutput,
  NotificationsMarkReadInput,
  type NotificationsMarkReadOutput,
} from "../../../../src/tools/platform/schemas/notifications.ts";
import { WorkspaceContext } from "../../../../src/workspace/context.ts";

const OWNER_ID = "usr_test";
const WS_A = "ws_aaaaaaaaaaaaaaaa";
const WS_B = "ws_bbbbbbbbbbbbbbbb";

let workDir: string;
let source: McpSource;

function storeFor(wsId: string): NotificationStore {
  return new NotificationStore(new WorkspaceContext({ wsId, workDir }), {
    eventSink: new NoopEventSink(),
  });
}

/** Write one fixture into a workspace's inbox, the way the poller will. */
function seed(wsId: string, source_: string, eventId: string, extra: Record<string, unknown> = {}) {
  const envelope = parseNotificationEnvelope({
    eventId,
    name: "domain.active",
    timestamp: "2026-09-01T18:42:10Z",
    data: { workspace: wsId },
    ...extra,
  });
  if (!envelope) throw new Error("fixture did not parse");
  return storeFor(wsId).append(source_, envelope).item;
}

function makeRuntime(): Runtime {
  return {
    getNotificationStore: (wsId: string) => storeFor(wsId),
  } as unknown as Runtime;
}

/** Run a notifications tool with `wsId` as the request's bound workspace. */
function exec(
  tool: string,
  args: Record<string, unknown>,
  wsId: string | undefined,
): Promise<ToolResult> {
  return runWithRequestContext(
    { identity: { id: OWNER_ID } as never, ...(wsId ? { workspaceId: wsId } : {}) },
    () => source.execute(tool, args),
  );
}

function payload<T>(result: ToolResult): T {
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("expected a text block");
  return JSON.parse(first.text) as T;
}

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), "nb-notify-source-"));
  source = createNotificationsSource(makeRuntime(), new NoopEventSink());
  await source.start();
});

afterEach(async () => {
  await source.stop();
  rmSync(workDir, { recursive: true, force: true });
});

describe("the door exposes no workspace coordinate", () => {
  // The guard against reintroducing the bug rather than the bug's effect: as
  // soon as `workspaceId` is on the input schema, a caller can name another
  // workspace — or omit it, which is what produced a full-tenant read on the
  // conversations door.
  test("neither input schema has a workspaceId", () => {
    expect(Object.keys(NotificationsListInput.properties)).not.toContain("workspaceId");
    expect(Object.keys(NotificationsMarkReadInput.properties)).not.toContain("workspaceId");
  });

  test("no workspace in scope denies rather than guessing", async () => {
    seed(WS_A, "acme", "a1");
    const result = await exec("list", {}, undefined);
    expect(result.isError).toBe(true);
    expect(payload<{ error: string }>(result).error).toContain("no workspace in scope");
  });
});

describe("list", () => {
  test("returns only the bound workspace's items, newest first", async () => {
    seed(WS_A, "acme", "a1");
    seed(WS_A, "acme", "a2");
    seed(WS_B, "acme", "b1");

    const a = payload<NotificationsListOutput>(await exec("list", {}, WS_A));
    expect(a.notifications.map((n) => n.id)).toEqual(["acme:a2", "acme:a1"]);
    expect(a.cursor).toBe(2);

    const b = payload<NotificationsListOutput>(await exec("list", {}, WS_B));
    expect(b.notifications.map((n) => n.id)).toEqual(["acme:b1"]);
  });

  test("projects the presentation and forwards `data` verbatim", async () => {
    seed(WS_A, "acme", "a1", {
      _meta: {
        "ai.nimblebrain/notification": {
          level: "attention",
          title: "acme-outreach.test is active",
          subject: "acme-outreach.test",
          body: "DNS propagated.",
          link: { resource: "acme://campaigns/1" },
        },
      },
    });
    const out = payload<NotificationsListOutput>(await exec("list", {}, WS_A));
    expect(out.notifications[0]).toMatchObject({
      id: "acme:a1",
      seq: 1,
      source: "acme",
      name: "domain.active",
      level: "attention",
      title: "acme-outreach.test is active",
      subject: "acme-outreach.test",
      body: "DNS propagated.",
      link: { resource: "acme://campaigns/1" },
      data: { workspace: WS_A },
    });
  });

  test("an empty inbox returns no cursor", async () => {
    const out = payload<NotificationsListOutput>(await exec("list", {}, WS_A));
    expect(out.notifications).toEqual([]);
    expect(out.cursor).toBeUndefined();
  });
});

describe("order is what makes the cursor a pager", () => {
  // The replay the SSE stream cannot do: a client that was away walks forward
  // through what it missed, one page at a time, from the cursor it holds.
  test("ascending pages forward from the returned cursor", async () => {
    for (const id of ["a1", "a2", "a3"]) seed(WS_A, "acme", id);

    const first = payload<NotificationsListOutput>(
      await exec("list", { order: "asc", limit: 2 }, WS_A),
    );
    expect(first.notifications.map((n) => n.seq)).toEqual([1, 2]);
    expect(first.cursor).toBe(2);

    const second = payload<NotificationsListOutput>(
      await exec("list", { order: "asc", limit: 2, after: first.cursor }, WS_A),
    );
    expect(second.notifications.map((n) => n.seq)).toEqual([3]);
  });

  test("descending is the default and returns the newest page", async () => {
    for (const id of ["a1", "a2", "a3"]) seed(WS_A, "acme", id);
    const out = payload<NotificationsListOutput>(await exec("list", { limit: 2 }, WS_A));
    expect(out.notifications.map((n) => n.seq)).toEqual([3, 2]);
    expect(out.cursor).toBe(3);
  });

  test("ascending stays inside the bound workspace", async () => {
    seed(WS_A, "acme", "a1");
    seed(WS_B, "acme", "b1");
    const out = payload<NotificationsListOutput>(await exec("list", { order: "asc" }, WS_A));
    expect(out.notifications.map((n) => n.id)).toEqual(["acme:a1"]);
  });
});

describe("mark_read fails closed across the wall", () => {
  test("an id from another workspace marks nothing and is reported skipped", async () => {
    seed(WS_A, "acme", "a1");
    seed(WS_B, "acme", "b1");

    const out = payload<NotificationsMarkReadOutput>(
      await exec("mark_read", { ids: ["acme:b1"] }, WS_A),
    );
    expect(out.marked).toEqual([]);
    expect(out.skipped).toEqual(["acme:b1"]);
    expect(storeFor(WS_B).list()[0]?.readAt).toBeUndefined();
  });

  test("an id in the bound workspace is marked", async () => {
    seed(WS_A, "acme", "a1");
    const out = payload<NotificationsMarkReadOutput>(
      await exec("mark_read", { ids: ["acme:a1", "acme:missing", "not-an-id"] }, WS_A),
    );
    expect(out.marked).toEqual(["acme:a1"]);
    expect(out.skipped).toEqual(["acme:missing", "not-an-id"]);
    expect(storeFor(WS_A).list()[0]?.readAt).toBeDefined();
  });
});

describe("the tool surface frames its content as data", () => {
  test("list says returned content is untrusted connector data, not instruction", async () => {
    const tools = await source.tools();
    const list = tools.find((t) => t.name === "notifications__list");
    expect(list?.description).toContain("untrusted");
    expect(list?.description?.toLowerCase()).toContain("never followed");
  });
});
