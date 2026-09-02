/**
 * `GET /v1/workspaces/:id/notifications` — the replay half of the inbox.
 *
 * The workspace is a path segment here rather than the `X-Workspace-Id`
 * header, so this route has to do for itself what `requireWorkspace` does for
 * the header form. What is pinned below is that naming a workspace does not
 * reach it: membership is checked on every request, an unknown workspace and a
 * non-member workspace answer identically so the route is no existence oracle,
 * and a member's read never crosses into a neighbour's inbox (ADR-0005).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NoopEventSink } from "../../../src/adapters/noop-events.ts";
import { notificationRoutes } from "../../../src/api/routes/notifications.ts";
import type { AppContext } from "../../../src/api/types.ts";
import type { UserIdentity } from "../../../src/identity/provider.ts";
import { parseNotificationEnvelope } from "../../../src/notifications/envelope.ts";
import { NotificationStore } from "../../../src/notifications/store.ts";
import type { Runtime } from "../../../src/runtime/runtime.ts";
import type { NotificationsListOutput } from "../../../src/tools/platform/schemas/notifications.ts";
import { WorkspaceContext } from "../../../src/workspace/context.ts";

const ALICE = "usr_alice";
const BOB = "usr_bob";
const WS_A = "ws_aaaaaaaaaaaaaaaa";
const WS_B = "ws_bbbbbbbbbbbbbbbb";

let workDir: string;

function storeFor(wsId: string): NotificationStore {
  return new NotificationStore(new WorkspaceContext({ wsId, workDir }), {
    eventSink: new NoopEventSink(),
  });
}

function seed(wsId: string, eventId: string): void {
  const envelope = parseNotificationEnvelope({
    eventId,
    name: "domain.active",
    timestamp: "2026-09-01T18:42:10Z",
    data: {},
  });
  if (!envelope) throw new Error("fixture did not parse");
  storeFor(wsId).append("acme", envelope);
}

/**
 * An `AppContext` whose identity provider verifies every request as `caller`.
 * Membership is whatever the workspace records say — that is the thing under
 * test, so it is not stubbed out.
 */
function makeCtx(caller: string): AppContext {
  const identity: UserIdentity = { id: caller } as UserIdentity;
  const workspaces: Record<string, { members: Array<{ userId: string }> }> = {
    [WS_A]: { members: [{ userId: ALICE }] },
    [WS_B]: { members: [{ userId: BOB }] },
  };
  const provider = { verifyRequest: async () => identity };
  return {
    runtime: {
      getIdentityProvider: () => provider,
      getNotificationStore: (wsId: string) => storeFor(wsId),
      getWorkspaceScopedDir: () => workDir,
    } as unknown as Runtime,
    workspaceStore: { get: async (wsId: string) => workspaces[wsId] ?? null },
    authOptions: {
      mode: { type: "adapter", provider },
      internalToken: "internal-token-for-tests",
      eventSink: new NoopEventSink(),
    },
    eventSink: new NoopEventSink(),
    sseManager: new NoopEventSink(),
  } as unknown as AppContext;
}

async function get(caller: string, path: string): Promise<Response> {
  return notificationRoutes(makeCtx(caller)).request(`http://localhost${path}`);
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "nb-notify-route-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("membership decides, not the path", () => {
  test("a member reads their own workspace's inbox in seq order", async () => {
    seed(WS_A, "a1");
    seed(WS_A, "a2");
    const res = await get(ALICE, `/v1/workspaces/${WS_A}/notifications`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as NotificationsListOutput;
    expect(body.notifications.map((n) => n.seq)).toEqual([1, 2]);
    expect(body.cursor).toBe(2);
  });

  test("a non-member is denied the neighbouring workspace", async () => {
    seed(WS_B, "b1");
    const res = await get(ALICE, `/v1/workspaces/${WS_B}/notifications`);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("b1");
  });

  test("an unknown workspace answers exactly as a non-member one does", async () => {
    const denied = await get(ALICE, `/v1/workspaces/${WS_B}/notifications`);
    const unknown = await get(ALICE, "/v1/workspaces/ws_cccccccccccccccc/notifications");
    expect(unknown.status).toBe(denied.status);
    expect((await unknown.json()) as unknown).toMatchObject({ error: "workspace_error" });
  });

  test("a malformed workspace id is a bad request, not a lookup", async () => {
    const res = await get(ALICE, "/v1/workspaces/..%2Fetc/notifications");
    expect(res.status).toBe(400);
  });
});

describe("paging", () => {
  test("`after` resumes from the highest seq the client holds", async () => {
    for (const id of ["a1", "a2", "a3"]) seed(WS_A, id);
    const res = await get(ALICE, `/v1/workspaces/${WS_A}/notifications?after=1`);
    const body = (await res.json()) as NotificationsListOutput;
    expect(body.notifications.map((n) => n.seq)).toEqual([2, 3]);
  });

  test("`limit` caps the page", async () => {
    for (const id of ["a1", "a2", "a3"]) seed(WS_A, id);
    const res = await get(ALICE, `/v1/workspaces/${WS_A}/notifications?limit=2`);
    const body = (await res.json()) as NotificationsListOutput;
    expect(body.notifications.map((n) => n.seq)).toEqual([1, 2]);
    expect(body.cursor).toBe(2);
  });

  test("an empty inbox returns no cursor", async () => {
    const res = await get(ALICE, `/v1/workspaces/${WS_A}/notifications`);
    const body = (await res.json()) as NotificationsListOutput;
    expect(body.notifications).toEqual([]);
    expect(body.cursor).toBeUndefined();
  });
});
