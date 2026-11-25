/**
 * Parity: the conversations plugin answers the public tools as the built-in conversations
 * app does, for the same events.
 *
 * Today's side is the built-in app's handlers (`src/platform/conversations/tools/`) over
 * its index, with the two things its source adds at the wire (the preview cap on `list`
 * rows, and `active`). The plugin's side is its MCP server, called as a person.
 *
 * - **Same files**: today's store writes the conversations, and the plugin reads the same
 *   directory. Every output is identical.
 * - **Same events**: today's store and the plugin's private tools are each fed the same
 *   events, into separate directories. Every output is identical once `createdAt` is set
 *   aside: each store stamps the moment it created the conversation, and nothing else
 *   differs.
 *
 * Named differences, both by design and neither in the outputs compared:
 * - `list` cursors are the plugin's own opaque position (sort key and id), where today's
 *   are the last row's id. Both are opaque; the rows of every page are compared.
 * - `stats` reports `period.until` as the moment it ran, so that field is set aside.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { buildServer } from "../../../packages/conversations/src/server.ts";
import { createStore } from "../../../packages/conversations/src/store.ts";
import { callContext } from "../../../packages/plugin-sdk/src/index.ts";
import { EventSourcedConversationStore } from "../../../src/conversation/event-sourced-store.ts";
import { workspaceConversationsDir } from "../../../src/conversation/paths.ts";
import { capPreview } from "../../../src/conversation/preview.ts";
import type { ConversationEvent } from "../../../src/conversation/types.ts";
import {
  ConversationIndex,
  type ReadScope,
} from "../../../src/platform/conversations/index-cache.ts";
import { handleExport } from "../../../src/platform/conversations/tools/export.ts";
import { handleGet } from "../../../src/platform/conversations/tools/get.ts";
import { handleList } from "../../../src/platform/conversations/tools/list.ts";
import { handleSearch } from "../../../src/platform/conversations/tools/search.ts";
import { handleStats } from "../../../src/platform/conversations/tools/stats.ts";
import type {
  ConversationsExportInput,
  ConversationsGetInput,
  ConversationsSearchInput,
} from "../../../src/platform/schemas/conversations.ts";

const WS = "ws_c3c3c3c3c3c3c3c3";
const OTHER_WS = "ws_d4d4d4d4d4d4d4d4";
const OWNER = "usr_parity";
const OTHER_OWNER = "usr_someone_else";
const M1 = "anthropic:claude-sonnet-5-5";
const M2 = "anthropic:claude-haiku-5";
const ts = (s: number) => new Date(Date.UTC(2030, 0, 1, 0, 0, s)).toISOString();
const text = (t: string) => [{ type: "text", text: t }];

const LONG =
  "Tell me everything about otters: where they live, what they eat, how they use tools, " +
  "why they hold hands while sleeping, how long they live, how they groom their fur, and " +
  "whether river otters and sea otters ever meet in the wild or in rescue centres.";

type Ev = Record<string, unknown> & { ts: string; type: string };

/** Each conversation's events, in the order they are appended. */
const CONVERSATIONS: Array<{ id: string; ws: string; owner: string; events: Ev[] }> = [
  {
    id: "conv_aaaaaaaaaaaaaaa1",
    ws: WS,
    owner: OWNER,
    events: [
      { ts: ts(0), type: "user.message", content: text(LONG), userId: OWNER },
      { ts: ts(1), type: "run.start", runId: "run_a", model: M1 },
      {
        ts: ts(2),
        type: "skills.loaded",
        runId: "run_a",
        skills: [
          { id: "s1", name: "research", scope: "workspace", tokens: 10, loadedBy: "trigger" },
          { name: "nameless" },
        ],
      },
      {
        ts: ts(3),
        type: "llm.response",
        runId: "run_a",
        model: M1,
        content: [
          { type: "reasoning", text: "thinking about otters" },
          { type: "text", text: "Let me look." },
          { type: "tool-call", toolCallId: "tc_1", toolName: "files__read", input: { p: "a" } },
          { type: "tool-call", toolCallId: "tc_held", toolName: "files__write", input: "{}" },
        ],
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50 },
        llmMs: 300,
        finishReason: "tool-calls",
      },
      {
        ts: ts(4),
        type: "tool.start",
        runId: "run_a",
        id: "tc_1",
        name: "files__read",
        input: { p: "a" },
      },
      {
        ts: ts(5),
        type: "tool.done",
        runId: "run_a",
        id: "tc_1",
        name: "files__read",
        ok: true,
        ms: 12,
        output: "otters hold hands",
        resourceUri: "ui://files/viewer",
        resourceLinks: [{ uri: "files://f_1", name: "notes.md" }],
      },
      {
        ts: ts(6),
        type: "tool.done",
        runId: "run_a",
        id: "tc_held",
        name: "files__write",
        ok: true,
        ms: 0,
        output: "",
        held: true,
      },
      {
        ts: ts(7),
        type: "llm.response",
        runId: "run_a",
        model: M2,
        content: text("Done."),
        usage: { inputTokens: 120, outputTokens: 10, reasoningTokens: 4 },
        llmMs: 200,
        finishReason: "stop",
      },
      { ts: ts(8), type: "run.done", runId: "run_a", stopReason: "complete", totalMs: 600 },
      {
        ts: ts(9),
        type: "aux.usage",
        source: "title",
        model: M2,
        usage: { inputTokens: 5, outputTokens: 2 },
      },
      { ts: ts(10), type: "metadata.title", title: "Otter research" },
      { ts: ts(11), type: "user.message", content: text("and again") },
      { ts: ts(12), type: "run.start", runId: "run_b", model: M1 },
      {
        ts: ts(13),
        type: "llm.response",
        runId: "run_b",
        model: M1,
        content: text("partial"),
        usage: { inputTokens: 7, outputTokens: 3 },
        llmMs: 50,
      },
      { ts: ts(14), type: "run.error", runId: "run_b", error: "boom" },
    ],
  },
  {
    id: "conv_aaaaaaaaaaaaaaa2",
    ws: WS,
    owner: OWNER,
    events: [
      { ts: ts(20), type: "user.message", content: text("short question") },
      { ts: ts(21), type: "run.start", runId: "run_c", model: M1 },
      {
        ts: ts(22),
        type: "llm.response",
        runId: "run_c",
        model: M1,
        content: text("answer"),
        usage: { inputTokens: 9, outputTokens: 4 },
        llmMs: 40,
      },
      { ts: ts(23), type: "run.done", runId: "run_c", stopReason: "max_tokens" },
      { ts: ts(24), type: "user.message", content: text("follow up") },
      { ts: ts(25), type: "run.start", runId: "run_d", model: M1 },
      {
        ts: ts(26),
        type: "llm.response",
        runId: "run_d",
        model: M1,
        content: text("half an answer"),
        usage: { inputTokens: 11, outputTokens: 6 },
        llmMs: 45,
      },
    ],
  },
  {
    id: "conv_aaaaaaaaaaaaaaa3",
    ws: WS,
    owner: OWNER,
    events: [
      { ts: ts(30), type: "user.message", content: [] },
      { ts: ts(31), type: "run.start", runId: "run_e", model: M2 },
      {
        ts: ts(32),
        type: "llm.response",
        runId: "run_e",
        model: M2,
        content: text("cut short"),
        usage: { inputTokens: 1, outputTokens: 1 },
        llmMs: 5,
      },
      { ts: ts(33), type: "user.message", content: text("next, about otters") },
      { ts: ts(34), type: "run.start", runId: "run_f", model: M2 },
      {
        ts: ts(35),
        type: "llm.response",
        runId: "run_f",
        model: M2,
        content: text("fine"),
        usage: { inputTokens: 2, outputTokens: 2 },
        llmMs: 6,
      },
      { ts: ts(36), type: "run.done", runId: "run_f", stopReason: "complete" },
    ],
  },
  {
    id: "conv_bbbbbbbbbbbbbbb1",
    ws: WS,
    owner: OTHER_OWNER,
    events: [{ ts: ts(40), type: "user.message", content: text("another owner's otters") }],
  },
  {
    id: "conv_bbbbbbbbbbbbbbb2",
    ws: OTHER_WS,
    owner: OWNER,
    events: [{ ts: ts(41), type: "user.message", content: text("another workspace's otters") }],
  },
];

type GetInput = ConversationsGetInput & { id: string };
type ExportInput = ConversationsExportInput & { id: string };

const MINE = CONVERSATIONS.filter((c) => c.ws === WS && c.owner === OWNER).map((c) => c.id);
const SCOPE: ReadScope = { workspaceId: WS, userId: OWNER };

const dirs: string[] = [];
function workDir(): string {
  const d = mkdtempSync(join(tmpdir(), "conversations-parity-"));
  dirs.push(d);
  for (const ws of [WS, OTHER_WS]) mkdirSync(join(d, "workspaces", ws), { recursive: true });
  return d;
}

/** Write every conversation through today's store. */
async function writeWithTodaysStore(dir: string): Promise<void> {
  for (const c of CONVERSATIONS) {
    const store = new EventSourcedConversationStore({
      dir: workspaceConversationsDir(dir, c.ws, c.owner),
    });
    await store.create({ id: c.id, ownerId: c.owner, workspaceId: c.ws, model: M1 });
    for (const e of c.events) {
      // biome-ignore lint/plugin/double-cast: a fixture event as stored; the store's union names each type's fields
      store.appendEvent(c.id, e as unknown as ConversationEvent);
    }
    // Distinct creation times, so an order by creation has no ties to break.
    await Bun.sleep(3);
  }
}

/** Today's public tools, as the built-in app answers them. */
function todaysApp(dir: string) {
  const index = new ConversationIndex();
  const ready = index.build(join(dir, "workspaces"));
  return {
    async call(tool: string, args: Record<string, unknown>, active?: string) {
      await ready;
      switch (tool) {
        case "list": {
          const page = await handleList(args, index, SCOPE);
          return {
            ...page,
            conversations: page.conversations.map((r) => ({
              ...r,
              preview: capPreview(r.preview),
              active: r.id === active,
            })),
          };
        }
        case "get":
          return handleGet(args as GetInput, index, SCOPE, args.id === active);
        case "search":
          return handleSearch(args as ConversationsSearchInput, index, SCOPE);
        case "stats":
          return handleStats(args, index, SCOPE);
        case "export":
          return handleExport(args as ExportInput, index, SCOPE);
      }
      throw new Error(tool);
    },
  };
}

/** The plugin's server over `dir`, called through MCP with the context in `_meta`. */
async function plugin(dir: string) {
  const server = buildServer({
    store: createStore(dir),
    contextOf: (meta) => callContext({ meta }),
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "parity", version: "1.0.0" });
  await client.connect(clientTransport);
  const meta = (principal: "host" | "person", conversationId?: string) => ({
    "ai.nimblebrain/scope": {
      workspaceId: WS,
      ownerId: OWNER,
      principal,
      ...(conversationId ? { conversationId } : {}),
    },
  });
  async function raw(
    tool: string,
    args: Record<string, unknown>,
    principal: "host" | "person",
    opts: { ws?: string; owner?: string; conversationId?: string } = {},
  ) {
    const m = meta(principal, opts.conversationId);
    if (opts.ws) m["ai.nimblebrain/scope"].workspaceId = opts.ws;
    if (opts.owner) m["ai.nimblebrain/scope"].ownerId = opts.owner;
    const r = await client.callTool({ name: tool, arguments: args, _meta: m });
    if (r.isError) throw new Error(`${tool}: ${JSON.stringify(r.content)}`);
    return r.structuredContent as Record<string, unknown>;
  }
  return {
    call: (tool: string, args: Record<string, unknown>, active?: string) =>
      raw(tool, args, "person", active ? { conversationId: active } : {}),
    raw,
    close: () => client.close(),
  };
}

type App = { call(tool: string, args: Record<string, unknown>, active?: string): Promise<unknown> };

/** Every public read the comparison makes, by name. */
async function reads(app: App): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  out.list = await app.call("list", {});
  out["list sortBy created"] = await app.call("list", { sortBy: "created" });
  out["list search"] = await app.call("list", { search: "OTTER" });
  out["list active"] = await app.call("list", {}, MINE[1]);
  const pages: unknown[] = [];
  let cursor: unknown;
  for (let i = 0; i < 10; i++) {
    const page = (await app.call("list", { limit: 2, ...(cursor ? { cursor } : {}) })) as {
      conversations: unknown[];
      nextCursor: string | null;
      totalCount: number;
    };
    pages.push({
      rows: page.conversations,
      more: page.nextCursor !== null,
      total: page.totalCount,
    });
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  out["list pages of 2"] = pages;
  for (const id of MINE) {
    for (const expand of ["metadata", "messages", "full"]) {
      out[`get ${id} ${expand}`] = await app.call("get", { id, expand });
    }
    out[`get ${id} limit 1`] = await app.call("get", { id, limit: 1 });
    out[`get ${id} limit 0`] = await app.call("get", { id, limit: 0 });
    out[`get ${id} in its own turn`] = await app.call("get", { id, expand: "full" }, id);
    out[`export ${id} markdown`] = await app.call("export", { id, format: "markdown" });
    out[`export ${id} json`] = await app.call("export", { id, format: "json" });
  }
  out["search otters"] = await app.call("search", { query: "otters" });
  out["search limit 1"] = await app.call("search", { query: "otters", limit: 1 });
  out["search half"] = await app.call("search", { query: "half" });
  for (const period of ["day", "week", "month", "all"]) {
    const stats = (await app.call("stats", { period })) as { period: Record<string, string> };
    out[`stats ${period}`] = { ...stats, period: { since: stats.period.since ? "set" : "" } };
  }
  return out;
}

/** Set aside each conversation's creation time, which each store stamps itself. */
function withoutCreatedAt(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value)
      .replace(/"createdAt":"[^"]*"/g, '"createdAt":"<created>"')
      .replace(/\*\*Created:\*\* [^\\]*/g, "**Created:** <created>"),
  );
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("conversations plugin parity with the built-in app", () => {
  let sameFiles: { today: Record<string, unknown>; plugin: Record<string, unknown> };
  let sameEvents: { today: Record<string, unknown>; plugin: Record<string, unknown> };

  beforeAll(async () => {
    const shared = workDir();
    await writeWithTodaysStore(shared);
    const reader = await plugin(shared);
    sameFiles = { today: await reads(todaysApp(shared)), plugin: await reads(reader) };
    await reader.close();

    const todayDir = workDir();
    await writeWithTodaysStore(todayDir);
    const pluginDir = workDir();
    const writer = await plugin(pluginDir);
    for (const c of CONVERSATIONS) {
      const at = { ws: c.ws, owner: c.owner };
      await writer.raw("create", { id: c.id, model: M1 }, "host", at);
      const { lastSeq } = await writer.raw(
        "append_events",
        { id: c.id, events: c.events },
        "host",
        at,
      );
      expect(lastSeq).toBe(c.events.length);
      await Bun.sleep(3);
    }
    sameEvents = { today: await reads(todaysApp(todayDir)), plugin: await reads(writer) };
    await writer.close();
  });

  test("reading the same files, every public output is identical", () => {
    expect(Object.keys(sameFiles.plugin)).toEqual(Object.keys(sameFiles.today));
    for (const key of Object.keys(sameFiles.today)) {
      expect({ [key]: sameFiles.plugin[key] }).toEqual({ [key]: sameFiles.today[key] });
    }
  });

  test("fed the same events, every public output is identical but for createdAt", () => {
    for (const key of Object.keys(sameEvents.today)) {
      expect({ [key]: withoutCreatedAt(sameEvents.plugin[key]) }).toEqual({
        [key]: withoutCreatedAt(sameEvents.today[key]),
      });
    }
  });

  test("the outputs cover the walls, the projections and the edge cases", () => {
    const today = sameFiles.today.list as { conversations: unknown[] };
    expect(today.conversations).toHaveLength(3);
    const list = sameFiles.plugin.list as { conversations: Array<{ id: string; preview: string }> };
    expect(list.conversations.map((c) => c.id)).toEqual([MINE[2], MINE[1], MINE[0]]);
    expect(list.conversations[2]!.preview.length).toBeLessThanOrEqual(200);
    const search = sameFiles.plugin["search otters"] as { results: Array<{ id: string }> };
    expect(search.results.map((r) => r.id).sort()).toEqual([MINE[0], MINE[2]].sort());
    const trailing = sameFiles.plugin[`get ${MINE[1]} full`] as {
      messages: Array<{ stopReason?: string; pending?: boolean }>;
    };
    expect(trailing.messages.at(-1)).toMatchObject({ stopReason: "interrupted" });
    const none = sameFiles.plugin[`get ${MINE[0]} limit 0`] as {
      messages: unknown[];
      totalMessages: number;
    };
    expect(none.messages).toEqual([]);
    expect(none.totalMessages).toBeGreaterThan(0);
    const live = sameFiles.plugin[`get ${MINE[1]} in its own turn`] as typeof trailing;
    expect(live.messages.at(-1)?.pending).toBe(true);
  });
});
