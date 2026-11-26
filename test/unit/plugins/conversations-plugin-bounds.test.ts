/**
 * The conversations contract bounds its public inputs: `update`'s title has a maximum
 * length, and every limit is an integer within a range. The plugin validates each call
 * against the contract document, so an input past a bound is `invalid_input` and nothing is
 * written.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callTool } from "../../../packages/conversations/src/server.ts";
import { type ConversationStore, createStore } from "../../../packages/conversations/src/store.ts";

const SCOPE = { workspaceId: "ws_b0b0b0b0b0b0b0b0", ownerId: "usr_bounds" };
const host = { principal: "host" as const, ...SCOPE };
const person = { principal: "person" as const, ...SCOPE };

let dir: string;
let store: ConversationStore;
let id: string;

/** The `code` of a tool error, or null for a success. */
function codeOf(result: Awaited<ReturnType<typeof callTool>>): string | null {
  if (!("isError" in result) || !result.isError) return null;
  return (JSON.parse(result.content[0]?.text ?? "{}") as { code: string }).code;
}

async function title(): Promise<unknown> {
  const got = await callTool(store, "get", { id, expand: "metadata" }, person);
  return (got.structuredContent as { metadata: { title: unknown } }).metadata.title;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "conversations-bounds-"));
  store = createStore(dir);
  const created = await callTool(store, "create", { model: "anthropic:m" }, host);
  id = (created.structuredContent as { conversation: { id: string } }).conversation.id;
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("bounded inputs", () => {
  test("a title past 200 characters is invalid_input, and the title is unchanged", async () => {
    expect(codeOf(await callTool(store, "update", { id, title: "t".repeat(200) }, person))).toBe(
      null,
    );
    expect(await title()).toBe("t".repeat(200));
    const refused = await callTool(store, "update", { id, title: "x".repeat(201) }, person);
    expect(codeOf(refused)).toBe("invalid_input");
    expect(await title()).toBe("t".repeat(200));
    const events = await callTool(store, "events", { id }, host);
    expect((events.structuredContent as { lastSeq: number }).lastSeq).toBe(1);
  });

  test.each([
    ["list", { limit: 201 }],
    ["list", { limit: 0 }],
    ["list", { limit: 1.5 }],
    ["search", { query: "x", limit: 101 }],
    ["search", { query: "x", limit: 0 }],
    ["get", { id: "conv_0000000000000000", limit: 1001 }],
    ["get", { id: "conv_0000000000000000", limit: -1 }],
    ["events", { id: "conv_0000000000000000", limit: 5001 }],
  ] as const)("%s with %o is invalid_input", async (tool, args) => {
    const ctx = tool === "events" ? host : person;
    expect(codeOf(await callTool(store, tool, { ...args }, ctx))).toBe("invalid_input");
  });

  test("limits at their maximum are accepted", async () => {
    expect(codeOf(await callTool(store, "list", { limit: 200 }, person))).toBe(null);
    expect(codeOf(await callTool(store, "search", { query: "x", limit: 100 }, person))).toBe(null);
    expect(codeOf(await callTool(store, "get", { id, limit: 1000 }, person))).toBe(null);
  });
});
