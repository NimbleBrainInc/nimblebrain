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
    const conv = await store.create();
    expect(conv.format).toBe("events");
    expect(conv.totalInputTokens).toBe(0);
    expect(conv.id).toMatch(/^conv_/);

    const lines = readLines(join(dirs.dir, `${conv.id}.jsonl`));
    const meta = JSON.parse(lines[0]);
    expect(meta.format).toBe("events");
  });

  it("emit() writes engine events to conversation file", async () => {
    const conv = await store.create();
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
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
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
    const conv = await store.create();

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
      inputTokens: 50,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
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
    const conv = await store.create();
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
    const conv = await debugStore.create();
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
    const conv = await store.create();
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
    const conv = await store.create();
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
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
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
        inputTokens: 200,
        outputTokens: 30,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
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
    const conv1 = await store.create();
    const conv2 = await store.create();

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
    const conv = await store.create();
    const loaded = await store.load(conv.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(conv.id);

    const deleted = await store.delete(conv.id);
    expect(deleted).toBe(true);

    const after = await store.load(conv.id);
    expect(after).toBeNull();
  });

  it("update() patches title", async () => {
    const conv = await store.create();
    const updated = await store.update(conv.id, { title: "New Title" });
    expect(updated).not.toBeNull();
    expect(updated!.title).toBe("New Title");

    const reloaded = await store.load(conv.id);
    expect(reloaded!.title).toBe("New Title");
  });

  it("update() appends metadata event instead of rewriting line 1", async () => {
    const conv = await store.create();
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
    const conv = await store.create();
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
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
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
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        llmMs: 100,
      },
    });
    store.emit({ type: "run.done", data: { runId: runId2, stopReason: "complete", totalMs: 100 } });

    await updatePromise;
    await store.flush();

    const loaded = await store.load(conv.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.title).toBe("Generated Title");
    // Both runs' tokens must be present — this is the core invariant
    expect(loaded!.totalInputTokens).toBe(20);
    expect(loaded!.totalOutputTokens).toBe(10);

    // Verify at the file level: all event lines are present, line 1 untouched
    const path = join(dirs.dir, `${conv.id}.jsonl`);
    const lines = readLines(path);
    const events = lines.slice(1).map((l) => JSON.parse(l));
    const types = events.map((e: { type: string }) => e.type);
    expect(types.filter((t: string) => t === "run.start").length).toBe(2);
    expect(types.filter((t: string) => t === "llm.response").length).toBe(2);
    expect(types.filter((t: string) => t === "run.done").length).toBe(2);
    expect(types).toContain("metadata.title");
  });

  it("shareConversation appends events instead of rewriting line 1", async () => {
    const conv = await store.create({ ownerId: "user-1", visibility: "private" });
    const path = join(dirs.dir, `${conv.id}.jsonl`);
    const line1Before = readLines(path)[0]!;

    await store.shareConversation(conv.id, "user-1");

    const linesAfter = readLines(path);
    // Line 1 unchanged
    expect(linesAfter[0]).toBe(line1Before);
    // Metadata events appended
    const events = linesAfter.slice(1).map((l) => JSON.parse(l));
    const types = events.map((e: { type: string }) => e.type);
    expect(types).toContain("metadata.visibility");
    expect(types).toContain("metadata.participants");

    // Behavioral correctness
    const loaded = await store.load(conv.id);
    expect(loaded!.visibility).toBe("shared");
    expect(loaded!.participants).toContain("user-1");
  });

  it("addParticipant and removeParticipant append events", async () => {
    const conv = await store.create({ ownerId: "owner", visibility: "shared", participants: ["owner"] });

    await store.addParticipant(conv.id, "user-2");
    const afterAdd = await store.load(conv.id);
    expect(afterAdd!.participants).toEqual(["owner", "user-2"]);

    await store.removeParticipant(conv.id, "user-2");
    const afterRemove = await store.load(conv.id);
    expect(afterRemove!.participants).toEqual(["owner"]);

    // Verify events at file level
    const path = join(dirs.dir, `${conv.id}.jsonl`);
    const events = readLines(path).slice(1).map((l) => JSON.parse(l));
    const participantEvents = events.filter((e: { type: string }) => e.type === "metadata.participants");
    expect(participantEvents.length).toBe(2);
  });

  it("list() reflects title from metadata events", async () => {
    const conv = await store.create();
    await store.update(conv.id, { title: "Event-Derived Title" });

    const result = await store.list();
    const summary = result.conversations.find((c) => c.id === conv.id);
    expect(summary).toBeDefined();
    expect(summary!.title).toBe("Event-Derived Title");
  });

  it("list() reflects visibility from metadata events for access filtering", async () => {
    const conv = await store.create({ ownerId: "owner", visibility: "private" });

    // Not visible to non-owner when private
    const beforeShare = await store.list(undefined, { userId: "other-user" });
    expect(beforeShare.conversations.find((c) => c.id === conv.id)).toBeUndefined();

    // Share it
    await store.shareConversation(conv.id, "owner");
    await store.addParticipant(conv.id, "other-user");

    // Now visible to participant
    const afterShare = await store.list(undefined, { userId: "other-user" });
    expect(afterShare.conversations.find((c) => c.id === conv.id)).toBeDefined();
  });

  it("backward compat: old files with title in line 1 still work", async () => {
    // Simulate an old-format file with title baked into line 1
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
      visibility: "shared",
      participants: ["user-1", "user-2"],
    };
    writeFileSync(path, `${JSON.stringify(meta)}\n`);

    const loaded = await store.load(id);
    expect(loaded).not.toBeNull();
    expect(loaded!.title).toBe("Old Title");
    expect(loaded!.visibility).toBe("shared");
    expect(loaded!.participants).toEqual(["user-1", "user-2"]);
  });
});
