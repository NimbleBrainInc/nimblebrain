/**
 * `search` matches the text a person sees in a conversation, its title and its messages'
 * text, and answers each match as a snippet of that text. The stored events' own fields
 * (types, usage, tool calls and their output) are never matched or returned.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callTool } from "../../../packages/conversations/src/server.ts";
import { type ConversationStore, createStore } from "../../../packages/conversations/src/store.ts";

const SCOPE = { workspaceId: "ws_5e5e5e5e5e5e5e5e", ownerId: "usr_search" };
const host = { principal: "host" as const, ...SCOPE };
const person = { principal: "person" as const, ...SCOPE };

let dir: string;
let store: ConversationStore;

interface SearchOut {
  results: Array<{ id: string; title: string | null; matches: Array<{ snippet: string }> }>;
  totalMatches: number;
}

async function search(query: string): Promise<SearchOut> {
  const out = await callTool(store, "search", { query }, person);
  return out.structuredContent as SearchOut;
}

async function conversation(events: Array<Record<string, unknown>>): Promise<string> {
  const created = await callTool(store, "create", { model: "anthropic:m" }, host);
  const id = (created.structuredContent as { conversation: { id: string } }).conversation.id;
  await callTool(store, "append_events", { id, events }, host);
  return id;
}

const ts = "2026-01-01T00:00:00.000Z";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "conversations-search-"));
  store = createStore(dir);
  await conversation([
    { ts, type: "user.message", content: [{ type: "text", text: 'Plan a "quiet" trip to Kyoto' }] },
    { ts, type: "run.start", runId: "r1", model: "anthropic:m" },
    {
      ts,
      type: "llm.response",
      runId: "r1",
      model: "anthropic:m",
      content: [
        { type: "text", text: "Here is a plan for a slow week in Kyoto." },
        { type: "tool-call", toolCallId: "t1", toolName: "web__search", input: "{}" },
      ],
      usage: { inputTokens: 120, outputTokens: 30 },
      llmMs: 5,
    },
    {
      ts,
      type: "tool.done",
      runId: "r1",
      id: "t1",
      ok: true,
      ms: 3,
      output: "zebra-crossing results",
    },
    { ts, type: "run.done", runId: "r1", stopReason: "complete" },
    { ts, type: "metadata.title", title: "Kyoto itinerary" },
  ]);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("search", () => {
  test("a stored field name matches nothing", async () => {
    for (const q of ["inputTokens", "metadata.title", "llm.response", "runId"]) {
      expect((await search(q)).results).toEqual([]);
    }
  });

  test("a tool's output is not text a person reads, so it matches nothing", async () => {
    expect((await search("zebra-crossing")).results).toEqual([]);
  });

  test("a match in a reply answers a snippet of the reply's text", async () => {
    const out = await search("slow week");
    expect(out.results).toHaveLength(1);
    const [snippet] = out.results[0]?.matches.map((m) => m.snippet) ?? [];
    expect(snippet).toBe("Here is a plan for a slow week in Kyoto.");
  });

  test("every snippet is the text a person sees, never a stored line", async () => {
    const out = await search("kyoto");
    expect(out.results).toHaveLength(1);
    const snippets = out.results[0]?.matches.map((m) => m.snippet) ?? [];
    expect(snippets).toEqual([
      "Kyoto itinerary",
      'Plan a "quiet" trip to Kyoto',
      "Here is a plan for a slow week in Kyoto.",
    ]);
    for (const s of snippets) expect(s).not.toContain('"ts"');
  });

  test("the title matches", async () => {
    const out = await search("itinerary");
    expect(out.results[0]?.matches).toEqual([{ snippet: "Kyoto itinerary" }]);
  });

  test("a query that storage escapes still matches the text as written", async () => {
    const out = await search('"quiet"');
    expect(out.results[0]?.matches).toEqual([{ snippet: 'Plan a "quiet" trip to Kyoto' }]);
  });
});
