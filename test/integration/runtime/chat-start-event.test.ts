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

  it("emits data.changed on the default sink when a new conversation is created", async () => {
    const workDir = join(testDir, "chat-start-new-conv");
    mkdirSync(workDir, { recursive: true });

    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
      workDir,
    });
    await provisionTestWorkspace(runtime);

    // Capture events on the runtime's default sink — the one api/server.ts
    // wraps to drive the `/v1/events` SSE broadcast (`useDataSync`). A
    // data.changed that only reaches the per-request chat sink never gets
    // there, so conversation-list iframes stay stale (issue #155).
    const sseEvents: EngineEvent[] = [];
    const defaultSink = runtime.getEventSink();
    const origEmit = defaultSink.emit.bind(defaultSink);
    defaultSink.emit = (e) => {
      sseEvents.push(e);
      origEmit(e);
    };

    try {
      // No conversationId provided — triggers new conversation creation.
      await runtime.chat({ message: "Hello", workspaceId: TEST_WORKSPACE_ID });

      const isConvListChange = (e: EngineEvent) =>
        e.type === "data.changed" &&
        e.data.server === "conversations" &&
        e.data.tool === "list";

      // Two broadcasts per new conversation: one in the post-turn `finally`
      // (surfaces it immediately, labelled with the message preview) and
      // one after fire-and-forget title generation settles (updates the
      // label to the generated title).
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && sseEvents.filter(isConvListChange).length < 2) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      // Let any further (regression) broadcasts land before asserting the count.
      await new Promise((resolve) => setTimeout(resolve, 400));

      // >=2 not ===2: the assertion guards against the conversation-list
      // signal regressing to nothing, but stays robust to unrelated
      // data.changed emits (e.g. non-nb tool calls fanning out via
      // api/server.ts) that may legitimately arrive during a real turn.
      expect(sseEvents.filter(isConvListChange).length).toBeGreaterThanOrEqual(2);
    } finally {
      defaultSink.emit = origEmit;
      await runtime.shutdown();
    }
  });

  it("does NOT emit data.changed on the default sink when resuming an existing conversation", async () => {
    const workDir = join(testDir, "chat-start-resume");
    mkdirSync(workDir, { recursive: true });

    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
      workDir,
    });
    await provisionTestWorkspace(runtime);

    // Wrap before the first chat so the title-gen broadcast is observable.
    // A fixed pre-second-chat sleep would race the first turn's async title
    // generation under CI load — poll for both first-turn broadcasts instead.
    const sseEvents: EngineEvent[] = [];
    const defaultSink = runtime.getEventSink();
    const origEmit = defaultSink.emit.bind(defaultSink);
    defaultSink.emit = (e) => {
      sseEvents.push(e);
      origEmit(e);
    };

    try {
      const isConvListChange = (e: EngineEvent) =>
        e.type === "data.changed" &&
        e.data.server === "conversations" &&
        e.data.tool === "list";

      // First chat — creates a new conversation; emits twice (post-turn + post-title).
      const first = await runtime.chat({
        message: "First message",
        workspaceId: TEST_WORKSPACE_ID,
      });

      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && sseEvents.filter(isConvListChange).length < 2) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const countAfterFirst = sseEvents.filter(isConvListChange).length;
      expect(countAfterFirst).toBeGreaterThanOrEqual(2);

      // Second chat — resume existing conversation. Not new, title set →
      // neither the post-turn nor the title-gen path should fire.
      await runtime.chat({
        message: "Second message",
        conversationId: first.conversationId,
        workspaceId: TEST_WORKSPACE_ID,
      });

      // Allow any straggler broadcast to land before asserting unchanged.
      await new Promise((resolve) => setTimeout(resolve, 400));

      expect(sseEvents.filter(isConvListChange).length).toBe(countAfterFirst);
    } finally {
      defaultSink.emit = origEmit;
      await runtime.shutdown();
    }
  });
});
