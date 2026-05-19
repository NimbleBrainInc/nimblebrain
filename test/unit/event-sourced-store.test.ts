import { describe, expect, it, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventSourcedConversationStore } from "../../src/conversation/event-sourced-store.ts";
import type { EngineEvent } from "../../src/engine/types.ts";
import type { ConversationEvent, StoredMessage } from "../../src/conversation/types.ts";

function makeDir() {
  const base = mkdtempSync(join(tmpdir(), "es-store-test-"));
  return join(base, "conversations");
}

function readLines(path: string): string[] {
  return readFileSync(path, "utf-8").trim().split("\n");
}

describe("EventSourcedConversationStore", () => {
  let dirs: { dir: string };
  let store: EventSourcedConversationStore;

  beforeEach(() => {
    const dir = makeDir();
    dirs = { dir };
    store = new EventSourcedConversationStore({ dir });
  });

  it("creates conversations with format: events", async () => {
    const conv = await store.create({ ownerId: "user_test" });
    expect(conv.format).toBe("events");
    expect(conv.id).toMatch(/^conv_/);

    const lines = readLines(join(dirs.dir, `${conv.id}.jsonl`));
    const meta = JSON.parse(lines[0]);
    expect(meta.format).toBe("events");
    // Token totals are no longer stored on Conversation; they're derived
    // from events at read time.
    expect(meta.totalInputTokens).toBeUndefined();
  });

  it("emit() writes engine events to conversation file", async () => {
    const conv = await store.create({ ownerId: "user_test" });
    store.setActiveConversation(conv.id);

    store.emit({
      type: "run.start",
      data: { runId: "r1", model: "test-model", maxIterations: 10, toolCount: 0 },
    });
    store.emit({
      type: "llm.done",
      data: {
        runId: "r1",
        model: "test-model",
        content: [{ type: "text", text: "Hello" }],
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
        llmMs: 50,
      },
    });
    store.emit({
      type: "run.done",
      data: { runId: "r1", stopReason: "complete", totalMs: 100 },
    });

    // Wait for async metadata cache update (llm.response triggers rewrite)
    await new Promise((r) => setTimeout(r, 100));

    const lines = readLines(join(dirs.dir, `${conv.id}.jsonl`));
    // Line 0: metadata, lines 1+: events (at least run.start + llm.response + run.done)
    const events = lines.slice(1).map((l) => JSON.parse(l));
    expect(events.length).toBe(3);

    expect(events[0].type).toBe("run.start");
    expect(events[1].type).toBe("llm.response");
    expect(events[1].content).toEqual([{ type: "text", text: "Hello" }]);
    expect(events[2].type).toBe("run.done");
  });

  it("history() reconstructs messages from events", async () => {
    const conv = await store.create({ ownerId: "user_test" });

    // Write user message event
    store.appendEvent(conv.id, {
      ts: new Date().toISOString(),
      type: "user.message",
      content: [{ type: "text", text: "Hi" }],
    } as ConversationEvent);

    // Write run events
    store.appendEvent(conv.id, {
      ts: new Date().toISOString(),
      type: "run.start",
      runId: "r1",
      model: "test-model",
    } as ConversationEvent);

    store.appendEvent(conv.id, {
      ts: new Date().toISOString(),
      type: "llm.response",
      runId: "r1",
      model: "test-model",
      content: [{ type: "text", text: "Hello!" }],
      usage: { inputTokens: 50, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
      llmMs: 30,
    } as ConversationEvent);

    store.appendEvent(conv.id, {
      ts: new Date().toISOString(),
      type: "run.done",
      runId: "r1",
      stopReason: "complete",
      totalMs: 50,
    } as ConversationEvent);

    const messages = await store.history(conv);
    expect(messages.length).toBe(2); // user + assistant
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
  });

  it("history() reads legacy format files", async () => {
    // Create a legacy-format file manually
    const id = "conv_1e9ac4e5000000a2";
    const meta = {
      id,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      title: "Legacy",
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUsd: 0,
      lastModel: null,
      ownerId: "user_test",
    };
    const userMsg: StoredMessage = {
      role: "user",
      content: [{ type: "text", text: "old message" }],
      timestamp: "2026-01-01T00:00:00Z",
    };
    const assistantMsg: StoredMessage = {
      role: "assistant",
      content: [{ type: "text", text: "old response" }],
      timestamp: "2026-01-01T00:00:01Z",
    };

    const path = join(dirs.dir, `${id}.jsonl`);
    writeFileSync(path, [JSON.stringify(meta), JSON.stringify(userMsg), JSON.stringify(assistantMsg)].map((l) => `${l}\n`).join(""));

    const conv = await store.load(id);
    expect(conv).not.toBeNull();

    const messages = await store.history(conv!);
    expect(messages.length).toBe(2);
    expect(messages[0].role).toBe("user");
    expect((messages[0].content as Array<{ type: string; text: string }>)[0].text).toBe("old message");
    expect(messages[1].role).toBe("assistant");
  });

  it("skips non-conversation events", async () => {
    const conv = await store.create({ ownerId: "user_test" });
    store.setActiveConversation(conv.id);

    store.emit({ type: "text.delta", data: { runId: "r1", text: "hi" } });
    store.emit({ type: "bundle.installed", data: { serverName: "test" } });
    store.emit({ type: "data.changed", data: {} });

    const lines = readLines(join(dirs.dir, `${conv.id}.jsonl`));
    // Only line 0 (metadata), no event lines
    expect(lines.length).toBe(1);
  });

  it("debug logging includes verbose fields", async () => {
    const debugStore = new EventSourcedConversationStore({
      ...dirs,
      logLevel: "debug",
    });
    const conv = await debugStore.create({ ownerId: "user_test" });
    debugStore.setActiveConversation(conv.id);

    debugStore.emit({
      type: "run.start",
      data: {
        runId: "r1",
        model: "test-model",
        systemPrompt: "You are a helpful assistant",
        toolNames: ["bash", "read"],
      },
    });
    debugStore.emit({
      type: "tool.start",
      data: { runId: "r1", name: "bash", id: "t1", input: { command: "ls" } },
    });
    debugStore.emit({
      type: "tool.done",
      data: { runId: "r1", name: "bash", id: "t1", ok: true, ms: 50, output: "file1.txt" },
    });

    const lines = readLines(join(dirs.dir, `${conv.id}.jsonl`));
    const events = lines.slice(1).map((l) => JSON.parse(l));

    expect(events[0].systemPrompt).toBe("You are a helpful assistant");
    expect(events[0].toolSchemas).toEqual(["bash", "read"]);
    expect(events[1].input).toEqual({ command: "ls" });
    expect(events[2].output).toBe("file1.txt");
  });

  it("normal logging strips verbose fields but keeps tool output", async () => {
    const conv = await store.create({ ownerId: "user_test" });
    store.setActiveConversation(conv.id);

    store.emit({
      type: "run.start",
      data: {
        runId: "r1",
        model: "test-model",
        systemPrompt: "secret prompt",
        toolNames: ["bash"],
      },
    });
    store.emit({
      type: "tool.start",
      data: { runId: "r1", name: "bash", id: "t1", input: { command: "ls" } },
    });
    store.emit({
      type: "tool.done",
      data: { runId: "r1", name: "bash", id: "t1", ok: true, ms: 50, output: "file1.txt" },
    });

    const lines = readLines(join(dirs.dir, `${conv.id}.jsonl`));
    const events = lines.slice(1).map((l) => JSON.parse(l));

    // Debug-only fields are stripped in normal mode
    expect(events[0].systemPrompt).toBeUndefined();
    expect(events[0].toolSchemas).toBeUndefined();
    expect(events[1].input).toBeUndefined();
    // Tool output is always persisted (needed for conversation reconstruction)
    expect(events[2].output).toBe("file1.txt");
  });

  it("tool output survives the full round-trip: emit → persist → reconstruct → history", async () => {
    const conv = await store.create({ ownerId: "user_test" });
    store.setActiveConversation(conv.id);

    // Simulate a complete run with a tool call that produces output
    store.emit({ type: "run.start", data: { runId: "r1", model: "test-model" } });
    store.emit({
      type: "llm.done",
      data: {
        runId: "r1",
        model: "test-model",
        content: [
          { type: "tool-call", toolCallId: "tc1", toolName: "files__read", input: "{}" },
        ],
        usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
        llmMs: 500,
      },
    });
    store.emit({ type: "tool.start", data: { runId: "r1", name: "files__read", id: "tc1" } });
    store.emit({
      type: "tool.done",
      data: { runId: "r1", name: "files__read", id: "tc1", ok: true, ms: 10, output: "Hello world file content" },
    });
    store.emit({
      type: "llm.done",
      data: {
        runId: "r1",
        model: "test-model",
        content: [{ type: "text", text: "I read the file." }],
        usage: { inputTokens: 200, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0 },
        llmMs: 400,
      },
    });
    store.emit({ type: "run.done", data: { runId: "r1", stopReason: "end_turn", totalMs: 1000 } });

    // Load history — this goes through the reconstructor
    const messages = await store.history(conv);

    // Find the tool result message
    const toolMsg = messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    const toolContent = toolMsg!.content as Array<{ type: string; output?: { value: string } }>;
    expect(toolContent[0]!.output!.value).toBe("Hello world file content");

    // Also verify the assistant metadata has the output
    const assistantMsg = messages.find(
      (m) => m.role === "assistant" && m.metadata?.toolCalls?.length,
    );
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.metadata!.toolCalls![0]!.output).toBe("Hello world file content");
  });

  it("routes events to the correct conversation", async () => {
    const conv1 = await store.create({ ownerId: "user_test" });
    const conv2 = await store.create({ ownerId: "user_test" });

    store.setActiveConversation(conv1.id);
    store.emit({
      type: "run.start",
      data: { runId: "r1", model: "m1" },
    });

    store.setActiveConversation(conv2.id);
    store.emit({
      type: "run.start",
      data: { runId: "r2", model: "m2" },
    });

    const lines1 = readLines(join(dirs.dir, `${conv1.id}.jsonl`));
    const lines2 = readLines(join(dirs.dir, `${conv2.id}.jsonl`));

    expect(lines1.length).toBe(2); // meta + 1 event
    expect(lines2.length).toBe(2);

    expect(JSON.parse(lines1[1]).model).toBe("m1");
    expect(JSON.parse(lines2[1]).model).toBe("m2");
  });

  it("load() and delete() work", async () => {
    const conv = await store.create({ ownerId: "user_test" });
    const loaded = await store.load(conv.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(conv.id);

    const deleted = await store.delete(conv.id);
    expect(deleted).toBe(true);

    const after = await store.load(conv.id);
    expect(after).toBeNull();
  });

  it("update() patches title", async () => {
    const conv = await store.create({ ownerId: "user_test" });
    const updated = await store.update(conv.id, { title: "New Title" });
    expect(updated).not.toBeNull();
    expect(updated!.title).toBe("New Title");

    const reloaded = await store.load(conv.id);
    expect(reloaded!.title).toBe("New Title");
  });

  it("update() appends metadata event instead of rewriting line 1", async () => {
    const conv = await store.create({ ownerId: "user_test" });
    const path = join(dirs.dir, `${conv.id}.jsonl`);

    const linesBefore = readLines(path);
    const line1Before = linesBefore[0]!;

    await store.update(conv.id, { title: "Appended Title" });

    const linesAfter = readLines(path);
    // Line 1 should be unchanged (immutable creation snapshot)
    expect(linesAfter[0]).toBe(line1Before);
    // A metadata.title event should be appended
    const titleEvent = JSON.parse(linesAfter[linesAfter.length - 1]!);
    expect(titleEvent.type).toBe("metadata.title");
    expect(titleEvent.title).toBe("Appended Title");
  });

  it("interleaved appends and title update preserves all events", async () => {
    const conv = await store.create({ ownerId: "user_test" });
    store.setActiveConversation(conv.id);

    // Turn 1
    const runId = "run-1";
    store.emit({ type: "run.start", data: { runId, model: "test" } });
    store.emit({
      type: "llm.done",
      data: {
        runId,
        model: "test",
        content: [{ type: "text", text: "response 1" }],
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
        llmMs: 100,
      },
    });
    store.emit({ type: "run.done", data: { runId, stopReason: "complete", totalMs: 100 } });

    // Title generation fires (simulates fire-and-forget from runtime)
    const updatePromise = store.update(conv.id, { title: "Generated Title" });

    // Turn 2 starts before title generation completes
    const runId2 = "run-2";
    store.emit({ type: "run.start", data: { runId: runId2, model: "test" } });
    store.emit({
      type: "llm.done",
      data: {
        runId: runId2,
        model: "test",
        content: [{ type: "text", text: "response 2" }],
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
        llmMs: 100,
      },
    });
    store.emit({ type: "run.done", data: { runId: runId2, stopReason: "complete", totalMs: 100 } });

    await updatePromise;
    await store.flush();

    const loaded = await store.load(conv.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.title).toBe("Generated Title");

    // Verify at the file level: all event lines are present, line 1 untouched.
    // Token totals are derived from events at read time, not stored on the
    // Conversation, so the invariant is "both llm.response events are
    // there" — see deriveUsageMetrics for the aggregation path.
    const path = join(dirs.dir, `${conv.id}.jsonl`);
    const lines = readLines(path);
    const events = lines.slice(1).map((l) => JSON.parse(l));
    const types = events.map((e: { type: string }) => e.type);
    expect(types.filter((t: string) => t === "run.start").length).toBe(2);
    expect(types.filter((t: string) => t === "llm.response").length).toBe(2);
    expect(types.filter((t: string) => t === "run.done").length).toBe(2);
    expect(types).toContain("metadata.title");
    // And the total tokens (10 + 10) are derivable from those events.
    const llmResponseEvents = events.filter((e: { type: string }) => e.type === "llm.response");
    const totalIn = llmResponseEvents.reduce(
      (s: number, e: { usage?: { inputTokens: number } }) => s + (e.usage?.inputTokens ?? 0),
      0,
    );
    expect(totalIn).toBe(20);
  });

  // Stage 1 removed share/unshare/addParticipant/removeParticipant —
  // see delegation-model/REFACTOR_PLAN Stage 1. Sharing returns in
  // Stage 4 with policy-gated primitives.

  it("list() reflects title from metadata events", async () => {
    const conv = await store.create({ ownerId: "user_test" });
    await store.update(conv.id, { title: "Event-Derived Title" });

    const result = await store.list();
    const summary = result.conversations.find((c) => c.id === conv.id);
    expect(summary).toBeDefined();
    expect(summary!.title).toBe("Event-Derived Title");
  });

  it("list() filters by ownerId — non-owner cannot see another user's conversation", async () => {
    const conv = await store.create({ ownerId: "owner" });

    // Owner sees their conversation.
    const ownerView = await store.list(undefined, { userId: "owner" });
    expect(ownerView.conversations.find((c) => c.id === conv.id)).toBeDefined();

    // Non-owner does not.
    const otherView = await store.list(undefined, { userId: "other-user" });
    expect(otherView.conversations.find((c) => c.id === conv.id)).toBeUndefined();
  });

  it("backward compat: old files with title in line 1 still work", async () => {
    // Simulate an old-format file with title baked into line 1 — but
    // ownerId is required post-Stage-1 (the migration script stamps it).
    const id = "conv_1e9ac4c0000000a1";
    const path = join(dirs.dir, `${id}.jsonl`);
    const meta = {
      id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      title: "Old Title",
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUsd: 0,
      lastModel: null,
      format: "events",
      ownerId: "user-1",
    };
    writeFileSync(path, `${JSON.stringify(meta)}\n`);

    const loaded = await store.load(id);
    expect(loaded).not.toBeNull();
    expect(loaded?.title).toBe("Old Title");
    expect(loaded?.ownerId).toBe("user-1");
  });

  it("fork() preserves assistant turns through history() round-trip", async () => {
    // Regression: fork() previously wrote llm.response events without
    // run.start/run.done bookends. The reconstructor only emits assistant
    // messages inside an active run scope, so history() on a forked
    // event-format conversation returned only the user turns. Assistant
    // turns silently disappeared.
    const conv = await store.create({ ownerId: "user_test" });
    store.setActiveConversation(conv.id);

    store.emit({ type: "run.start", data: { runId: "r1", model: "test-model" } });
    store.emit({
      type: "llm.done",
      data: {
        runId: "r1",
        model: "test-model",
        content: [{ type: "text", text: "First reply" }],
        usage: { inputTokens: 10, outputTokens: 5 },
        llmMs: 50,
      },
    });
    store.emit({ type: "run.done", data: { runId: "r1", stopReason: "complete", totalMs: 50 } });

    store.appendEvent(conv.id, {
      ts: new Date().toISOString(),
      type: "user.message",
      content: [{ type: "text", text: "Follow up" }],
    } as ConversationEvent);

    store.emit({ type: "run.start", data: { runId: "r2", model: "test-model" } });
    store.emit({
      type: "llm.done",
      data: {
        runId: "r2",
        model: "test-model",
        content: [{ type: "text", text: "Second reply" }],
        usage: { inputTokens: 20, outputTokens: 8 },
        llmMs: 75,
      },
    });
    store.emit({ type: "run.done", data: { runId: "r2", stopReason: "complete", totalMs: 75 } });

    const sourceMessages = await store.history(conv);
    const sourceAssistantCount = sourceMessages.filter((m) => m.role === "assistant").length;

    const forked = await store.fork(conv.id);
    expect(forked).not.toBeNull();
    expect(forked!.id).not.toBe(conv.id);

    const forkedMessages = await store.history(forked!);
    const forkedAssistantCount = forkedMessages.filter((m) => m.role === "assistant").length;

    // Forked conversation must have the same number of assistant turns
    // as the source. Without the synthetic run.start/run.done bookends
    // around each forked llm.response, this would be 0.
    expect(forkedAssistantCount).toBe(sourceAssistantCount);
    expect(forkedAssistantCount).toBeGreaterThan(0);
  });
});
