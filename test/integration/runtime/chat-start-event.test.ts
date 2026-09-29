import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineEvent, EventSink } from "../../../src/engine/types.ts";
import { DEV_IDENTITY } from "../../../src/identity/providers/dev.ts";
import { Runtime } from "../../../src/runtime/runtime.ts";
import { devProvider } from "../../helpers/dev-provider.ts";
import { createEchoModel } from "../../helpers/echo-model.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../../helpers/test-workspace.ts";

const testDir = join(tmpdir(), `nimblebrain-chat-start-${Date.now()}`);

afterAll(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

describe("chat.start event", () => {
  it("emits chat.start with conversationId when requestSink is provided", async () => {
    const workDir = join(testDir, "chat-start-basic");
    mkdirSync(workDir, { recursive: true });

    const runtime = await Runtime.start({
      identityProvider: devProvider,
      model: { provider: "custom", adapter: createEchoModel() },
      workDir,
    });
    await provisionTestWorkspace(runtime);

    const events: EngineEvent[] = [];
    const sink: EventSink = { emit: (e) => events.push(e) };

    const result = await runtime.chat(
      { identity: DEV_IDENTITY, message: "Hello", workspaceId: TEST_WORKSPACE_ID },
      sink,
    );

    const chatStartEvents = events.filter((e) => e.type === "chat.start");
    expect(chatStartEvents).toHaveLength(1);
    expect(chatStartEvents[0]!.data.conversationId).toBe(result.conversationId);

    await runtime.shutdown();
  });

  it("emits chat.start with the existing id when resuming a conversation", async () => {
    const workDir = join(testDir, "chat-start-resume");
    mkdirSync(workDir, { recursive: true });

    const runtime = await Runtime.start({
      identityProvider: devProvider,
      model: { provider: "custom", adapter: createEchoModel() },
      workDir,
    });
    await provisionTestWorkspace(runtime);

    // First chat — creates a new conversation
    const first = await runtime.chat({
      identity: DEV_IDENTITY,
      message: "First message",
      workspaceId: TEST_WORKSPACE_ID,
    });

    // Second chat — resume existing conversation, capture events
    const events: EngineEvent[] = [];
    const sink: EventSink = { emit: (e) => events.push(e) };

    await runtime.chat(
      {
        identity: DEV_IDENTITY,
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

    await runtime.shutdown();
  });
});
