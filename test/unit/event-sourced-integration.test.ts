import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveUsageMetrics } from "../../src/conversation/event-reconstructor.ts";
import { EventSourcedConversationStore } from "../../src/conversation/event-sourced-store.ts";
import type { ConversationEvent } from "../../src/conversation/types.ts";
import { engineEvent, llmDonePayload, runStartPayload } from "../helpers/engine-events.ts";

function makeDirs() {
  const base = mkdtempSync(join(tmpdir(), "es-integ-test-"));
  return { dir: join(base, "conversations") };
}

describe("Event-sourced integration", () => {
  it("full chat cycle: user message → engine events → history reconstruction", async () => {
    const dirs = makeDirs();
    const store = new EventSourcedConversationStore({ ...dirs });

    // Create conversation
    const conv = await store.create({ ownerId: "user_test" });
    expect(conv.format).toBe("events");

    // Append user message
    store.appendEvent(conv.id, {
      ts: "2026-04-11T00:00:00Z",
      type: "user.message",
      content: [{ type: "text", text: "Hello" }],
    } as ConversationEvent);

    // Simulate engine events via emit()
    store.setActiveConversation(conv.id);
    store.emit(
      engineEvent(
        "run.start",
        runStartPayload({ runId: "r1", model: "claude-sonnet-4-5-20250929" }),
      ),
    );
    store.emit(
      engineEvent(
        "llm.done",
        llmDonePayload({
          runId: "r1",
          model: "claude-sonnet-4-5-20250929",
          content: [{ type: "text", text: "Hi there!" }],
          usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 0 },
          llmMs: 200,
        }),
      ),
    );
    store.emit(
      engineEvent("run.done", { runId: "r1", stopReason: "complete", iterations: 1, totalMs: 250 }),
    );

    // Wait for async metadata cache update
    await new Promise((r) => setTimeout(r, 100));

    // Verify file contains events
    const lines = readFileSync(join(dirs.dir, `${conv.id}.jsonl`), "utf-8")
      .trim()
      .split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(5); // meta + user.message + run.start + llm.response + run.done

    const events = lines.slice(1).map((l) => JSON.parse(l));
    expect(events[0].type).toBe("user.message");
    expect(events[1].type).toBe("run.start");
    expect(events[2].type).toBe("llm.response");
    expect(events[3].type).toBe("run.done");

    // Verify history reconstruction
    const messages = await store.history(conv);
    expect(messages.length).toBe(2);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
    expect((messages[1].content as Array<{ type: string; text: string }>)[0].text).toBe(
      "Hi there!",
    );
    expect(messages[1].metadata?.usage?.inputTokens).toBe(100);
    expect(messages[1].metadata?.usage?.outputTokens).toBe(20);
    expect(messages[1].metadata?.model).toBe("claude-sonnet-4-5-20250929");
  });

  it("debug vs normal logging: verbose fields persisted only in debug mode", async () => {
    const normalDirs = makeDirs();
    const debugDirs = makeDirs();

    const normalStore = new EventSourcedConversationStore({ ...normalDirs, logLevel: "normal" });
    const debugStore = new EventSourcedConversationStore({ ...debugDirs, logLevel: "debug" });

    const normalConv = await normalStore.create({ ownerId: "user_test" });
    const debugConv = await debugStore.create({ ownerId: "user_test" });

    const runStart = engineEvent(
      "run.start",
      runStartPayload({
        runId: "r1",
        model: "test-model",
        systemPrompt: "You are a helpful assistant.",
        toolNames: ["bash", "read_file"],
      }),
    );

    normalStore.setActiveConversation(normalConv.id);
    normalStore.emit(runStart);

    debugStore.setActiveConversation(debugConv.id);
    debugStore.emit(runStart);

    const normalLines = readFileSync(join(normalDirs.dir, `${normalConv.id}.jsonl`), "utf-8")
      .trim()
      .split("\n");
    const debugLines = readFileSync(join(debugDirs.dir, `${debugConv.id}.jsonl`), "utf-8")
      .trim()
      .split("\n");

    const normalEvent = JSON.parse(normalLines[1]);
    const debugEvent = JSON.parse(debugLines[1]);

    // Normal mode: no verbose fields
    expect(normalEvent.type).toBe("run.start");
    expect(normalEvent.model).toBe("test-model");
    expect(normalEvent.systemPrompt).toBeUndefined();
    expect(normalEvent.toolSchemas).toBeUndefined();

    // Debug mode: verbose fields present
    expect(debugEvent.type).toBe("run.start");
    expect(debugEvent.model).toBe("test-model");
    expect(debugEvent.systemPrompt).toBe("You are a helpful assistant.");
    expect(debugEvent.toolSchemas).toEqual(["bash", "read_file"]);
  });

  it("usage metrics derived correctly from llm.response events", () => {
    const events: ConversationEvent[] = [
      {
        ts: "2026-04-11T00:00:00Z",
        type: "user.message",
        content: [{ type: "text", text: "Hi" }],
      } as ConversationEvent,
      {
        ts: "2026-04-11T00:00:01Z",
        type: "run.start",
        runId: "r1",
        model: "claude-sonnet-4-5-20250929",
      } as ConversationEvent,
      {
        ts: "2026-04-11T00:00:02Z",
        type: "llm.response",
        runId: "r1",
        model: "claude-sonnet-4-5-20250929",
        content: [{ type: "text", text: "Hello!" }],
        usage: { inputTokens: 200, outputTokens: 50, cacheReadTokens: 100, cacheWriteTokens: 0 },
        llmMs: 150,
      } as ConversationEvent,
      {
        ts: "2026-04-11T00:00:03Z",
        type: "llm.response",
        runId: "r1",
        model: "claude-sonnet-4-5-20250929",
        content: [{ type: "text", text: "More text" }],
        usage: { inputTokens: 300, outputTokens: 80, cacheReadTokens: 200, cacheWriteTokens: 0 },
        llmMs: 200,
      } as ConversationEvent,
      {
        ts: "2026-04-11T00:00:04Z",
        type: "run.done",
        runId: "r1",
        stopReason: "complete",
        totalMs: 400,
      } as ConversationEvent,
    ];

    const metrics = deriveUsageMetrics(events);
    expect(metrics.totalInputTokens).toBe(500); // 200 + 300
    expect(metrics.totalOutputTokens).toBe(130); // 50 + 80
    expect(metrics.lastModel).toBe("claude-sonnet-4-5-20250929");
    expect(metrics.totalCostUsd).toBeGreaterThan(0); // computed from catalog
  });
});
