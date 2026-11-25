/**
 * Event payloads are opaque in the conversations contract: an event is any object with a
 * string `ts` and `type`. A payload the plugin's projections do not expect never makes a raw
 * operation fail, and a public read of the conversation answers without what it could not
 * project.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { buildServer } from "../../../packages/conversations/src/server.ts";
import { createStore } from "../../../packages/conversations/src/store.ts";

const WS = "ws_e5e5e5e5e5e5e5e5";
const OWNER = "usr_payloads";
const MODEL = "anthropic:claude-sonnet-5-5";

/** Schema-valid events whose payloads no projection expects. */
const ODD_EVENTS = [
  { ts: "2030-01-02", type: "user.message", content: [null] },
  { ts: "2030-01-03", type: "user.message", content: "not an array" },
  { ts: "2030-01-04", type: "user.message", content: [{ type: "text", text: 42 }, 7, "x"] },
  { ts: "2030-01-05", type: "something.new", payload: { nested: [null, 1] } },
  { ts: "2030-01-06", type: "run.start", runId: "run_odd", model: MODEL },
  {
    ts: "2030-01-07",
    type: "llm.response",
    runId: "run_odd",
    model: 5,
    content: [null, { type: "tool-call", toolCallId: 9, toolName: null }, { type: "text" }],
    usage: { inputTokens: "10", outputTokens: null },
    llmMs: "slow",
  },
  { ts: "2030-01-08", type: "tool.done", runId: "run_odd", id: 9, ok: "yes", output: { x: 1 } },
  { ts: "2030-01-09", type: "skills.loaded", runId: "run_odd", skills: "none" },
  { ts: "2030-01-10", type: "run.done", runId: "run_odd", stopReason: 3 },
  { ts: "2030-01-11", type: "aux.usage", usage: "lots" },
  { ts: "2030-01-12", type: "metadata.title", title: { not: "a string" } },
];

let dir: string;
let client: Client;

const meta = (principal: "host" | "person") => ({
  "ai.nimblebrain/context": { workspaceId: WS, ownerId: OWNER, principal },
});

async function call(tool: string, args: Record<string, unknown>, principal: "host" | "person") {
  const r = await client.callTool({ name: tool, arguments: args, _meta: meta(principal) });
  if (r.isError) throw new Error(`${tool}: ${JSON.stringify(r.content)}`);
  return r.structuredContent as Record<string, unknown>;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "conversations-payloads-"));
  mkdirSync(join(dir, "workspaces", WS), { recursive: true });
  const server = buildServer({ store: createStore(dir) });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "payloads", version: "1.0.0" });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("opaque event payloads", () => {
  test("never make a raw operation or a public read fail", async () => {
    const { conversation } = (await call("create", { model: MODEL }, "host")) as {
      conversation: { id: string };
    };
    const id = conversation.id;
    const first = await call(
      "append_events",
      {
        id,
        events: [
          { ts: "2030-01-01", type: "user.message", content: [{ type: "text", text: "otters" }] },
        ],
      },
      "host",
    );
    expect(first.lastSeq).toBe(1);
    for (const [i, event] of ODD_EVENTS.entries()) {
      expect((await call("append_events", { id, events: [event] }, "host")).lastSeq).toBe(i + 2);
    }
    const last = ODD_EVENTS.length + 1;

    const events = await call("events", { id }, "host");
    expect((events.events as Array<{ seq: number }>).map((e) => e.seq)).toEqual(
      Array.from({ length: last }, (_, i) => i + 1),
    );
    expect(events.lastSeq).toBe(last);
    expect((await call("append_events", { id, events: [] }, "host")).lastSeq).toBe(last);

    const full = await call("get", { id, expand: "full" }, "person");
    expect(JSON.stringify(full.messages)).toContain("otters");
    await call("get", { id }, "person");
    const list = await call("list", {}, "person");
    expect((list.conversations as Array<{ id: string; preview: string }>)[0]).toMatchObject({
      id,
      preview: "otters",
    });
    const search = await call("search", { query: "otters" }, "person");
    expect((search.results as Array<{ id: string }>).map((r) => r.id)).toEqual([id]);
    await call("stats", { period: "all" }, "person");
    await call("export", { id, format: "markdown" }, "person");
    await call("export", { id, format: "json" }, "person");

    expect((await call("delete", { id }, "host")).deleted).toBe(true);
  });
});
