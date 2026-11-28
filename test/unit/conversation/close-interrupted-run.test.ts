/**
 * A conversation whose last run has a start and no end (its process died mid-turn) is
 * closed `run.done` stopReason `interrupted` by `closeInterruptedRun`, and then reads back
 * as an interrupted turn: the conversations plugin shows it as an assistant message that
 * carries the reason, even when the run produced no model response.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callTool } from "../../../packages/conversations/src/server.ts";
import { createStore } from "../../../packages/conversations/src/store.ts";
import type { ConversationEvent } from "../../../src/conversation/types.ts";
import { conversationStore } from "../../helpers/conversation-store.ts";

const WS = "ws_1a1a1a1a1a1a1a1a";
const OWNER = "usr_interrupted";
const dir = mkdtempSync(join(tmpdir(), "close-interrupted-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ts = "2026-01-01T00:00:00.000Z";
const user = (text: string) =>
  ({ ts, type: "user.message", content: [{ type: "text", text }] }) as ConversationEvent;
const start = (runId: string) =>
  ({ ts, type: "run.start", runId, model: "anthropic:m" }) as ConversationEvent;
const done = (runId: string) =>
  ({ ts, type: "run.done", runId, stopReason: "complete", totalMs: 1 }) as ConversationEvent;
const reply = (runId: string, text: string) =>
  ({
    ts,
    type: "llm.response",
    runId,
    model: "anthropic:m",
    content: [{ type: "text", text }],
    usage: { inputTokens: 1, outputTokens: 1 },
    llmMs: 1,
    finishReason: "stop",
  }) as ConversationEvent;

async function seeded(events: ConversationEvent[]) {
  const store = conversationStore(dir, WS, OWNER);
  const conv = await store.create({ ownerId: OWNER, model: "anthropic:m" });
  for (const e of events) store.appendEvent(conv.id, e);
  await store.flush();
  return { store, id: conv.id };
}

async function displayed(id: string) {
  const got = await callTool(
    createStore(dir),
    "get",
    { id, expand: "full" },
    { principal: "person", workspaceId: WS, ownerId: OWNER },
  );
  return (
    got.structuredContent as {
      messages: Array<{ role: string; content: string; stopReason?: string }>;
    }
  ).messages;
}

describe("closeInterruptedRun", () => {
  test("ends a run with a start and no end, which then reads as interrupted", async () => {
    const { store, id } = await seeded([user("hello"), start("r1")]);
    // Unclosed and unanswered, the turn shows only the person's message.
    expect((await displayed(id)).map((m) => m.role)).toEqual(["user"]);

    expect(await store.closeInterruptedRun(id)).toBe(true);
    const last = (await store.readEvents(id)).at(-1);
    expect(last).toMatchObject({ type: "run.done", runId: "r1", stopReason: "interrupted" });
    expect(await displayed(id)).toEqual([
      expect.objectContaining({ role: "user", content: "hello" }),
      expect.objectContaining({ role: "assistant", content: "", stopReason: "interrupted" }),
    ]);
    // Closed once: a second call finds nothing open.
    expect(await store.closeInterruptedRun(id)).toBe(false);
  });

  test("keeps what an interrupted run said, and finds its start far back in the tail", async () => {
    const tools = Array.from(
      { length: 450 },
      (_, i) =>
        ({ ts, type: "tool.progress", runId: "r1", id: "t", message: `${i}` }) as ConversationEvent,
    );
    const { store, id } = await seeded([user("go"), start("r1"), reply("r1", "partial"), ...tools]);
    expect(await store.closeInterruptedRun(id)).toBe(true);
    expect((await displayed(id)).at(-1)).toMatchObject({
      role: "assistant",
      content: "partial",
      stopReason: "interrupted",
    });
  });

  test("leaves a closed run, and a conversation whose last turn has no run, alone", async () => {
    const closed = await seeded([user("a"), start("r1"), reply("r1", "b"), done("r1")]);
    expect(await closed.store.closeInterruptedRun(closed.id)).toBe(false);
    const asked = await seeded([user("a"), start("r1"), done("r1"), user("next")]);
    expect(await asked.store.closeInterruptedRun(asked.id)).toBe(false);
  });

  test("writes nothing when a turn began while the tail was read", async () => {
    const { store, id } = await seeded([user("hello"), start("r1")]);
    expect(await store.closeInterruptedRun(id, () => false)).toBe(false);
    expect((await store.readEvents(id)).at(-1)).toMatchObject({ type: "run.start" });
  });

  test("an unanswered run a later turn cut off reads as interrupted without a close", async () => {
    const { id } = await seeded([user("one"), start("r1"), user("two"), start("r2")]);
    const roles = (await displayed(id)).map((m) => [m.role, m.stopReason]);
    expect(roles).toEqual([
      ["user", undefined],
      ["assistant", "interrupted"],
      ["user", undefined],
    ]);
  });
});
