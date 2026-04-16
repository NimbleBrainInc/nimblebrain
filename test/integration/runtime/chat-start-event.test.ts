import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineEvent, EventSink } from "../../../src/engine/types.ts";
import { Runtime } from "../../../src/runtime/runtime.ts";
import { createEchoModel } from "../../helpers/echo-model.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../../helpers/test-workspace.ts";

const testDir = join(tmpdir(), `nimblebrain-chat-start-${Date.now()}`);

afterAll(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

describe("chat.start event", () => {
  it("emits chat.start with conversationId when requestSink is provided", async () => {
    const workDir = join(testDir, "chat-start-basic");
    mkdirSync(workDir, { recursive: true });

    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
      workDir,
    });
    await provisionTestWorkspace(runtime);

    const events: EngineEvent[] = [];
    const sink: EventSink = { emit: (e) => events.push(e) };

    const result = await runtime.chat(
      { message: "Hello", workspaceId: TEST_WORKSPACE_ID },
      sink,
    );

    const chatStartEvents = events.filter((e) => e.type === "chat.start");
    expect(chatStartEvents).toHaveLength(1);
    expect(chatStartEvents[0]!.data.conversationId).toBe(result.conversationId);

    await runtime.shutdown();
  });

  it("emits data.changed when a new conversation is created", async () => {
    const workDir = join(testDir, "chat-start-new-conv");
    mkdirSync(workDir, { recursive: true });

    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
      workDir,
    });
    await provisionTestWorkspace(runtime);

    const events: EngineEvent[] = [];
    const sink: EventSink = { emit: (e) => events.push(e) };

    // No conversationId provided — triggers new conversation creation
    await runtime.chat({ message: "Hello", workspaceId: TEST_WORKSPACE_ID }, sink);

    const dataChangedEvents = events.filter((e) => e.type === "data.changed");
    expect(dataChangedEvents.length).toBeGreaterThanOrEqual(1);

    const convListChange = dataChangedEvents.find(
      (e) => e.data.server === "conversations" && e.data.tool === "list",
    );
    expect(convListChange).toBeDefined();

    await runtime.shutdown();
  });

  it("does NOT emit data.changed when resuming an existing conversation", async () => {
    const workDir = join(testDir, "chat-start-resume");
    mkdirSync(workDir, { recursive: true });

    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
      workDir,
    });
    await provisionTestWorkspace(runtime);

    // First chat — creates a new conversation
    const first = await runtime.chat({
      message: "First message",
      workspaceId: TEST_WORKSPACE_ID,
    });

    // Second chat — resume existing conversation, capture events
    const events: EngineEvent[] = [];
    const sink: EventSink = { emit: (e) => events.push(e) };

    await runtime.chat(
      {
        message: "Second message",
        conversationId: first.conversationId,
        workspaceId: TEST_WORKSPACE_ID,
      },
      sink,
    );

    // chat.start should still be emitted
    const chatStartEvents = events.filter((e) => e.type === "chat.start");
    expect(chatStartEvents).toHaveLength(1);
    expect(chatStartEvents[0]!.data.conversationId).toBe(first.conversationId);

    // data.changed with server=conversations should NOT be emitted
    const convListChange = events.filter(
      (e) =>
        e.type === "data.changed" &&
        e.data.server === "conversations" &&
        e.data.tool === "list",
    );
    expect(convListChange).toHaveLength(0);

    await runtime.shutdown();
  });
});
