/**
 * Tests that the event-sourced conversation store gracefully handles
 * malformed JSONL lines — partial writes, truncation, or corruption.
 *
 * A single bad line must not crash load() or history().
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventSourcedConversationStore } from "../../../src/conversation/event-sourced-store.ts";

function makeDirs() {
  const base = mkdtempSync(join(tmpdir(), "store-corruption-"));
  const dir = join(base, "conversations");
  const logDir = join(base, "logs");
  mkdirSync(dir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  return { dir, logDir };
}

function makeMetadataLine(id: string): string {
  return JSON.stringify({
    model: "anthropic:claude-sonnet-4-6",
    id,
    createdAt: "2026-04-14T00:00:00Z",
    format: "events",
    ownerId: "user_test",
  });
}

/** One event line as it sits on disk; the fixture may write any shape. */
function makeEvent(overrides: Record<string, unknown> & { type: string }): string {
  return JSON.stringify({
    ts: "2026-04-14T00:01:00Z",
    ...overrides,
  });
}

describe("conversation store corruption resilience", () => {
  it("load() skips malformed event lines and returns conversation", async () => {
    const dirs = makeDirs();
    const store = new EventSourcedConversationStore(dirs);
    const id = "conv_c0aa0e1000000001";

    const lines = [
      makeMetadataLine(id),
      makeEvent({ type: "user.message", content: [{ type: "text", text: "Hello" }] }),
      "NOT VALID JSON {{{",
      makeEvent({
        type: "llm.done",
        model: "test",
        content: [{ type: "text", text: "Hi!" }],
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
        llmMs: 100,
      }),
    ];

    writeFileSync(join(dirs.dir, `${id}.jsonl`), `${lines.join("\n")}\n`);

    const conv = await store.load(id);
    expect(conv).not.toBeNull();
    expect(conv!.id).toBe(id);
  });

  it("history() skips malformed lines and reconstructs valid messages", async () => {
    const dirs = makeDirs();
    const store = new EventSourcedConversationStore(dirs);
    const id = "conv_c0aa0e1000000002";

    const lines = [
      makeMetadataLine(id),
      makeEvent({ type: "user.message", content: [{ type: "text", text: "Hello" }] }),
      "TRUNCATED LINE",
      '{"ts":"2026-04-14T00:02:00Z","type":"llm.done","model":"test","content":[{"type":"text","text":"Reply"}],"usage":{"inputTokens":10,"outputTokens":5,"cacheReadTokens":0,"cacheWriteTokens":0},"llmMs":100}',
      makeEvent({
        type: "run.done",
        runId: "r1",
        toolCalls: 0,
        iterations: 1,
        inputTokens: 10,
        outputTokens: 5,
        totalMs: 200,
      }),
    ];

    writeFileSync(join(dirs.dir, `${id}.jsonl`), `${lines.join("\n")}\n`);

    const conv = await store.load(id);
    expect(conv).not.toBeNull();

    const messages = await store.history(conv!);
    // Should have reconstructed messages from the valid events, skipping the corrupt line
    expect(messages.length).toBeGreaterThan(0);
    // The user message should be present
    const userMsg = messages.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
  });

  it("load() never returns a conversation when the metadata line (line 1) is corrupt", async () => {
    const dirs = makeDirs();
    const store = new EventSourcedConversationStore(dirs);
    const id = "conv_c0aa0e1000000003";

    writeFileSync(join(dirs.dir, `${id}.jsonl`), "NOT JSON AT ALL\n");

    // Metadata line is critical — store cannot recover without it. Returning
    // null and throwing are both acceptable; returning a conversation is not.
    const loaded = await store.load(id).catch(() => null);
    expect(loaded).toBeNull();
  });

  it("load() handles file with only metadata and no events", async () => {
    const dirs = makeDirs();
    const store = new EventSourcedConversationStore(dirs);
    const id = "conv_c0aa0e1000000004";

    writeFileSync(join(dirs.dir, `${id}.jsonl`), `${makeMetadataLine(id)}\n`);

    const conv = await store.load(id);
    expect(conv).not.toBeNull();
    expect(conv!.id).toBe(id);
    expect(conv!.lastModel).toBeNull();
  });

  it("history() returns empty array when all event lines are corrupt", async () => {
    const dirs = makeDirs();
    const store = new EventSourcedConversationStore(dirs);
    const id = "conv_c0aa0e1000000005";

    const lines = [makeMetadataLine(id), "GARBAGE LINE 1", "GARBAGE LINE 2", "{incomplete json"];

    writeFileSync(join(dirs.dir, `${id}.jsonl`), `${lines.join("\n")}\n`);

    const conv = await store.load(id);
    expect(conv).not.toBeNull();

    const messages = await store.history(conv!);
    expect(messages).toEqual([]);
  });
});
