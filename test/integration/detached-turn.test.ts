import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventSourcedConversationStore } from "../../src/conversation/event-sourced-store.ts";
import { roomConversationsDir } from "../../src/conversation/paths.ts";
import type { ConversationAccessContext } from "../../src/conversation/types.ts";
import {
  ConversationAccessDeniedError,
  RunInProgressError,
} from "../../src/runtime/errors.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import type { BufferedRunEvent, RunStatus } from "../../src/runtime/run-bus.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { createMockModel } from "../helpers/mock-model.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";

let runtime: Runtime;
const testDir = join(tmpdir(), `nimblebrain-detached-${Date.now()}`);

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  runtime = await Runtime.start({
    model: { provider: "custom", adapter: createEchoModel() },
    noDefaultBundles: true,
    logging: { disabled: true },
    workDir: testDir,
  });
  await provisionTestWorkspace(runtime);
});

afterAll(async () => {
  await runtime.shutdown();
  rmSync(testDir, { recursive: true, force: true });
});

/** Wait for a turn to finish, then snapshot its full buffered event log. The
 *  terminal frame (done/error/cancelled) is the last published event, so the
 *  status is read off it — same view a late SSE viewer reconstructs from the
 *  grace buffer. */
async function awaitTurn(
  conversationId: string,
): Promise<{ events: BufferedRunEvent[]; status: RunStatus }> {
  await waitFor(() => !runtime.isTurnActive(conversationId));
  const events = runtime.getTurnReplay(conversationId, 0);
  const last = events[events.length - 1];
  const status: RunStatus =
    last?.type === "done" ? "done" : last?.type === "cancelled" ? "cancelled" : "error";
  return { events, status };
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("detached turns (server-authoritative streaming)", () => {
  it("returns a conversation id immediately and runs to completion in the background", async () => {
    const { conversationId } = await runtime.startTurn({
      message: "Hello detached",
      workspaceId: TEST_WORKSPACE_ID,
    });
    expect(conversationId).toMatch(/^conv_/);

    const { events, status } = await awaitTurn(conversationId);
    expect(status).toBe("done");
    expect(events.some((e) => e.type === "chat.start")).toBe(true);
    expect(events.length).toBeGreaterThan(0);
    // Sequence numbers are monotonic 1..n.
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
  });

  it("persists the turn server-side with no viewer attached", async () => {
    const { conversationId } = await runtime.startTurn({
      message: "Persist me",
      workspaceId: TEST_WORKSPACE_ID,
    });
    // Never attach — wait for the run to end purely via server state.
    await waitFor(() => !runtime.isTurnActive(conversationId));

    const conv = await runtime.findConversation(conversationId, { userId: "usr_default" });
    expect(conv).not.toBeNull();

    const store = await runtime.resolveConversationStore(conversationId);
    expect(store).toBeInstanceOf(EventSourcedConversationStore);
    const events = await store!.readEvents(conversationId);
    expect(events.length).toBeGreaterThan(0);
  });

  it("does not double-create on concurrent starts with the same provided id", async () => {
    // Force both starts into the load→create window by delaying load. With the
    // race fix (begin before storage), the loser's begin throws before it can
    // create — so create runs exactly once. Without it, both create and the
    // loser's truncating writeFile would clobber the winner's file.
    const proto = EventSourcedConversationStore.prototype;
    const realLoad = proto.load;
    const loadSpy = spyOn(proto, "load").mockImplementation(async function (
      this: EventSourcedConversationStore,
      id: string,
      access?: ConversationAccessContext,
    ) {
      await new Promise((r) => setTimeout(r, 25));
      return realLoad.call(this, id, access);
    });
    const createSpy = spyOn(proto, "create");
    try {
      const id = "conv_face0000face0001"; // conv_ + 16 hex, not yet on disk
      const results = await Promise.allSettled([
        runtime.startTurn({ message: "a", conversationId: id, workspaceId: TEST_WORKSPACE_ID }),
        runtime.startTurn({ message: "b", conversationId: id, workspaceId: TEST_WORKSPACE_ID }),
      ]);

      const createsForId = createSpy.mock.calls.filter(
        (c) => (c[0] as { id?: string })?.id === id,
      );
      expect(createsForId.length).toBe(1);

      const rejected = results.filter((r) => r.status === "rejected");
      expect(rejected.length).toBe(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(RunInProgressError);
    } finally {
      loadSpy.mockRestore();
      createSpy.mockRestore();
    }
  });

  it("authorizes a provided conversationId BEFORE reserving the run", async () => {
    // Seed a conversation owned by a different user. startTurn must reject on
    // ownership BEFORE runBus.begin() flips the run active — otherwise an
    // unauthorized caller could mutate another user's run state.
    const convId = "conv_d00dd00dd00dd00d";
    // Seed the foreign conversation in its owner's room
    // (`workspaces/ws_user_<id>/conversations/<ownerId>/`) so the locator
    // resolves it and startTurn's ownership check fires.
    const foreignOwner = "usr_someone_else";
    const convDir = roomConversationsDir(testDir, `ws_user_${foreignOwner}`, foreignOwner);
    mkdirSync(convDir, { recursive: true });
    writeFileSync(
      join(convDir, `${convId}.jsonl`),
      `${JSON.stringify({
        id: convId,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
        title: null,
        format: "events",
        ownerId: foreignOwner,
      })}\n`,
    );

    await expect(
      runtime.startTurn({ message: "hijack", conversationId: convId, workspaceId: TEST_WORKSPACE_ID }),
    ).rejects.toBeInstanceOf(ConversationAccessDeniedError);
    // The run was never reserved.
    expect(runtime.isTurnActive(convId)).toBe(false);
  });

  it("allows a new turn on the same conversation once idle", async () => {
    const { conversationId } = await runtime.startTurn({
      message: "first",
      workspaceId: TEST_WORKSPACE_ID,
    });
    await awaitTurn(conversationId);

    const again = await runtime.startTurn({
      message: "second",
      conversationId,
      workspaceId: TEST_WORKSPACE_ID,
    });
    expect(again.conversationId).toBe(conversationId);
    await awaitTurn(conversationId);
  });

  it("starts an identity-level turn with no workspaceId (personal-workspace fallback)", async () => {
    // Parity with the sync `chat()` path and `/v1/chat`: a chat-start with no
    // focused workspace (home / identity route) is identity-level, not an
    // error. startTurn must fall back to the caller's personal workspace
    // instead of throwing (which surfaced as a raw 500 via handleChatStart).
    const { conversationId } = await runtime.startTurn({ message: "no workspace here" });
    expect(conversationId).toMatch(/^conv_/);

    const { status } = await awaitTurn(conversationId);
    expect(status).toBe("done");

    // Conversation persisted with the personal-workspace breadcrumb.
    const conv = await runtime.findConversation(conversationId, { userId: "usr_default" });
    expect(conv).not.toBeNull();
    expect(conv?.workspaceId).toBe("ws_user_usr_default");
  });
});

describe("cancel delivers a terminal frame to live viewers (Stop button)", () => {
  let rt: Runtime;
  const dir = join(tmpdir(), `nimblebrain-cancel-${Date.now()}`);
  // Gate the model so the turn stays active until we cancel it mid-run.
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });

  beforeAll(async () => {
    mkdirSync(dir, { recursive: true });
    rt = await Runtime.start({
      model: {
        provider: "custom",
        adapter: createMockModel(async () => {
          await gate;
          return { content: [{ type: "text", text: "unreached" }] };
        }),
      },
      noDefaultBundles: true,
      logging: { disabled: true },
      workDir: dir,
    });
    await provisionTestWorkspace(rt);
  });

  afterAll(async () => {
    release(); // let the gated engine task unwind before shutdown
    await rt.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it("publishes `cancelled` on the live onTurnEvent path (not just RunBus onEnd)", async () => {
    // Capture the SSE feed path: server.ts wires runtime.onTurnEvent →
    // ConversationEventManager. This is the channel the bug bypassed.
    const captured: BufferedRunEvent[] = [];
    rt.onTurnEvent = (_cid, e) => captured.push(e);

    const { conversationId } = await rt.startTurn({
      message: "hang",
      workspaceId: TEST_WORKSPACE_ID,
    });
    await waitFor(() => rt.isTurnActive(conversationId));

    const ok = rt.cancelTurn(conversationId);
    expect(ok).toBe(true);
    // The terminal frame must reach live viewers — RunBus.cancel ends the run
    // synchronously, so publishing after it (engine's catch) would no-op.
    expect(captured.some((e) => e.type === "cancelled")).toBe(true);
    expect(rt.isTurnActive(conversationId)).toBe(false);
  });
});

describe("shutdown aborts in-flight detached turns (RunBus teardown)", () => {
  it("aborts active turn signals before tearing down workspace sources", async () => {
    const dir = join(tmpdir(), `nimblebrain-shutdown-runbus-${Date.now()}`);
    mkdirSync(dir, { recursive: true });

    // Gate the model so the turn is genuinely mid-flight when shutdown runs.
    // Capture the run's abort signal so we can prove shutdown aborted it.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let capturedSignal: AbortSignal | undefined;

    const rt = await Runtime.start({
      model: {
        provider: "custom",
        adapter: createMockModel(async (options) => {
          capturedSignal = options.abortSignal;
          await gate;
          return { content: [{ type: "text", text: "unreached" }] };
        }),
      },
      noDefaultBundles: true,
      logging: { disabled: true },
      workDir: dir,
    });
    await provisionTestWorkspace(rt);

    try {
      const { conversationId } = await rt.startTurn({
        message: "hang until shutdown",
        workspaceId: TEST_WORKSPACE_ID,
      });
      // Wait until the engine has actually entered the model call (signal
      // captured) — `isTurnActive` flips true on `runBus.begin()`, before
      // `doStream`, so it alone would race the capture.
      await waitFor(() => capturedSignal !== undefined);
      expect(rt.isTurnActive(conversationId)).toBe(true);
      expect(capturedSignal?.aborted).toBe(false);

      // Shutdown must abort the in-flight turn (RunBus.reset) so it stops
      // issuing tool calls BEFORE its workspace sources are removed.
      await rt.shutdown();

      expect(capturedSignal?.aborted).toBe(true);
      expect(rt.isTurnActive(conversationId)).toBe(false);
    } finally {
      release(); // let the parked engine task unwind
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
