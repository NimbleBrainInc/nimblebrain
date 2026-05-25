import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventSourcedConversationStore } from "../../src/conversation/event-sourced-store.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import type { BufferedRunEvent, RunStatus } from "../../src/runtime/run-bus.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
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

/** Attach to a turn and resolve with all events once it ends. */
function awaitTurn(conversationId: string): Promise<{ events: BufferedRunEvent[]; status: RunStatus }> {
  return new Promise((resolve) => {
    const events: BufferedRunEvent[] = [];
    runtime.attachTurn(
      conversationId,
      0,
      (e) => events.push(e),
      (status) => resolve({ events, status }),
    );
  });
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

    const store = runtime.findConversationStore();
    expect(store).toBeInstanceOf(EventSourcedConversationStore);
    const events = await (store as EventSourcedConversationStore).readEvents(conversationId);
    expect(events.length).toBeGreaterThan(0);
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
});
