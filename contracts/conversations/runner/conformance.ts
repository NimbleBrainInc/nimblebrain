#!/usr/bin/env bun
/**
 * Black-box conformance runner for `ai.nimblebrain.conversations` 1.0.
 *
 * It speaks only MCP (Streamable HTTP) to the URL it is given and reads only
 * the contract's published document
 * (`schemas/contracts/conversations/v1/contract.json`: tools, visibility,
 * schemas, errors). It imports no implementation code, so it checks an
 * implementation in any language.
 *
 *   bun --no-env-file contracts/conversations/runner/conformance.ts \
 *     --server <url> [--public-only] [transport options] [fixture options]
 *
 * Modes.
 *   --server <url>          the implementation's MCP endpoint. Without --public-only
 *                           every tool is checked, public and private, under several
 *                           scopes and both principals; --carriage must be headers or
 *                           meta. An implementation is conformant when this passes.
 *   --public-only           check only the public tools, as a person, and that no
 *                           private tool is listed or answers a call. This is how a
 *                           host's agent-facing surface (its /mcp/<wsId> door) is
 *                           checked: private tools must be absent there.
 *
 * Transport options. These say how this runner reaches an implementation; they
 * are not part of the contract (CONTRACT.md §3: scope and principal are carried
 * by the call's authenticated context, and how is the transport's business).
 *   --header <k=v>          an extra header on every request (repeatable)
 *   --bearer-env <VAR>      send `Authorization: Bearer $VAR`; the value is never printed
 *   --carriage <c>          how this runner states each call's scope and principal:
 *                             none     the connection itself fixes both (a URL and a
 *                                      credential, such as a runtime's /mcp/<wsId>,
 *                                      whose principal is a person); the default. Cases
 *                                      that need a second scope skip. --public-only only.
 *                             headers  x-nb-workspace-id / x-nb-owner-id /
 *                                      x-nb-conversation-id / x-nb-principal headers
 *                             meta     params._meta["ai.nimblebrain/scope"] =
 *                                      { workspaceId, ownerId, conversationId?, principal }
 *   --workspace <id>        the scope's workspace (required unless carriage is none)
 *   --owner <id>            the scope's owner (required unless carriage is none)
 *   --protocol-version <v>  pin this MCP revision instead of negotiating
 *   --tool-prefix <p>       the tools are listed as <p><tool> (a runtime's /mcp/<wsId>
 *                           lists them as conversations__<tool> beside other tools);
 *                           only tools with the prefix are judged
 *
 * Fixture options.
 *   --fixture <convId>      a conversation already in scope whose user messages
 *                           contain --fixture-text; with --public-only and without
 *                           it, the data cases skip (the full run seeds its own)
 *   --fixture-text <text>   default "otters"
 *   --scratch-workspace <id>  a disposable workspace for delete_workspace
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

export type Carriage = "none" | "headers" | "meta";
export type Principal = "host" | "person";

export interface RunnerOptions {
  server?: string;
  publicOnly?: boolean;
  headers?: Record<string, string>;
  carriage?: Carriage;
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
  name: string;
  status: CaseStatus;
  detail?: string;
}

// ── The contract's files ─────────────────────────────────────────────────

const CONTRACT_PATH = resolve(
  import.meta.dir,
  "../../../schemas/contracts/conversations/v1/contract.json",
);
const SCOPE_META_KEY = "ai.nimblebrain/scope";
const UI_URI = "ui://conversations/browser";
const MCP_APP_MIME = "text/html;profile=mcp-app";
const MODEL = "anthropic:claude-sonnet-5-5";
const ABSENT_ID = "conv_0000000000000000";

interface SchemaRef {
  $ref: string;
}
interface ContractDocument {
  $id: string;
  tools: Record<string, { visibility: "public" | "private"; input: SchemaRef; output: SchemaRef }>;
  errors: {
    public: Array<{ code: string; prefix: string }>;
    private: Array<{ code: string }>;
  };
  $defs: Record<string, Record<string, unknown>>;
}
const CONTRACT = JSON.parse(readFileSync(CONTRACT_PATH, "utf-8")) as ContractDocument;
const toolsOf = (visibility: "public" | "private") =>
  Object.entries(CONTRACT.tools)
    .filter(([, t]) => t.visibility === visibility)
    .map(([name]) => name);

export const PUBLIC_TOOLS: readonly string[] = toolsOf("public");
export const PRIVATE_TOOLS: readonly string[] = toolsOf("private");

const PRIVATE_CODES = new Set(CONTRACT.errors.private.map((e) => e.code));

function publicPrefix(code: string): string {
  const entry = CONTRACT.errors.public.find((e) => e.code === code);
  if (!entry) throw new Error(`the contract has no public error "${code}"`);
  return entry.prefix;
}

/** Resolve a `$ref` local to the document (`#/<json pointer>`). */
function resolveRef(ref: string): Record<string, unknown> {
  if (!ref.startsWith("#/")) throw new Error(`unsupported $ref ${ref}`);
  let node: unknown = CONTRACT;
  for (const raw of ref.slice(2).split("/")) {
    const token = decodeURIComponent(raw).replaceAll("~1", "/").replaceAll("~0", "~");
    node = (node as Record<string, unknown> | undefined)?.[token];
  }
  if (!node || typeof node !== "object") throw new Error(`$ref ${ref} resolves to nothing`);
  return node as Record<string, unknown>;
}

function refOf(tool: string, kind: "input" | "output"): string {
  const entry = CONTRACT.tools[tool];
  if (!entry) throw new Error(`the contract has no tool "${tool}"`);
  return entry[kind].$ref;
}

/**
 * A tool's input or output schema: the `$defs` entry its `$ref` names, which is the schema
 * exactly as it travels in tools/list.
 */
export function contractSchema(tool: string, kind: "input" | "output"): Record<string, unknown> {
  return resolveRef(refOf(tool, kind));
}

// Each `$defs` entry is self-contained (no `$ref` of its own), so it compiles alone. The whole
// document does not go to Ajv: Ajv reads a root `id` as draft-04's schema id and refuses it.
const ajv = new Ajv2020({ strict: false, allErrors: true });
const validators = new Map<string, ReturnType<typeof ajv.compile>>();
function validateOutput(tool: string, value: unknown): void {
  let validate = validators.get(tool);
  if (!validate) {
    validate = ajv.compile(contractSchema(tool, "output"));
    validators.set(tool, validate);
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

/** The authenticated context one connection's calls carry. */
interface Context {
  workspace?: string;
  owner?: string;
  conversation?: string;
  principal?: Principal;
}

interface CallResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: Array<{ type: string; text?: string }>;
}

export interface ListedTool {
  name: string;
  description?: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean };
}

/** One MCP connection under one context, as this runner's transport options carry it. */
interface Conn {
  /** Calls a contract tool by its contract name; the tool prefix is added here. */
  call(tool: string, args: Record<string, unknown>): Promise<CallResult>;
  /** The prefixed tools, named without the prefix. */
  listTools(): Promise<ListedTool[]>;
  client: Client;
  close(): Promise<void>;
}

function contextHeaders(carriage: Carriage, ctx: Context): Record<string, string> {
  if (carriage !== "headers") return {};
  const h: Record<string, string> = {};
  if (ctx.workspace) h["x-nb-workspace-id"] = ctx.workspace;
  if (ctx.owner) h["x-nb-owner-id"] = ctx.owner;
  if (ctx.conversation) h["x-nb-conversation-id"] = ctx.conversation;
  if (ctx.principal) h["x-nb-principal"] = ctx.principal;
  return h;
}

function contextMeta(carriage: Carriage, ctx: Context): Record<string, unknown> | undefined {
  if (carriage !== "meta") return undefined;
  return {
    [SCOPE_META_KEY]: {
      ...(ctx.workspace ? { workspaceId: ctx.workspace } : {}),
      ...(ctx.owner ? { ownerId: ctx.owner } : {}),
      ...(ctx.conversation ? { conversationId: ctx.conversation } : {}),
      ...(ctx.principal ? { principal: ctx.principal } : {}),
    },
  };
}

async function connect(opts: RunnerOptions, ctx: Context): Promise<Conn> {
  const carriage = opts.carriage ?? "none";
  const prefix = opts.toolPrefix ?? "";
  const headers = { ...(opts.headers ?? {}), ...contextHeaders(carriage, ctx) };
  const meta = contextMeta(carriage, ctx);
  const client = new Client(
    { name: "conversations-contract-conformance", version: "1.0.0" },
    {
      versionNegotiation: { mode: opts.protocolVersion ? { pin: opts.protocolVersion } : "auto" },
    },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(opts.server as string), {
      fetch: (input, init) => {
        const h = new Headers(init?.headers);
        for (const [k, v] of Object.entries(headers)) h.set(k, v);
        return fetch(input, { ...init, headers: h });
      },
    }),
  );
  return {
    client,
    call: async (tool, args) =>
      (await client.callTool({
        name: `${prefix}${tool}`,
        arguments: args,
        ...(meta ? { _meta: meta } : {}),
      })) as CallResult,
    listTools: async () =>
      ((await client.listTools()).tools as ListedTool[])
        .filter((t) => t.name.startsWith(prefix))
        .map((t) => ({ ...t, name: t.name.slice(prefix.length) })),
    close: () => client.close(),
  };
}

/** A success's payload, checked against the tool's output schema. */
async function okCall(
  conn: Conn,
  tool: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const r = await conn.call(tool, args);
  if (r.isError) throw new Error(`${tool}: tool error: ${r.content?.[0]?.text}`);
  assert(r.structuredContent, `${tool}: no structuredContent`);
  validateOutput(tool, r.structuredContent);
  return r.structuredContent;
}
function errorBody(r: CallResult): { code?: string; error?: string } {
  assert(r.isError === true, `expected isError, got ${JSON.stringify(r).slice(0, 200)}`);
  return JSON.parse(r.content?.[0]?.text ?? "{}") as { code?: string; error?: string };
}
/** A private tool's error code, which must be in `errors.private` in the contract. */
function privateCode(r: CallResult): string | undefined {
  const { code } = errorBody(r);
  assert(
    code && PRIVATE_CODES.has(code),
    `code ${String(code)} is not in the contract's errors.private`,
  );
  return code;
}
/**
 * A public error whose text begins with the prefix of `kind`. Its `code` is checked once, by
 * "public errors carry their code", so a host whose errors only lack the code fails one case.
 */
function expectPublicError(r: CallResult, kind: string, rest = ""): void {
  const { error } = errorBody(r);
  assert(String(error).startsWith(`${publicPrefix(kind)}${rest}`), `error ${error}`);
}

// ── Harness ──────────────────────────────────────────────────────────────

interface Harness {
  results: CaseResult[];
  run(name: string, fn: () => Promise<void>): Promise<void>;
  skip(name: string, why: string): void;
}

function harness(opts: RunnerOptions, results: CaseResult[]): Harness {
  const log = opts.log ?? (() => {});
  const record = (r: CaseResult) => {
    results.push(r);
    const tag = r.status === "pass" ? "ok  " : r.status === "fail" ? "FAIL" : "skip";
    log(`${tag}  ${r.name}${r.detail ? ` (${r.detail})` : ""}`);
  };
  return {
    results,
    async run(name, fn) {
      if ((opts.skip ?? []).some((t) => name.includes(t))) {
        record({ name, status: "skip", detail: "--skip" });
        return;
      }
      try {
        await fn();
        record({ name, status: "pass" });
      } catch (err) {
        record({ name, status: "fail", detail: err instanceof Error ? err.message : String(err) });
      }
    },
    skip(name, why) {
      record({ name, status: "skip", detail: why });
    },
  };
}

/**
 * Every named contract tool is listed with the contract's schemas. A server MAY serve more than
 * the contract (CONTRACT.md §1), so tools outside it are neither required nor checked.
 */
export function checkToolList(tools: ListedTool[], names: readonly string[]): void {
  const listed = new Set(tools.map((t) => t.name));
  const missing = names.filter((n) => !listed.has(n));
  assert(missing.length === 0, `missing contract tools: ${missing.join(", ")}`);
  const contractNames = new Set(names);
  for (const t of tools.filter((x) => contractNames.has(x.name))) {
    eq(t.inputSchema, contractSchema(t.name, "input"), `${t.name} inputSchema`);
    eq(t.outputSchema, contractSchema(t.name, "output"), `${t.name} outputSchema`);
    assert(t.description && t.description.length > 0, `${t.name} has no description`);
  }
}

/** None of the named tools is listed: a host's agent-facing surface hides the private tools. */
export function checkAbsent(tools: ListedTool[], names: readonly string[]): void {
  const hidden = new Set(names);
  const shown = tools.filter((t) => hidden.has(t.name)).map((t) => t.name);
  assert(shown.length === 0, `private tools listed: ${shown.join(", ")}`);
}

/**
 * A cursor walk never repeats a conversation and never skips one that existed when the first
 * page was read (CONTRACT.md §4). Conversations created later are not constrained.
 */
export function checkCursorWalk(seen: readonly string[], existing: readonly string[]): void {
  eq(seen.length, new Set(seen).size, "a conversation was listed twice");
  for (const id of existing) assert(seen.includes(id), `${id} skipped`);
}

// ── The whole contract: private tools, and public tools as the host reads them ──

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

interface FullCtx {
  h: Harness;
  opts: RunnerOptions;
  /** The host, in the runner's scope. */
  host: Conn;
  /** A person, in the runner's scope. */
  person: Conn;
  fixtureText: string;
  /** The conversation the full run seeds; the public cases read it. */
  id: string;
}

const createdId = async (conn: Conn): Promise<string> =>
  String(((await okCall(conn, "create", { model: MODEL })).conversation as { id: string }).id);

async function fullBasics(c: FullCtx): Promise<void> {
  const { h, host, opts } = c;
  await h.run("tools/list as host matches the contract schemas", async () =>
    checkToolList(await host.listTools(), [...PUBLIC_TOOLS, ...PRIVATE_TOOLS]),
  );
  await h.run("create in scope", async () => {
    const out = await okCall(host, "create", { model: MODEL, metadata: { source: "conformance" } });
    const conv = out.conversation as Record<string, unknown>;
    assert(/^conv_[0-9a-f]{16}$/.test(String(conv.id)), `id ${String(conv.id)}`);
    eq(
      [conv.ownerId, conv.workspaceId, conv.model, conv.title],
      [opts.owner, opts.workspace, MODEL, null],
      "fields",
    );
    c.id = String(conv.id);
  });
  await h.run("create with a taken id is conversation_exists", async () => {
    eq(
      privateCode(await host.call("create", { id: c.id, model: MODEL })),
      "conversation_exists",
      "code",
    );
  });
  await h.run(
    "append numbers events 1..n per conversation, gapless, batches never split",
    async () => {
      const first = await okCall(host, "append_events", {
        id: c.id,
        events: turn(`hello ${c.fixtureText}`, "hi", 0, "run_a"),
      });
      eq(first.lastSeq, 4, "first batch");
      const second = await okCall(host, "append_events", {
        id: c.id,
        events: turn("second", "again", 10, "run_b"),
      });
      eq(second.lastSeq, 8, "second batch");
      eq((await okCall(host, "append_events", { id: c.id, events: [] })).lastSeq, 8, "empty");
      const all = await okCall(host, "events", { id: c.id });
      const rows = all.events as Array<{ seq: number; event: { type: string } }>;
      eq(
        rows.map((e) => e.seq),
        [1, 2, 3, 4, 5, 6, 7, 8],
        "seqs",
      );
      eq(all.lastSeq, 8, "lastSeq");
      eq(rows[4]?.event.type, "user.message", "order");
    },
  );
  await h.run("events pages by afterSeq, limit and throughSeq", async () => {
    const p = await okCall(host, "events", { id: c.id, afterSeq: 2, limit: 3 });
    eq(
      (p.events as Array<{ seq: number }>).map((e) => e.seq),
      [3, 4, 5],
      "page",
    );
    eq(p.lastSeq, 8, "lastSeq");
    const q = await okCall(host, "events", { id: c.id, afterSeq: 5, throughSeq: 6 });
    eq(
      (q.events as Array<{ seq: number }>).map((e) => e.seq),
      [6],
      "bounded",
    );
  });
  await h.run("append to an unknown id is conversation_not_found", async () => {
    const r = await host.call("append_events", { id: ABSENT_ID, events: turn("x", "y", 0, "r") });
    eq(privateCode(r), "conversation_not_found", "code");
  });
  await h.run("invalid input is invalid_input", async () => {
    eq(privateCode(await host.call("append_events", { id: c.id })), "invalid_input", "code");
  });
  await h.run("an unknown tool is unknown_tool", async () => {
    expectPublicError(await host.call("no_such_tool", {}), "unknown_tool");
  });
}

/** Each private tool refuses a person with `forbidden`, and the host sees nothing changed. */
/**
 * The answer a private tool gives a caller that is not `host`: `forbidden`, whatever else is
 * wrong with the call, since the principal is checked before the input and the scope
 * (CONTRACT.md §3). Throws on any other answer, including a success.
 */
export function expectForbidden(r: CallResult, what: string): void {
  if (r.isError !== true) throw new Error(`${what}: a non-host call succeeded`);
  const { code } = JSON.parse(r.content?.[0]?.text ?? "{}") as { code?: string };
  if (code !== "forbidden") throw new Error(`${what}: code ${String(code)}, want forbidden`);
}

async function withConn<T>(
  opts: RunnerOptions,
  ctx: Context,
  fn: (conn: Conn) => Promise<T>,
): Promise<T> {
  const conn = await connect(opts, ctx);
  try {
    return await fn(conn);
  } finally {
    await conn.close();
  }
}

async function fullForbidden(c: FullCtx): Promise<void> {
  const { h, host, person, opts } = c;
  const scope = { workspace: opts.workspace, owner: opts.owner };
  await h.run(
    "every private tool answers a person with forbidden and changes nothing",
    async () => {
      const before = (await okCall(host, "list", { limit: 1 })).totalCount;
      expectForbidden(await person.call("create", { model: MODEL }), "create");
      expectForbidden(await person.call("events", { id: c.id }), "events");
      const append = { id: c.id, events: turn("intruder", "no", 100, "run_x") };
      expectForbidden(await person.call("append_events", append), "append_events");
      expectForbidden(await person.call("delete", { id: c.id }), "delete");
      eq((await okCall(host, "list", { limit: 1 })).totalCount, before, "conversation count");
      eq((await okCall(host, "events", { id: c.id, afterSeq: 8 })).lastSeq, 8, "lastSeq");
      await okCall(host, "get", { id: c.id, expand: "metadata" });
    },
  );
  await h.run("a call that names no principal is not host", () =>
    withConn(opts, scope, async (anon) => {
      expectForbidden(await anon.call("create", { model: MODEL }), "create");
      expectForbidden(await anon.call("events", { id: c.id }), "events");
    }),
  );
  await h.run("forbidden comes before the input and the scope", async () => {
    expectForbidden(await person.call("create", {}), "create with invalid input");
    expectForbidden(await person.call("events", { id: 42 }), "events with invalid input");
    await withConn(opts, { owner: opts.owner, principal: "person" }, async (unscoped) => {
      expectForbidden(await unscoped.call("create", { model: MODEL }), "create with no workspace");
    });
  });
  const name = "delete_workspace answers a person with forbidden and deletes nothing";
  if (!opts.scratchWorkspace) {
    h.skip(name, "no --scratch-workspace to try it in");
    return;
  }
  await h.run(name, async () => {
    const scratch = { workspace: opts.scratchWorkspace, owner: opts.owner };
    await withConn(opts, { ...scratch, principal: "host" }, async (scratchHost) => {
      const made = (await okCall(scratchHost, "create", { model: MODEL })).conversation as {
        id: string;
      };
      try {
        await withConn(opts, { ...scratch, principal: "person" }, async (scratchPerson) => {
          expectForbidden(await scratchPerson.call("delete_workspace", {}), "delete_workspace");
        });
        await okCall(scratchHost, "get", { id: made.id, expand: "metadata" });
      } finally {
        await scratchHost.call("delete", { id: made.id });
      }
    });
  });
}

async function fullWalls(c: FullCtx, other: Conn, elsewhere: Conn): Promise<void> {
  const { h } = c;
  await h.run("another owner and another workspace see nothing", async () => {
    for (const [conn, who] of [
      [other, "other owner"],
      [elsewhere, "other workspace"],
    ] as const) {
      expectPublicError(await conn.call("get", { id: c.id }), "conversation_not_found", c.id);
      eq((await okCall(conn, "events", { id: c.id })).events, [], `${who} events`);
    }
    eq(
      privateCode(await other.call("append_events", { id: c.id, events: [] })),
      "conversation_not_found",
      "other owner append",
    );
    const l = await okCall(other, "list", { limit: 200 });
    assert(
      !(l.conversations as Array<{ id: string }>).some((s) => s.id === c.id),
      "listed to another owner",
    );
    const s = await okCall(other, "search", { query: c.fixtureText });
    assert(
      !(s.results as Array<{ id: string }>).some((x) => x.id === c.id),
      "found by another owner",
    );
    eq((await okCall(other, "delete", { id: c.id })).deleted, false, "other owner delete");
  });
  await h.run("create in a workspace with nothing stored is workspace_not_found", async () => {
    eq(
      privateCode(await elsewhere.call("create", { model: MODEL })),
      "workspace_not_found",
      "code",
    );
  });
}

async function fullLifecycle(c: FullCtx): Promise<void> {
  const { h, host } = c;
  await h.run("update records a title as an event; get projects it", async () => {
    eq((await okCall(host, "update", { id: c.id, title: "Conformance" })).title, "Conformance", "");
    const e = await okCall(host, "events", { id: c.id, afterSeq: 8 });
    eq((e.events as Array<{ event: { type: string } }>)[0]?.event.type, "metadata.title", "event");
    const got = await okCall(host, "get", { id: c.id, expand: "metadata" });
    eq((got.metadata as { title: unknown }).title, "Conformance", "get title");
  });
  await h.run("list and search find it", async () => {
    const l = await okCall(host, "list", { limit: 200 });
    const row = (l.conversations as Array<Record<string, unknown>>).find((s) => s.id === c.id);
    assert(row, "not listed");
    eq([row.title, row.messageCount], ["Conformance", 4], "row");
    const s = await okCall(host, "search", { query: c.fixtureText });
    assert(
      (s.results as Array<{ id: string }>).some((x) => x.id === c.id),
      "not found by search",
    );
  });
  await h.run("a list cursor is stable under inserts: no repeats, no skips", async () => {
    const made: string[] = [];
    for (let i = 0; i < 3; i++) made.push(await createdId(host));
    const first = await okCall(host, "list", { limit: 2, sortBy: "created" });
    assert(typeof first.nextCursor === "string", "no nextCursor on a partial page");
    const inserted = await createdId(host);
    const seen = (first.conversations as Array<{ id: string }>).map((x) => x.id);
    let next: unknown = first.nextCursor;
    while (typeof next === "string") {
      const page = await okCall(host, "list", { limit: 2, sortBy: "created", cursor: next });
      seen.push(...(page.conversations as Array<{ id: string }>).map((x) => x.id));
      next = page.nextCursor;
    }
    // A conversation created after the first page MAY appear or be absent (CONTRACT.md §4).
    checkCursorWalk(seen, [...made, c.id]);
    for (const id of [...made, inserted]) await okCall(host, "delete", { id });
  });
  await h.run("delete removes it; a second delete answers false", async () => {
    const temp = await createdId(host);
    eq((await okCall(host, "delete", { id: temp })).deleted, true, "delete");
    expectPublicError(await host.call("get", { id: temp }), "conversation_not_found", temp);
    eq((await okCall(host, "delete", { id: temp })).deleted, false, "again");
  });
}

async function fullDeleteWorkspace(c: FullCtx): Promise<void> {
  const { opts } = c;
  const scratch = opts.scratchWorkspace;
  if (!scratch) {
    c.h.skip("delete_workspace removes every owner's conversations", "no --scratch-workspace");
    return;
  }
  await c.h.run("delete_workspace removes every owner's conversations", async () => {
    const owner = opts.owner as string;
    const a = await connect(opts, { workspace: scratch, owner, principal: "host" });
    const b = await connect(opts, { workspace: scratch, owner: `${owner}_b`, principal: "host" });
    try {
      const ids = [await createdId(a), await createdId(b)];
      const out = await okCall(a, "delete_workspace", {});
      eq((out.deleted as Array<{ id: string }>).map((d) => d.id).sort(), ids.sort(), "deleted");
      eq((await okCall(b, "events", { id: ids[1] })).events, [], "gone");
      eq((await okCall(a, "delete_workspace", {})).deleted, [], "idempotent");
    } finally {
      await a.close();
      await b.close();
    }
  });
}

/** Runs the cases only the whole contract can state; returns the conversation it seeded. */
async function fullSuite(h: Harness, opts: RunnerOptions): Promise<string | undefined> {
  const workspace = opts.workspace as string;
  const owner = opts.owner as string;
  const absentWs =
    workspace === "ws_ffffffffffffffff" ? "ws_eeeeeeeeeeeeeeee" : "ws_ffffffffffffffff";
  const [host, person, other, elsewhere] = await Promise.all([
    connect(opts, { workspace, owner, principal: "host" }),
    connect(opts, { workspace, owner, principal: "person" }),
    connect(opts, { workspace, owner: `${owner}_other`, principal: "host" }),
    connect(opts, { workspace: absentWs, owner, principal: "host" }),
  ]);
  const c: FullCtx = { h, opts, host, person, fixtureText: opts.fixtureText ?? "otters", id: "" };
  try {
    await fullBasics(c);
    await fullForbidden(c);
    await fullWalls(c, other, elsewhere);
    await fullLifecycle(c);
    await fullDeleteWorkspace(c);
  } finally {
    await Promise.all([host, person, other, elsewhere].map((x) => x.close()));
  }
  return c.id || undefined;
}

// ── Public tools, as a person ────────────────────────────────────────────

async function publicSurface(h: Harness, opts: RunnerOptions, conn: Conn): Promise<void> {
  await h.run("tools/list matches the public tools' schemas", async () =>
    checkToolList(await conn.listTools(), PUBLIC_TOOLS),
  );
  if (opts.publicOnly) {
    await h.run("no private tool is listed", async () =>
      checkAbsent(await conn.listTools(), PRIVATE_TOOLS),
    );
    await h.run("a private tool called here is refused", async () => {
      let refused = false;
      try {
        refused = (await conn.call("events", { id: opts.fixture ?? ABSENT_ID })).isError === true;
      } catch {
        refused = true; // a JSON-RPC error refuses too
      }
      assert(refused, "events answered");
    });
  }
  await h.run("read-only tools are annotated readOnlyHint", async () => {
    const contract = new Set<string>(PUBLIC_TOOLS);
    for (const t of (await conn.listTools()).filter((x) => contract.has(x.name))) {
      eq(t.annotations?.readOnlyHint === true, t.name !== "update", `${t.name} readOnlyHint`);
    }
  });
  await h.run(`lists ${UI_URI} as an MCP App`, async () => {
    const { resources } = await conn.client.listResources();
    const r = resources.find((x) => x.uri === UI_URI);
    assert(r, `not listed (listed: ${resources.map((x) => x.uri).join(", ") || "none"})`);
    eq(r.mimeType, MCP_APP_MIME, "listed mimeType");
  });
  await h.run(`reads ${UI_URI} as an MCP App`, async () => {
    const read = await conn.client.readResource({ uri: UI_URI });
    const first = read.contents[0] as { mimeType?: string; text?: string };
    eq(first.mimeType, MCP_APP_MIME, "read mimeType");
    assert(typeof first.text === "string" && /<html|<!doctype/i.test(first.text), "not HTML");
  });
  await h.run("an unknown resource is a JSON-RPC error", async () => {
    let threw = false;
    try {
      await conn.client.readResource({ uri: "ui://conversations/no-such-resource" });
    } catch {
      threw = true;
    }
    assert(threw, "did not throw");
  });
}

async function publicErrors(h: Harness, conn: Conn): Promise<void> {
  await h.run("get of an unknown id is conversation_not_found naming it", async () => {
    const e = errorBody(await conn.call("get", { id: ABSENT_ID }));
    eq(e.error, `${publicPrefix("conversation_not_found")}${ABSENT_ID}`, "error");
  });
  await h.run("an omitted id outside a chat is no_current_conversation", async () => {
    expectPublicError(await conn.call("get", {}), "no_current_conversation");
  });
  await h.run("invalid arguments are invalid_input, refused before the handler", async () => {
    expectPublicError(await conn.call("update", {}), "invalid_input", '"update"');
  });
  await h.run("public errors carry their code", async () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["get", { id: ABSENT_ID }, "conversation_not_found"],
      ["get", {}, "no_current_conversation"],
      ["update", {}, "invalid_input"],
    ];
    for (const [tool, args, code] of cases) {
      const got = errorBody(await conn.call(tool, args)).code;
      assert(got === code, `${tool} code: got ${String(got)} want ${code}`);
    }
  });
}

const SCOPE_CASES = [
  "tools/call with no workspace in scope is scope_missing",
  "another owner's list does not show the caller's conversations",
  "the conversation in scope is the one an omitted id names",
] as const;

async function publicScopeCases(h: Harness, opts: RunnerOptions, fixture: string | undefined) {
  if ((opts.carriage ?? "none") === "none") {
    for (const n of SCOPE_CASES) h.skip(n, "carriage none: the connection fixes one scope");
    return;
  }
  const as = async (ctx: Context, fn: (conn: Conn) => Promise<void>) => {
    const conn = await connect(opts, { ...ctx, principal: "person" });
    try {
      await fn(conn);
    } finally {
      await conn.close();
    }
  };
  await h.run(SCOPE_CASES[0], () =>
    as({ owner: opts.owner }, async (bare) =>
      expectPublicError(await bare.call("list", {}), "scope_missing"),
    ),
  );
  if (!fixture) {
    h.skip(SCOPE_CASES[1], "no fixture");
    h.skip(SCOPE_CASES[2], "no fixture");
    return;
  }
  await h.run(SCOPE_CASES[1], () =>
    as({ workspace: opts.workspace, owner: `${opts.owner}_other` }, async (other) => {
      const l = await okCall(other, "list", { limit: 1000 });
      assert(!(l.conversations as Array<{ id: string }>).some((x) => x.id === fixture), "leaked");
    }),
  );
  await h.run(SCOPE_CASES[2], () =>
    as({ workspace: opts.workspace, owner: opts.owner, conversation: fixture }, async (inChat) => {
      const out = await okCall(inChat, "get", { expand: "metadata" });
      eq((out.metadata as { id: string }).id, fixture, "id");
    }),
  );
}

async function publicData(h: Harness, conn: Conn, fixture: string, text: string): Promise<void> {
  await h.run("list shows the conversation, not active", async () => {
    const out = await okCall(conn, "list", { limit: 1000 });
    const row = (out.conversations as Array<Record<string, unknown>>).find((x) => x.id === fixture);
    assert(row, "not listed");
    eq(row.active, false, "active");
  });
  await h.run("get returns its messages", async () => {
    const full = await okCall(conn, "get", { id: fixture, expand: "full" });
    assert(JSON.stringify(full.messages).includes(text), "fixture text missing");
    const meta = await okCall(conn, "get", { id: fixture, expand: "metadata" });
    eq((meta.metadata as { id: string }).id, fixture, "metadata id");
    await okCall(conn, "get", { id: fixture });
  });
  await h.run("search finds the fixture text", async () => {
    const out = await okCall(conn, "search", { query: text });
    assert(
      (out.results as Array<{ id: string }>).some((r) => r.id === fixture),
      "no hit",
    );
  });
  await h.run("export renders markdown and JSON", async () => {
    const md = (await okCall(conn, "export", { id: fixture, format: "markdown" })).content;
    assert(typeof md === "string" && md.includes(text), "markdown");
    const js = (await okCall(conn, "export", { id: fixture, format: "json" })).content;
    assert(Array.isArray(JSON.parse(String(js))), "json is not an array");
  });
  await h.run("stats totals the workspace", async () => {
    const out = await okCall(conn, "stats", { period: "all" });
    assert((out.totalConversations as number) >= 1, "totalConversations");
  });
  await h.run("list pages by opaque cursor without repeats", async () => {
    const seen: string[] = [];
    let cursor: unknown;
    for (let i = 0; i < 1000; i++) {
      const args: Record<string, unknown> = { limit: 1, ...(cursor ? { cursor } : {}) };
      const page = await okCall(conn, "list", args);
      seen.push(...(page.conversations as Array<{ id: string }>).map((x) => x.id));
      cursor = page.nextCursor;
      if (typeof cursor !== "string") break;
    }
    eq(seen.length, new Set(seen).size, "a conversation was listed twice");
    assert(seen.includes(fixture), "fixture never listed");
  });
  await h.run("update retitles; list shows the new title", async () => {
    const out = await okCall(conn, "update", { id: fixture, title: "Retitled by conformance" });
    eq(out.title, "Retitled by conformance", "update result");
    const l = await okCall(conn, "list", { limit: 1000 });
    const row = (l.conversations as Array<Record<string, unknown>>).find((x) => x.id === fixture);
    eq(row?.title, "Retitled by conformance", "list title");
  });
}

async function publicSuite(
  h: Harness,
  opts: RunnerOptions,
  seeded: string | undefined,
): Promise<void> {
  const conn = await connect(opts, {
    workspace: opts.workspace,
    owner: opts.owner,
    principal: "person",
  });
  const fixture = opts.fixture ?? seeded;
  try {
    await publicSurface(h, opts, conn);
    await publicErrors(h, conn);
    await publicScopeCases(h, opts, fixture);
    if (fixture) await publicData(h, conn, fixture, opts.fixtureText ?? "otters");
    else h.skip("data cases", "no --fixture");
  } finally {
    await conn.close();
  }
}

// ── Entry points ─────────────────────────────────────────────────────────

/** Run every case the options allow: the whole contract, or with `publicOnly` the public tools. */
export async function runConformance(opts: RunnerOptions): Promise<CaseResult[]> {
  if (!opts.server) throw new Error("give --server <url>");
  const carriage = opts.carriage ?? "none";
  if (carriage !== "none" && (!opts.workspace || !opts.owner)) {
    throw new Error("--workspace and --owner are required unless --carriage is none");
  }
  if (!opts.publicOnly && carriage === "none") {
    throw new Error(
      "the whole contract states several scopes and both principals: use --carriage headers " +
        "or meta, or check a host's door with --public-only",
    );
  }
  const results: CaseResult[] = [];
  const h = harness(opts, results);
  const seeded = opts.publicOnly ? undefined : await fullSuite(h, opts);
  await publicSuite(h, opts, seeded);
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
  const carriage = one("carriage") ?? "none";
  if (carriage !== "none" && carriage !== "headers" && carriage !== "meta") {
    throw new Error(`--carriage must be none, headers or meta, got ${carriage}`);
  }
  return {
    server: one("server"),
    publicOnly: argv.includes("--public-only"),
    headers,
    carriage,
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
