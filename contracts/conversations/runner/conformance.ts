#!/usr/bin/env bun
/**
 * Black-box conformance runner for `ai.nimblebrain.conversations` 1.0.
 *
 * It speaks only MCP (Streamable HTTP) to the URLs it is given and reads only
 * the contract's own files (`schemas/`, `errors.json`). It imports no
 * implementation code, so it checks an implementation in any language.
 *
 *   bun --no-env-file contracts/conversations/runner/conformance.ts \
 *     --app <url> [--records <url>] [transport options] [fixture options]
 *
 * Roles. Each role's cases run only when its URL is given, so either role can
 * be checked alone.
 *   --app <url>             the app role's MCP endpoint
 *   --records <url>         the records role's MCP endpoint
 *
 * Transport options. These say how this runner reaches an implementation; they
 * are not part of the contract (CONTRACT.md, "Scope": scope is carried by the
 * connection's authenticated context, and how is the transport's business).
 *   --header <k=v>          an extra header on every request (repeatable)
 *   --bearer-env <VAR>      send `Authorization: Bearer $VAR`; the value is never printed
 *   --scope-carriage <c>    how this runner states the scope of each call:
 *                             none     the connection itself is scoped (a URL and a
 *                                      credential, such as a runtime's /mcp/<wsId>);
 *                                      the default. Cases that need a second scope skip.
 *                             headers  x-nb-workspace-id / x-nb-owner-id /
 *                                      x-nb-conversation-id request headers
 *                             meta     params._meta["ai.nimblebrain/scope"] =
 *                                      { workspaceId, ownerId, conversationId? }
 *   --workspace <id>        the scope's workspace (required unless carriage is none)
 *   --owner <id>            the scope's owner (required unless carriage is none)
 *   --protocol-version <v>  pin this MCP revision instead of negotiating
 *   --tool-prefix <p>       the app's tools are listed as <p><tool> at this door (a
 *                           runtime's /mcp/<wsId> lists them as conversations__<tool>
 *                           beside other tools); only tools with the prefix are judged
 *
 * Fixture options.
 *   --fixture <convId>      a conversation already in scope whose user messages
 *                           contain --fixture-text; without it, and without
 *                           --records to seed one, the app's data cases skip
 *   --fixture-text <text>   default "otters"
 *   --scratch-workspace <id>  a disposable workspace for records delete_workspace
 *   --skip <text>           skip every case whose name contains <text> (repeatable)
 *
 * Output: one line per case (`ok`, `FAIL`, `skip`), then a total. Exit 0 when no
 * case fails, 1 when one does, 2 on bad arguments.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import Ajv2020 from "ajv/dist/2020.js";

// ── Options and results ──────────────────────────────────────────────────

export type ScopeCarriage = "none" | "headers" | "meta";

export interface RunnerOptions {
  app?: string;
  records?: string;
  headers?: Record<string, string>;
  scopeCarriage?: ScopeCarriage;
  workspace?: string;
  owner?: string;
  protocolVersion?: string;
  toolPrefix?: string;
  fixture?: string;
  fixtureText?: string;
  scratchWorkspace?: string;
  skip?: string[];
  /** Where each case's line goes as it finishes. */
  log?: (line: string) => void;
}

export type CaseStatus = "pass" | "fail" | "skip";

export interface CaseResult {
  role: "app" | "records";
  name: string;
  status: CaseStatus;
  detail?: string;
}

// ── The contract's files ─────────────────────────────────────────────────

const CONTRACT_DIR = resolve(import.meta.dir, "..");
const SCOPE_META_KEY = "ai.nimblebrain/scope";
const UI_URI = "ui://conversations/browser";
const MCP_APP_MIME = "text/html;profile=mcp-app";
const MODEL = "anthropic:claude-sonnet-5-5";

export const APP_TOOLS = ["list", "get", "search", "update", "stats", "export"] as const;
export const RECORDS_TOOLS = [
  "create",
  "get",
  "events",
  "append_events",
  "update",
  "delete",
  "delete_workspace",
  "list",
  "search",
] as const;

interface ErrorsFile {
  records: Array<{ code: string }>;
  app: Array<{ kind: string; prefix: string }>;
}
const ERRORS = JSON.parse(
  readFileSync(resolve(CONTRACT_DIR, "errors.json"), "utf-8"),
) as ErrorsFile;
const RECORDS_CODES = new Set(ERRORS.records.map((e) => e.code));

function appPrefix(kind: string): string {
  const entry = ERRORS.app.find((e) => e.kind === kind);
  if (!entry) throw new Error(`errors.json has no app error "${kind}"`);
  return entry.prefix;
}

/** A role's committed schema for one tool, without `$schema` / `$id` (as it travels in tools/list). */
function contractSchema(role: string, tool: string, kind: "input" | "output") {
  const raw = JSON.parse(
    readFileSync(resolve(CONTRACT_DIR, "schemas", role, `${tool}.${kind}.json`), "utf-8"),
  ) as Record<string, unknown>;
  const { $schema: _s, $id: _i, ...wire } = raw;
  return wire;
}

const ajv = new Ajv2020({ strict: false, allErrors: true });
const validators = new Map<string, ReturnType<typeof ajv.compile>>();
function validateOutput(role: string, tool: string, value: unknown): void {
  const key = `${role}/${tool}`;
  let validate = validators.get(key);
  if (!validate) {
    validate = ajv.compile(contractSchema(role, tool, "output"));
    validators.set(key, validate);
  }
  if (!validate(value)) {
    throw new Error(`${tool} output fails its schema: ${ajv.errorsText(validate.errors)}`);
  }
}

// ── Assertions ───────────────────────────────────────────────────────────

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
/** JSON with object keys sorted, so key order never decides equality. */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b)))
      : val,
  );
}
function eq(actual: unknown, expected: unknown, msg: string): void {
  const a = canonical(actual);
  const e = canonical(expected);
  if (a !== e) throw new Error(`${msg}: got ${a.slice(0, 300)} want ${e.slice(0, 300)}`);
}

// ── Connections ──────────────────────────────────────────────────────────

interface Scope {
  workspace?: string;
  owner?: string;
  conversation?: string;
}

interface CallResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: Array<{ type: string; text?: string }>;
}

interface ListedTool {
  name: string;
  description?: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean };
}

/** One MCP connection under one scope, as this runner's transport options carry it. */
interface Conn {
  call(name: string, args: Record<string, unknown>): Promise<CallResult>;
  listTools(): Promise<ListedTool[]>;
  client: Client;
  close(): Promise<void>;
}

function scopeHeaders(carriage: ScopeCarriage, scope: Scope): Record<string, string> {
  if (carriage !== "headers") return {};
  const h: Record<string, string> = {};
  if (scope.workspace) h["x-nb-workspace-id"] = scope.workspace;
  if (scope.owner) h["x-nb-owner-id"] = scope.owner;
  if (scope.conversation) h["x-nb-conversation-id"] = scope.conversation;
  return h;
}

function scopeMeta(carriage: ScopeCarriage, scope: Scope): Record<string, unknown> | undefined {
  if (carriage !== "meta") return undefined;
  return {
    [SCOPE_META_KEY]: {
      ...(scope.workspace ? { workspaceId: scope.workspace } : {}),
      ...(scope.owner ? { ownerId: scope.owner } : {}),
      ...(scope.conversation ? { conversationId: scope.conversation } : {}),
    },
  };
}

async function connect(opts: RunnerOptions, url: string, scope: Scope): Promise<Conn> {
  const carriage = opts.scopeCarriage ?? "none";
  const headers = { ...(opts.headers ?? {}), ...scopeHeaders(carriage, scope) };
  const meta = scopeMeta(carriage, scope);
  const client = new Client(
    { name: "conversations-contract-conformance", version: "1.0.0" },
    {
      versionNegotiation: { mode: opts.protocolVersion ? { pin: opts.protocolVersion } : "auto" },
    },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      fetch: (input, init) => {
        const h = new Headers(init?.headers);
        for (const [k, v] of Object.entries(headers)) h.set(k, v);
        return fetch(input, { ...init, headers: h });
      },
    }),
  );
  return {
    client,
    call: async (name, args) =>
      (await client.callTool({
        name,
        arguments: args,
        ...(meta ? { _meta: meta } : {}),
      })) as CallResult,
    listTools: async () => (await client.listTools()).tools as ListedTool[],
    close: () => client.close(),
  };
}

function ok(r: CallResult): Record<string, unknown> {
  if (r.isError) throw new Error(`tool error: ${r.content?.[0]?.text}`);
  assert(r.structuredContent, "no structuredContent");
  return r.structuredContent;
}
function errorBody(r: CallResult): { code?: string; error?: string } {
  assert(r.isError === true, `expected isError, got ${JSON.stringify(r).slice(0, 200)}`);
  return JSON.parse(r.content?.[0]?.text ?? "{}") as { code?: string; error?: string };
}
function recordsCode(r: CallResult): string | undefined {
  const { code } = errorBody(r);
  assert(code && RECORDS_CODES.has(code), `code ${String(code)} is not in errors.json#/records`);
  return code;
}

// ── Harness ──────────────────────────────────────────────────────────────

interface Harness {
  results: CaseResult[];
  run(name: string, fn: () => Promise<void>): Promise<void>;
  skip(name: string, why: string): void;
}

function harness(role: CaseResult["role"], opts: RunnerOptions, results: CaseResult[]): Harness {
  const log = opts.log ?? (() => {});
  const record = (r: CaseResult) => {
    results.push(r);
    const tag = r.status === "pass" ? "ok  " : r.status === "fail" ? "FAIL" : "skip";
    log(`${tag}  ${role}: ${r.name}${r.detail ? ` (${r.detail})` : ""}`);
  };
  return {
    results,
    async run(name, fn) {
      if ((opts.skip ?? []).some((t) => name.includes(t))) {
        record({ role, name, status: "skip", detail: "--skip" });
        return;
      }
      try {
        await fn();
        record({ role, name, status: "pass" });
      } catch (err) {
        record({
          role,
          name,
          status: "fail",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    },
    skip(name, why) {
      record({ role, name, status: "skip", detail: why });
    },
  };
}

async function checkToolList(
  tools: ListedTool[],
  role: "app" | "records",
  names: readonly string[],
): Promise<void> {
  eq(tools.map((t) => t.name).sort(), [...names].sort(), "tool names");
  for (const t of tools) {
    eq(t.inputSchema, contractSchema(role, t.name, "input"), `${t.name} inputSchema`);
    eq(t.outputSchema, contractSchema(role, t.name, "output"), `${t.name} outputSchema`);
    assert(t.description && t.description.length > 0, `${t.name} has no description`);
  }
}

// ── Records role ─────────────────────────────────────────────────────────

const ts = (s: number) => new Date(Date.UTC(2030, 0, 1, 0, 0, s)).toISOString();
function turn(text: string, reply: string, at: number, runId: string) {
  return [
    { ts: ts(at), type: "user.message", content: [{ type: "text", text }] },
    { ts: ts(at + 1), type: "run.start", runId, model: MODEL },
    {
      ts: ts(at + 2),
      type: "llm.response",
      runId,
      model: MODEL,
      content: [{ type: "text", text: reply }],
      usage: { inputTokens: 10, outputTokens: 5 },
    },
    { ts: ts(at + 3), type: "run.done", runId, stopReason: "complete" },
  ];
}

interface RecordsCtx {
  h: Harness;
  rec: Conn;
  /** Records call that checks a success against the tool's output schema. */
  okCall(conn: Conn, tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  fixtureText: string;
  id: string;
}

async function recordsBasics(c: RecordsCtx, owner: string, workspace: string): Promise<void> {
  const { h, rec } = c;
  await h.run("tools/list matches the contract schemas", async () =>
    checkToolList(await rec.listTools(), "records", RECORDS_TOOLS),
  );
  await h.run("create in scope", async () => {
    const out = await c.okCall(rec, "create", {
      model: MODEL,
      metadata: { source: "conformance" },
    });
    const conv = out.conversation as Record<string, unknown>;
    assert(/^conv_[0-9a-f]{16}$/.test(String(conv.id)), `id ${String(conv.id)}`);
    eq(
      [conv.ownerId, conv.workspaceId, conv.model, conv.title],
      [owner, workspace, MODEL, null],
      "fields",
    );
    c.id = String(conv.id);
  });
  await h.run("create with a taken id is conversation_exists", async () => {
    eq(
      recordsCode(await rec.call("create", { id: c.id, model: MODEL })),
      "conversation_exists",
      "code",
    );
  });
  await h.run(
    "append numbers events 1..n per conversation, gapless, batches never split",
    async () => {
      const first = await c.okCall(rec, "append_events", {
        id: c.id,
        events: turn(`hello ${c.fixtureText}`, "hi", 0, "run_a"),
      });
      eq(first.lastSeq, 4, "first batch");
      const second = await c.okCall(rec, "append_events", {
        id: c.id,
        events: turn("second", "again", 10, "run_b"),
      });
      eq(second.lastSeq, 8, "second batch");
      eq(
        (await c.okCall(rec, "append_events", { id: c.id, events: [] })).lastSeq,
        8,
        "empty batch",
      );
      const all = await c.okCall(rec, "events", { id: c.id });
      eq(
        (all.events as Array<{ seq: number }>).map((e) => e.seq),
        [1, 2, 3, 4, 5, 6, 7, 8],
        "seqs",
      );
      eq(all.lastSeq, 8, "lastSeq");
      eq(
        (all.events as Array<{ event: { type: string } }>)[4]?.event.type,
        "user.message",
        "order",
      );
    },
  );
  await h.run("events pages by afterSeq, limit and throughSeq", async () => {
    const p = await c.okCall(rec, "events", { id: c.id, afterSeq: 2, limit: 3 });
    eq(
      (p.events as Array<{ seq: number }>).map((e) => e.seq),
      [3, 4, 5],
      "page",
    );
    eq(p.lastSeq, 8, "lastSeq");
    const q = await c.okCall(rec, "events", { id: c.id, afterSeq: 5, throughSeq: 6 });
    eq(
      (q.events as Array<{ seq: number }>).map((e) => e.seq),
      [6],
      "bounded",
    );
  });
  await h.run("append to an unknown id is conversation_not_found", async () => {
    const r = await rec.call("append_events", {
      id: "conv_0000000000000000",
      events: turn("x", "y", 0, "r"),
    });
    eq(recordsCode(r), "conversation_not_found", "code");
  });
  await h.run("invalid input is invalid_input", async () => {
    eq(recordsCode(await rec.call("append_events", { id: c.id })), "invalid_input", "code");
  });
  await h.run("an unknown tool is unknown_tool", async () => {
    eq(recordsCode(await rec.call("no_such_tool", {})), "unknown_tool", "code");
  });
}

async function recordsWalls(c: RecordsCtx, other: Conn, elsewhere: Conn): Promise<void> {
  const { h } = c;
  await h.run("another owner and another workspace see nothing", async () => {
    eq((await c.okCall(other, "get", { id: c.id })).conversation, null, "other owner get");
    eq((await c.okCall(elsewhere, "get", { id: c.id })).conversation, null, "other workspace get");
    eq((await c.okCall(other, "events", { id: c.id })).events, [], "other owner events");
    eq(
      recordsCode(await other.call("append_events", { id: c.id, events: [] })),
      "conversation_not_found",
      "other owner append",
    );
    const l = await c.okCall(other, "list", { limit: 200 });
    assert(
      !(l.items as Array<{ id: string }>).some((s) => s.id === c.id),
      "listed to another owner",
    );
    eq((await c.okCall(other, "delete", { id: c.id })).deleted, false, "other owner delete");
  });
  await h.run("create in a workspace with nothing stored is workspace_not_found", async () => {
    eq(
      recordsCode(await elsewhere.call("create", { model: MODEL })),
      "workspace_not_found",
      "code",
    );
  });
}

async function recordsLifecycle(c: RecordsCtx): Promise<void> {
  const { h, rec } = c;
  await h.run("update records a title as an event; get projects it", async () => {
    const conv = (await c.okCall(rec, "update", { id: c.id, title: "Conformance" }))
      .conversation as Record<string, unknown>;
    eq(conv.title, "Conformance", "title");
    const e = await c.okCall(rec, "events", { id: c.id, afterSeq: 8 });
    eq((e.events as Array<{ event: { type: string } }>)[0]?.event.type, "metadata.title", "event");
  });
  await h.run("list and search find it", async () => {
    const l = await c.okCall(rec, "list", { limit: 200 });
    const row = (l.items as Array<Record<string, unknown>>).find((s) => s.id === c.id);
    assert(row, "not listed");
    eq([row.title, row.messageCount], ["Conformance", 4], "summary");
    const s = await c.okCall(rec, "search", { text: c.fixtureText, limit: 50 });
    assert(
      (s.items as Array<{ id: string }>).some((x) => x.id === c.id),
      "not found by search",
    );
  });
  await h.run("a list cursor is stable under inserts: no repeats, no skips", async () => {
    const made: string[] = [];
    for (let i = 0; i < 3; i++) {
      made.push(
        String(
          ((await c.okCall(rec, "create", { model: MODEL })).conversation as { id: string }).id,
        ),
      );
    }
    const first = await c.okCall(rec, "list", { limit: 2, sort: "created" });
    const cursor = first.nextCursor;
    assert(typeof cursor === "string", "no nextCursor on a partial page");
    const inserted = String(
      ((await c.okCall(rec, "create", { model: MODEL })).conversation as { id: string }).id,
    );
    const seen = (first.items as Array<{ id: string }>).map((x) => x.id);
    let next: unknown = cursor;
    while (typeof next === "string") {
      const page = await c.okCall(rec, "list", { limit: 2, sort: "created", cursor: next });
      seen.push(...(page.items as Array<{ id: string }>).map((x) => x.id));
      next = page.nextCursor;
    }
    eq(seen.length, new Set(seen).size, "a conversation was listed twice");
    for (const id of [...made, c.id]) assert(seen.includes(id), `${id} skipped`);
    assert(
      !seen.includes(inserted),
      "a conversation created after the first page appeared behind the cursor",
    );
    for (const id of [...made, inserted]) await c.okCall(rec, "delete", { id });
  });
  await h.run("delete removes it; a second delete answers false", async () => {
    const temp = (await c.okCall(rec, "create", { model: MODEL })).conversation as { id: string };
    eq((await c.okCall(rec, "delete", { id: temp.id })).deleted, true, "delete");
    eq((await c.okCall(rec, "get", { id: temp.id })).conversation, null, "get after");
    eq((await c.okCall(rec, "delete", { id: temp.id })).deleted, false, "again");
  });
}

async function recordsDeleteWorkspace(
  c: RecordsCtx,
  opts: RunnerOptions,
  url: string,
): Promise<void> {
  const scratch = opts.scratchWorkspace;
  if (!scratch) {
    c.h.skip("delete_workspace removes every owner's conversations", "no --scratch-workspace");
    return;
  }
  await c.h.run("delete_workspace removes every owner's conversations", async () => {
    const owner = opts.owner as string;
    const a = await connect(opts, url, { workspace: scratch, owner });
    const b = await connect(opts, url, { workspace: scratch, owner: `${owner}_b` });
    try {
      const ca = (await c.okCall(a, "create", { model: MODEL })).conversation as { id: string };
      const cb = (await c.okCall(b, "create", { model: MODEL })).conversation as { id: string };
      const out = await c.okCall(a, "delete_workspace", {});
      eq(
        (out.deleted as Array<{ id: string }>).map((d) => d.id).sort(),
        [ca.id, cb.id].sort(),
        "deleted",
      );
      eq((await c.okCall(b, "get", { id: cb.id })).conversation, null, "gone");
      eq((await c.okCall(a, "delete_workspace", {})).deleted, [], "idempotent");
    } finally {
      await a.close();
      await b.close();
    }
  });
}

/** Runs the records role's cases; returns the conversation it seeded, for the app role. */
async function recordsSuite(
  opts: RunnerOptions,
  results: CaseResult[],
): Promise<string | undefined> {
  const url = opts.records as string;
  const h = harness("records", opts, results);
  const workspace = opts.workspace as string;
  const owner = opts.owner as string;
  const rec = await connect(opts, url, { workspace, owner });
  const okCall = async (conn: Conn, tool: string, args: Record<string, unknown>) => {
    const out = ok(await conn.call(tool, args));
    validateOutput("records", tool, out);
    return out;
  };
  const c: RecordsCtx = { h, rec, okCall, fixtureText: opts.fixtureText ?? "otters", id: "" };
  const absentWs =
    workspace === "ws_ffffffffffffffff" ? "ws_eeeeeeeeeeeeeeee" : "ws_ffffffffffffffff";
  const other = await connect(opts, url, { workspace, owner: `${owner}_other` });
  const elsewhere = await connect(opts, url, { workspace: absentWs, owner });
  try {
    await recordsBasics(c, owner, workspace);
    await recordsWalls(c, other, elsewhere);
    await recordsLifecycle(c);
    await recordsDeleteWorkspace(c, opts, url);
  } finally {
    await Promise.all([rec.close(), other.close(), elsewhere.close()]);
  }
  return c.id || undefined;
}

// ── App role ─────────────────────────────────────────────────────────────

interface AppCtx {
  h: Harness;
  app: Conn;
  prefix: string;
  call(conn: Conn, tool: string, args: Record<string, unknown>): Promise<CallResult>;
  okCall(conn: Conn, tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  listTools(conn: Conn): Promise<ListedTool[]>;
}

async function appSurface(c: AppCtx): Promise<void> {
  const { h, app } = c;
  await h.run("tools/list matches the contract schemas", async () =>
    checkToolList(await c.listTools(app), "app", APP_TOOLS),
  );
  await h.run("read-only tools are annotated readOnlyHint", async () => {
    for (const t of await c.listTools(app)) {
      eq(t.annotations?.readOnlyHint === true, t.name !== "update", `${t.name} readOnlyHint`);
    }
  });
  await h.run(`lists ${UI_URI} as an MCP App`, async () => {
    const { resources } = await app.client.listResources();
    const r = resources.find((x) => x.uri === UI_URI);
    assert(r, `not listed (listed: ${resources.map((x) => x.uri).join(", ") || "none"})`);
    eq(r.mimeType, MCP_APP_MIME, "listed mimeType");
  });
  await h.run(`reads ${UI_URI} as an MCP App`, async () => {
    const read = await app.client.readResource({ uri: UI_URI });
    const first = read.contents[0] as { mimeType?: string; text?: string };
    eq(first.mimeType, MCP_APP_MIME, "read mimeType");
    assert(typeof first.text === "string" && /<html|<!doctype/i.test(first.text), "not HTML");
  });
  await h.run("an unknown resource is a JSON-RPC error", async () => {
    let threw = false;
    try {
      await app.client.readResource({ uri: "ui://conversations/no-such-resource" });
    } catch {
      threw = true;
    }
    assert(threw, "did not throw");
  });
}

async function appErrors(c: AppCtx): Promise<void> {
  const { h, app } = c;
  await h.run("get of an unknown id is conversation_not_found naming it", async () => {
    const e = errorBody(await c.call(app, "get", { id: "conv_0000000000000000" }));
    eq(e.error, `${appPrefix("conversation_not_found")}conv_0000000000000000`, "error");
  });
  await h.run("an omitted id outside a chat is no_current_conversation", async () => {
    const e = errorBody(await c.call(app, "get", {}));
    assert(String(e.error).startsWith(appPrefix("no_current_conversation")), `error ${e.error}`);
  });
  await h.run("invalid arguments are invalid_input, refused before the handler", async () => {
    const e = errorBody(await c.call(app, "update", {}));
    assert(String(e.error).startsWith(`${appPrefix("invalid_input")}"update"`), `error ${e.error}`);
  });
}

async function appScopeCases(c: AppCtx, opts: RunnerOptions, fixture: string | undefined) {
  const { h } = c;
  const url = opts.app as string;
  const names = [
    "tools/call with no workspace in scope is scope_missing",
    "another owner's list does not show the caller's conversations",
    "the conversation in scope is the one an omitted id names",
  ] as const;
  if ((opts.scopeCarriage ?? "none") === "none") {
    for (const n of names) h.skip(n, "scope carriage none: the connection fixes one scope");
    return;
  }
  await h.run(names[0], async () => {
    const bare = await connect(opts, url, { owner: opts.owner });
    try {
      const e = errorBody(await c.call(bare, "list", {}));
      assert(String(e.error).startsWith(appPrefix("scope_missing")), `error ${e.error}`);
    } finally {
      await bare.close();
    }
  });
  if (!fixture) {
    h.skip(names[1], "no fixture");
    h.skip(names[2], "no fixture");
    return;
  }
  await h.run(names[1], async () => {
    const other = await connect(opts, url, {
      workspace: opts.workspace,
      owner: `${opts.owner}_other`,
    });
    try {
      const l = await c.okCall(other, "list", { limit: 1000 });
      assert(!(l.conversations as Array<{ id: string }>).some((x) => x.id === fixture), "leaked");
    } finally {
      await other.close();
    }
  });
  await h.run(names[2], async () => {
    const inChat = await connect(opts, url, {
      workspace: opts.workspace,
      owner: opts.owner,
      conversation: fixture,
    });
    try {
      const out = await c.okCall(inChat, "get", { expand: "metadata" });
      eq((out.metadata as { id: string }).id, fixture, "id");
    } finally {
      await inChat.close();
    }
  });
}

async function appData(c: AppCtx, fixture: string, text: string): Promise<void> {
  const { h, app } = c;
  await h.run("list shows the conversation, not active", async () => {
    const out = await c.okCall(app, "list", { limit: 1000 });
    const row = (out.conversations as Array<Record<string, unknown>>).find((x) => x.id === fixture);
    assert(row, "not listed");
    eq(row.active, false, "active");
  });
  await h.run("get returns its messages", async () => {
    const full = await c.okCall(app, "get", { id: fixture, expand: "full" });
    assert(JSON.stringify(full.messages).includes(text), "fixture text missing");
    const meta = await c.okCall(app, "get", { id: fixture, expand: "metadata" });
    eq((meta.metadata as { id: string }).id, fixture, "metadata id");
    await c.okCall(app, "get", { id: fixture });
  });
  await h.run("search finds the fixture text", async () => {
    const out = await c.okCall(app, "search", { query: text });
    assert(
      (out.results as Array<{ id: string }>).some((r) => r.id === fixture),
      "no hit",
    );
  });
  await h.run("export renders markdown and JSON", async () => {
    const md = (await c.okCall(app, "export", { id: fixture, format: "markdown" })).content;
    assert(typeof md === "string" && md.includes(text), "markdown");
    const js = (await c.okCall(app, "export", { id: fixture, format: "json" })).content;
    assert(Array.isArray(JSON.parse(String(js))), "json is not an array");
  });
  await h.run("stats totals the workspace", async () => {
    const out = await c.okCall(app, "stats", { period: "all" });
    assert((out.totalConversations as number) >= 1, "totalConversations");
  });
  await h.run("list pages by opaque cursor without repeats", async () => {
    const seen: string[] = [];
    let cursor: unknown;
    for (let i = 0; i < 1000; i++) {
      const args: Record<string, unknown> = { limit: 1, ...(cursor ? { cursor } : {}) };
      const page = await c.okCall(app, "list", args);
      seen.push(...(page.conversations as Array<{ id: string }>).map((x) => x.id));
      cursor = page.nextCursor;
      if (typeof cursor !== "string") break;
    }
    eq(seen.length, new Set(seen).size, "a conversation was listed twice");
    assert(seen.includes(fixture), "fixture never listed");
  });
  await h.run("update retitles; list shows the new title", async () => {
    const out = await c.okCall(app, "update", { id: fixture, title: "Retitled by conformance" });
    eq(out.title, "Retitled by conformance", "update result");
    const l = await c.okCall(app, "list", { limit: 1000 });
    const row = (l.conversations as Array<Record<string, unknown>>).find((x) => x.id === fixture);
    eq(row?.title, "Retitled by conformance", "list title");
  });
}

async function appSuite(
  opts: RunnerOptions,
  results: CaseResult[],
  seeded: string | undefined,
): Promise<void> {
  const url = opts.app as string;
  const h = harness("app", opts, results);
  const prefix = opts.toolPrefix ?? "";
  const scope = { workspace: opts.workspace, owner: opts.owner };
  const app = await connect(opts, url, scope);
  const call = (conn: Conn, tool: string, args: Record<string, unknown>) =>
    conn.call(`${prefix}${tool}`, args);
  const c: AppCtx = {
    h,
    app,
    prefix,
    call,
    okCall: async (conn, tool, args) => {
      const out = ok(await call(conn, tool, args));
      validateOutput("app", tool, out);
      return out;
    },
    listTools: async (conn) =>
      (await conn.listTools())
        .filter((t) => t.name.startsWith(prefix))
        .map((t) => ({ ...t, name: t.name.slice(prefix.length) })),
  };
  const fixture = opts.fixture ?? seeded;
  try {
    await appSurface(c);
    await appErrors(c);
    await appScopeCases(c, opts, fixture);
    if (fixture) {
      await appData(c, fixture, opts.fixtureText ?? "otters");
    } else {
      h.skip("data cases", "no --fixture and no --records to seed one");
    }
  } finally {
    await app.close();
  }
}

// ── Entry points ─────────────────────────────────────────────────────────

/** Run every case for the roles whose URL is given. */
export async function runConformance(opts: RunnerOptions): Promise<CaseResult[]> {
  if (!opts.app && !opts.records) throw new Error("give --app <url>, --records <url>, or both");
  if ((opts.scopeCarriage ?? "none") !== "none" && (!opts.workspace || !opts.owner)) {
    throw new Error("--workspace and --owner are required unless --scope-carriage is none");
  }
  if (opts.records && (opts.scopeCarriage ?? "none") === "none") {
    throw new Error("the records cases state several scopes: use --scope-carriage headers or meta");
  }
  const results: CaseResult[] = [];
  const seeded = opts.records ? await recordsSuite(opts, results) : undefined;
  if (opts.app) await appSuite(opts, results, seeded);
  return results;
}

function parseArgs(argv: string[]): RunnerOptions {
  const one = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const many = (name: string) =>
    argv.flatMap((a, i) => (a === `--${name}` && argv[i + 1] ? [argv[i + 1] as string] : []));
  const headers: Record<string, string> = {};
  for (const kv of many("header")) {
    const at = kv.indexOf("=");
    if (at <= 0) throw new Error(`--header wants k=v, got ${kv}`);
    headers[kv.slice(0, at)] = kv.slice(at + 1);
  }
  const bearerEnv = one("bearer-env");
  if (bearerEnv) {
    const token = process.env[bearerEnv];
    if (!token) throw new Error(`--bearer-env ${bearerEnv}: the variable is empty`);
    headers.authorization = `Bearer ${token}`;
  }
  const carriage = one("scope-carriage") ?? "none";
  if (carriage !== "none" && carriage !== "headers" && carriage !== "meta") {
    throw new Error(`--scope-carriage must be none, headers or meta, got ${carriage}`);
  }
  return {
    app: one("app"),
    records: one("records"),
    headers,
    scopeCarriage: carriage,
    workspace: one("workspace"),
    owner: one("owner"),
    protocolVersion: one("protocol-version"),
    toolPrefix: one("tool-prefix"),
    fixture: one("fixture"),
    fixtureText: one("fixture-text"),
    scratchWorkspace: one("scratch-workspace"),
    skip: many("skip"),
  };
}

async function main(): Promise<void> {
  let opts: RunnerOptions;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
  opts.log = (line) => process.stdout.write(`${line}\n`);
  let results: CaseResult[];
  try {
    results = await runConformance(opts);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
  const count = (s: CaseStatus) => results.filter((r) => r.status === s).length;
  process.stdout.write(
    `\n${count("pass")} passed, ${count("fail")} failed, ${count("skip")} skipped\n`,
  );
  process.exit(count("fail") > 0 ? 1 : 0);
}

if (import.meta.main) await main();
