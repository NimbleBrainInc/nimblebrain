import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventSourcedConversationStore } from "../../src/conversation/event-sourced-store.ts";
import { workspaceConversationsDir } from "../../src/conversation/paths.ts";
import { ConversationNotFoundError, RunInProgressError } from "../../src/runtime/errors.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import type { BufferedRunEvent, RunStatus } from "../../src/runtime/run-bus.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { createMockModel } from "../helpers/mock-model.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";

let runtime: Runtime;
const testDir = join(tmpdir(), `nimblebrain-detached-${Date.now()}`);

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  runtime = await Runtime.start({
    identityProvider: devProvider,
    model: { provider: "custom", adapter: createEchoModel() },
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
      identity: DEV_IDENTITY,
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

  it("announces the owner's conversations once the run has ended", async () => {
    // A conversations list reads `active` from the RunBus on each fetch, so the
    // view must hear about the run ending after the RunBus has moved — the
    // turn's last store write happens while the run is still active.
    const ownerId = "usr_default";
    const created = await runtime
      .workspaceConversationStore(TEST_WORKSPACE_ID, ownerId)
      .create({ ownerId, workspaceId: TEST_WORKSPACE_ID });
    const activeAtAnnounce: boolean[] = [];
    const original = runtime.announceIdentitySourceChange.bind(runtime);
    const spy = spyOn(runtime, "announceIdentitySourceChange").mockImplementation(
      (name: string, userId: string) => {
        if (name === "conversations" && userId === ownerId) {
          activeAtAnnounce.push(runtime.isTurnActive(created.id));
        }
        original(name, userId);
      },
    );
    try {
      await runtime.startTurn({
        identity: DEV_IDENTITY,
        message: "Announce my end",
        conversationId: created.id,
        workspaceId: TEST_WORKSPACE_ID,
      });
      await waitFor(() => !runtime.isTurnActive(created.id));
      await waitFor(() => activeAtAnnounce.at(-1) === false);

      expect(activeAtAnnounce).toContain(true);
      expect(activeAtAnnounce.at(-1)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("persists the turn server-side with no viewer attached", async () => {
    const { conversationId } = await runtime.startTurn({
      identity: DEV_IDENTITY,
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

  it("refuses an unknown provided id without creating it or reserving a run", async () => {
    // A provided id is only ever resumed. One that is not in the workspace is
    // `ConversationNotFoundError`, before `begin`, and nothing is written.
    const createSpy = spyOn(EventSourcedConversationStore.prototype, "create");
    try {
      const id = "conv_face0000face0001"; // conv_ + 16 hex, not on disk
      await expect(
        runtime.startTurn({ identity: DEV_IDENTITY, message: "a", conversationId: id, workspaceId: TEST_WORKSPACE_ID }),
      ).rejects.toBeInstanceOf(ConversationNotFoundError);
      expect(createSpy.mock.calls.filter((c) => (c[0] as { id?: string })?.id === id)).toHaveLength(0);
      expect(runtime.isTurnActive(id)).toBe(false);
      expect(await runtime.findConversation(id)).toBeNull();
    } finally {
      createSpy.mockRestore();
    }
  });

  it("serializes concurrent starts on the same existing conversation", async () => {
    const { conversationId: id } = await runtime.startTurn({
      identity: DEV_IDENTITY,
      message: "seed",
      workspaceId: TEST_WORKSPACE_ID,
    });
    await awaitTurn(id);

    const results = await Promise.allSettled([
      runtime.startTurn({ identity: DEV_IDENTITY, message: "a", conversationId: id, workspaceId: TEST_WORKSPACE_ID }),
      runtime.startTurn({ identity: DEV_IDENTITY, message: "b", conversationId: id, workspaceId: TEST_WORKSPACE_ID }),
    ]);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected.length).toBe(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(RunInProgressError);
    await awaitTurn(id);
  });

  it("refuses another user's conversation BEFORE reserving the run", async () => {
    // Seed a conversation owned by a different user. startTurn must refuse it
    // BEFORE runBus.begin() flips the run active — otherwise an unauthorized
    // caller could mutate another user's run state.
    const convId = "conv_d00dd00dd00dd00d";
    // Seed the foreign conversation in a workspace of its owner's
    // (`workspaces/<wsId>/conversations/<ownerId>/`).
    const foreignOwner = "usr_someone_else";
    const convDir = workspaceConversationsDir(testDir, "ws_someone_elses", foreignOwner);
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
      runtime.startTurn({ identity: DEV_IDENTITY, message: "hijack", conversationId: convId, workspaceId: TEST_WORKSPACE_ID }),
    ).rejects.toBeInstanceOf(ConversationNotFoundError);
    // The run was never reserved.
    expect(runtime.isTurnActive(convId)).toBe(false);
  });

  it("allows a new turn on the same conversation once idle", async () => {
    const { conversationId } = await runtime.startTurn({
      identity: DEV_IDENTITY,
      message: "first",
      workspaceId: TEST_WORKSPACE_ID,
    });
    await awaitTurn(conversationId);

    const again = await runtime.startTurn({
      identity: DEV_IDENTITY,
      message: "second",
      conversationId,
      workspaceId: TEST_WORKSPACE_ID,
    });
    expect(again.conversationId).toBe(conversationId);
    await awaitTurn(conversationId);
  });

  it("refuses a turn that names no workspace", async () => {
    // Parity with the sync `chat()` path: the runtime never picks a workspace,
    // under any identity provider. (REST always names the workspace in its
    // path, so this is reachable only from in-process callers.)
    await expect(
      runtime.startTurn({ identity: DEV_IDENTITY, message: "no workspace here" }),
    ).rejects.toThrow("request names no workspace");

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
      identityProvider: devProvider,
      model: {
        provider: "custom",
        adapter: createMockModel(async () => {
          await gate;
          return { content: [{ type: "text", text: "unreached" }] };
        }),
      },
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
      identity: DEV_IDENTITY,
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
      identityProvider: devProvider,
      model: {
        provider: "custom",
        adapter: createMockModel(async (options) => {
          capturedSignal = options.abortSignal;
          await gate;
          return { content: [{ type: "text", text: "unreached" }] };
        }),
      },
      logging: { disabled: true },
      workDir: dir,
    });
    await provisionTestWorkspace(rt);

    try {
      const { conversationId } = await rt.startTurn({
        identity: DEV_IDENTITY,
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
