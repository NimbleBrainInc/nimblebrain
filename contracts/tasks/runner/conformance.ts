#!/usr/bin/env bun
/**
 * Black-box conformance runner for `ai.nimblebrain.tasks` 1.0.
 *
 * It speaks only MCP (Streamable HTTP) to the URL it is given and reads only the contract's
 * published document (`schemas/contracts/tasks/v1/contract.json`: tools, visibility,
 * unattended and grant marking, schemas, errors). It imports no implementation code, so it
 * checks an implementation in any language.
 *
 *   bun --no-env-file contracts/tasks/runner/conformance.ts \
 *     --server <url> [--public-only] [transport options] [scope options]
 *
 * The runner plays the host. It states the host context on every call, stamps an opaque run
 * grant on a person's call to every tool the document marks `grant: true` (a different
 * string per definition and per call where a case needs to tell them apart), and it is the
 * host's clock: every `now` and `until` it sends, and every instant in an outcome, comes
 * from a fake clock that starts on 2031-03-01T00:00:00Z, never from the wall clock, so a
 * decision an implementation takes on its own clock shows.
 *
 * Modes.
 *   --server <url>          the implementation's MCP endpoint. Without --public-only every
 *                           tool is checked, public and private, under several scopes and
 *                           both principals; --carriage must be meta. An implementation is
 *                           conformant when this passes.
 *   --public-only           check only the public tools, as a person, and that no private
 *                           tool is listed or answers a call: how a host's agent-facing door
 *                           (its /mcp/<wsId>) is checked.
 *
 * Transport options. These say how this runner reaches an implementation; they are not part
 * of the contract.
 *   --header <k=v>          an extra header on every request (repeatable), such as the
 *                           host's credential for an HTTP server
 *   --bearer-env <VAR>      send `Authorization: Bearer $VAR`; the value is never printed
 *   --carriage <c>          how each call's scope and principal are stated:
 *                             none   the connection fixes both (a runtime's /mcp/<wsId>,
 *                                    whose principal is a person); --public-only only
 *                             meta   the host context on each call,
 *                                    params._meta["ai.nimblebrain/context"]
 *   --protocol-version <v>  pin this MCP revision instead of negotiating
 *   --tool-prefix <p>       the tools are listed as <p><tool>; only those are judged
 *
 * Scope options.
 *   --workspace <id>        the scope's workspace (required unless carriage is none)
 *   --owner <id>            the scope's owner (required unless carriage is none)
 *   --scratch-workspace <id>  a disposable workspace. The full run works in it and in
 *                           workspaces named `<id>-<case>`, one per group of cases, so
 *                           what `due` lists is only what the group made; each is purged
 *                           with delete_workspace when the run ends. Without it the run
 *                           flow cases skip.
 *   --skip <text>           skip every case whose name contains <text> (repeatable)
 *
 * Output: one line per case (`ok`, `FAIL`, `skip`), then a total. Exit 0 when no case
 * fails, 1 when one does, 2 on bad arguments.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

// ── Options and results ──────────────────────────────────────────────────

export type Carriage = "none" | "meta";
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

// ── The contract's document ──────────────────────────────────────────────

const CONTRACT_PATH = resolve(import.meta.dir, "../../../schemas/contracts/tasks/v1/contract.json");
const HOST_CONTEXT_META_KEY = "ai.nimblebrain/context";
const MCP_APP_MIME = "text/html;profile=mcp-app";
const SCREEN_URIS = ["ui://tasks/panel", "ui://tasks/card"] as const;
const VERSION = "1.0";
const DEFS_PREFIX = "#/$defs/";

type Obj = Record<string, unknown>;

interface SchemaRef {
  $ref: string;
}
interface ContractTool {
  visibility: "public" | "private";
  unattended: "allowed" | "refused";
  grant?: true;
  input: SchemaRef;
  output: SchemaRef;
}
interface ContractDocument {
  $id: string;
  contract: string;
  tools: Record<string, ContractTool>;
  errors: {
    public: Array<{ code: string; prefix: string }>;
    private: Array<{ code: string }>;
  };
  $defs: Record<string, Obj>;
}

const CONTRACT = JSON.parse(readFileSync(CONTRACT_PATH, "utf-8")) as ContractDocument;
const toolsWhere = (keep: (t: ContractTool) => boolean) =>
  Object.entries(CONTRACT.tools)
    .filter(([, t]) => keep(t))
    .map(([name]) => name);

export const PUBLIC_TOOLS: readonly string[] = toolsWhere((t) => t.visibility === "public");
export const PRIVATE_TOOLS: readonly string[] = toolsWhere((t) => t.visibility === "private");
const GRANT_TOOLS = new Set(toolsWhere((t) => t.grant === true));
const REFUSED_PUBLIC = toolsWhere((t) => t.visibility === "public" && t.unattended === "refused");
const ALLOWED_TOOLS = toolsWhere((t) => t.unattended === "allowed");

const PRIVATE_CODES = new Set(CONTRACT.errors.private.map((e) => e.code));
const PUBLIC_CODES = new Map(CONTRACT.errors.public.map((e) => [e.code, e.prefix]));

function publicPrefix(code: string): string {
  const prefix = PUBLIC_CODES.get(code);
  if (prefix === undefined) throw new Error(`the contract has no public error "${code}"`);
  return prefix;
}

function defKey(ref: string): string {
  if (!ref.startsWith(DEFS_PREFIX)) throw new Error(`unsupported $ref ${ref}`);
  return ref.slice(DEFS_PREFIX.length);
}

/** The `$defs` keys a schema refers to as `#/$defs/<name>`. */
function sharedRefs(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) sharedRefs(item, into);
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k === "$ref" && typeof v === "string" && v.startsWith(DEFS_PREFIX)) {
        into.add(v.slice(DEFS_PREFIX.length));
      } else {
        sharedRefs(v, into);
      }
    }
  }
  return into;
}

/**
 * A tool's schema as a server lists it: the `$defs` entry its `$ref` names, with the shared
 * `$defs` it refers to bundled beside it (CONTRACT.md §1). A public schema refers to none.
 */
export function contractSchema(tool: string, kind: "input" | "output"): Obj {
  const entry = CONTRACT.tools[tool];
  if (!entry) throw new Error(`the contract has no tool "${tool}"`);
  const schema = CONTRACT.$defs[defKey(entry[kind].$ref)];
  if (!schema) throw new Error(`${tool} ${kind} schema is missing`);
  const names = sharedRefs(schema);
  if (names.size === 0) return schema;
  const defs: Record<string, Obj> = {};
  for (const name of names) defs[name] = CONTRACT.$defs[name] ?? {};
  return { ...schema, $defs: defs };
}

// The whole document goes to Ajv, so a value is validated through the tool's own `$ref`.
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(CONTRACT);

function validateAt(ref: string, value: unknown, what: string): void {
  const validate = ajv.getSchema(new URL(ref, CONTRACT.$id).href);
  if (!validate) throw new Error(`${ref} does not resolve in the contract`);
  if (!validate(value)) {
    throw new Error(`${what} fails its schema: ${ajv.errorsText(validate.errors)}`);
  }
}

function validateOutput(tool: string, value: unknown): void {
  const entry = CONTRACT.tools[tool];
  if (!entry) throw new Error(`the contract has no tool "${tool}"`);
  validateAt(entry.output.$ref, value, `${tool} output`);
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
function isObj(v: unknown): v is Obj {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function obj(v: unknown, what: string): Obj {
  assert(isObj(v), `${what} is not an object`);
  return v;
}
function list(v: unknown, what: string): Obj[] {
  assert(Array.isArray(v) && v.every(isObj), `${what} is not an array of objects`);
  return v;
}
function str(v: unknown, what: string): string {
  assert(typeof v === "string", `${what} is not a string`);
  return v;
}

// ── The fake host clock ──────────────────────────────────────────────────

/** The host's clock starts here, far from any wall clock. */
export const CLOCK_START = Date.UTC(2031, 2, 1, 0, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const at = (ms: number) => new Date(ms).toISOString();

// ── What the whole run watches ───────────────────────────────────────────

/**
 * Facts gathered from every answer, judged by the closing cases: grants and task content
 * must never leak, every error must be from the closed lists, and `due`'s `cancel` must
 * only ever name runs the host began and has not ended.
 */
interface Audit {
  grants: Set<string>;
  grantLeaks: string[];
  markers: Set<string>;
  noticeLeaks: string[];
  errorViolations: string[];
  begun: Map<string, Set<string>>;
  ended: Map<string, Set<string>>;
  cancelViolations: string[];
  /** Calls whose answer was checked by the audit, so a closing case is not vacuous. */
  calls: number;
}

function newAudit(): Audit {
  return {
    grants: new Set(),
    grantLeaks: [],
    markers: new Set(),
    noticeLeaks: [],
    errorViolations: [],
    begun: new Map(),
    ended: new Map(),
    cancelViolations: [],
    calls: 0,
  };
}

function setOf(map: Map<string, Set<string>>, key: string): Set<string> {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  return set;
}

// ── Connections ──────────────────────────────────────────────────────────

/** The host context one connection's calls carry. */
interface Context {
  workspace?: string;
  owner?: string;
  principal?: Principal;
  /** The grant the host stamps on this person's calls to grant-marked tools. */
  grant?: string;
  unattended?: boolean;
}

/** A per-call change to the context: `null` removes a field, `noGrant` stamps none. */
type Over = { [K in keyof Context]?: Context[K] | null } & { noGrant?: boolean };

interface CallResult {
  isError?: boolean;
  structuredContent?: Obj;
  content?: Array<{ type: string; text?: string }>;
}

export interface ListedTool {
  name: string;
  description?: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean };
}

/** One MCP client under one context; views share the client under another context. */
interface Conn {
  ctx: Context;
  client: Client;
  call(tool: string, args: Obj, over?: Over): Promise<CallResult>;
  listTools(): Promise<ListedTool[]>;
  /** The same client, calling under a context changed by `patch`. */
  as(patch: Over): Conn;
  close(): Promise<void>;
}

const RESOURCE_METHODS = new Set([
  "resources/read",
  "resources/subscribe",
  "resources/unsubscribe",
  "subscriptions/listen",
]);

function merged(ctx: Context, over: Over = {}): Context {
  const out: Record<string, unknown> = { ...ctx };
  for (const [k, v] of Object.entries(over)) {
    if (k === "noGrant") continue;
    if (v === null) delete out[k];
    else if (v !== undefined) out[k] = v;
  }
  return out as Context;
}

/** The host context object as the host stamps it on a call to `tool`. */
function contextObject(ctx: Context, tool?: string, noGrant = false): Obj {
  const stampGrant =
    !noGrant &&
    ctx.principal === "person" &&
    ctx.grant &&
    tool !== undefined &&
    GRANT_TOOLS.has(tool);
  return {
    ...(ctx.workspace ? { workspaceId: ctx.workspace } : {}),
    ...(ctx.owner ? { ownerId: ctx.owner } : {}),
    ...(ctx.principal ? { principal: ctx.principal } : {}),
    ...(stampGrant ? { grant: ctx.grant } : {}),
    ...(ctx.unattended !== undefined ? { unattended: ctx.unattended } : {}),
  };
}

/**
 * The fetch a connection uses: the transport's headers, and, for the resource methods whose
 * client API takes no `_meta` of ours (`resources/read`, `resources/subscribe`,
 * `subscriptions/listen`), the host context merged into the request's `params._meta`.
 */
function hostFetch(
  headers: Record<string, string>,
  resourceCtx: () => Context | undefined,
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return (input, init) => {
    const h = new Headers(init?.headers);
    for (const [k, v] of Object.entries(headers)) h.set(k, v);
    let body = init?.body;
    const ctx = resourceCtx();
    if (ctx && typeof body === "string") body = withResourceContext(body, ctx);
    return fetch(input, { ...init, headers: h, ...(body !== undefined ? { body } : {}) });
  };
}

function withResourceContext(body: string, ctx: Context): string {
  let message: unknown;
  try {
    message = JSON.parse(body);
  } catch {
    return body;
  }
  if (!isObj(message) || typeof message.method !== "string") return body;
  if (!RESOURCE_METHODS.has(message.method)) return body;
  const params = isObj(message.params) ? message.params : {};
  const meta = isObj(params._meta) ? params._meta : {};
  return JSON.stringify({
    ...message,
    params: { ...params, _meta: { ...meta, [HOST_CONTEXT_META_KEY]: contextObject(ctx) } },
  });
}

async function newClient(opts: RunnerOptions, resourceCtx: () => Context | undefined) {
  const client = new Client(
    { name: "tasks-contract-conformance", version: "1.0.0" },
    {
      versionNegotiation: { mode: opts.protocolVersion ? { pin: opts.protocolVersion } : "auto" },
    },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(opts.server as string), {
      fetch: hostFetch(opts.headers ?? {}, resourceCtx),
    }),
  );
  return client;
}

function makeConn(opts: RunnerOptions, client: Client, ctx: Context, audit: Audit): Conn {
  const carriage = opts.carriage ?? "none";
  const prefix = opts.toolPrefix ?? "";
  const conn: Conn = {
    ctx,
    client,
    call: async (tool, args, over) => {
      const c = merged(ctx, over);
      const meta =
        carriage === "meta"
          ? { [HOST_CONTEXT_META_KEY]: contextObject(c, tool, over?.noGrant) }
          : undefined;
      const r = (await client.callTool({
        name: `${prefix}${tool}`,
        arguments: args,
        ...(meta ? { _meta: meta } : {}),
      })) as CallResult;
      auditAnswer(audit, tool, r, c.workspace ?? "");
      return r;
    },
    listTools: async () =>
      ((await client.listTools()).tools as ListedTool[])
        .filter((t) => t.name.startsWith(prefix))
        .map((t) => ({ ...t, name: t.name.slice(prefix.length) })),
    as: (patch) => makeConn(opts, client, merged(ctx, patch), audit),
    close: () => client.close(),
  };
  return conn;
}

async function connect(opts: RunnerOptions, ctx: Context, audit: Audit): Promise<Conn> {
  const carriage = opts.carriage ?? "none";
  const client = await newClient(opts, () => (carriage === "meta" ? ctx : undefined));
  return makeConn(opts, client, ctx, audit);
}

// ── The audit of every answer ────────────────────────────────────────────

function firstText(r: CallResult): string {
  return r.content?.find((c) => c.type === "text")?.text ?? "";
}

function auditAnswer(audit: Audit, tool: string, r: CallResult, workspace: string): void {
  audit.calls++;
  if (r.isError) auditError(audit, tool, r);
  else auditSuccess(audit, tool, r, workspace);
  auditGrantLeak(audit, tool, r);
}

function auditError(audit: Audit, tool: string, r: CallResult): void {
  let body: unknown;
  try {
    body = JSON.parse(firstText(r));
  } catch {
    audit.errorViolations.push(`${tool}: error text is not JSON {code, error}`);
    return;
  }
  if (!isObj(body) || typeof body.code !== "string" || typeof body.error !== "string") {
    audit.errorViolations.push(`${tool}: error is not {code, error}`);
    return;
  }
  const visibility = CONTRACT.tools[tool]?.visibility ?? "public";
  if (visibility === "private") {
    if (!PRIVATE_CODES.has(body.code)) {
      audit.errorViolations.push(`${tool}: ${body.code} is not in errors.private`);
    }
    return;
  }
  const prefix = PUBLIC_CODES.get(body.code);
  if (prefix === undefined) {
    audit.errorViolations.push(`${tool}: ${body.code} is not in errors.public`);
  } else if (!body.error.startsWith(prefix)) {
    audit.errorViolations.push(`${tool}: "${body.error.slice(0, 80)}" lacks prefix "${prefix}"`);
  }
}

function auditSuccess(audit: Audit, tool: string, r: CallResult, workspace: string): void {
  const out = r.structuredContent;
  if (!out) return;
  auditNotices(audit, tool, out);
  if (tool === "begin_run" && out.decision === "run" && typeof out.runId === "string") {
    setOf(audit.begun, workspace).add(out.runId);
  }
  if (tool === "due") auditCancel(audit, out, workspace);
}

function auditNotices(audit: Audit, tool: string, out: Obj): void {
  for (const notice of Array.isArray(out.notices) ? out.notices : []) {
    const text = JSON.stringify(notice);
    const leaked = [...audit.markers].filter((m) => text.includes(m));
    for (const m of leaked) audit.noticeLeaks.push(`${tool} notice carries "${m}"`);
  }
}

function auditCancel(audit: Audit, out: Obj, workspace: string): void {
  const begun = setOf(audit.begun, workspace);
  const ended = setOf(audit.ended, workspace);
  for (const id of Array.isArray(out.cancel) ? out.cancel : []) {
    if (typeof id !== "string" || !begun.has(id) || ended.has(id)) {
      audit.cancelViolations.push(`due cancel named ${String(id)}, not a begun, unended run`);
    }
  }
}

/** The answer's text with a run answer's own `grant` field taken out. */
function scannable(tool: string, r: CallResult): string {
  const strip = (v: unknown): unknown =>
    tool === "begin_run" && isObj(v) && v.decision === "run" ? { ...v, grant: undefined } : v;
  const texts = (r.content ?? []).map((c) => {
    try {
      return JSON.stringify(strip(JSON.parse(c.text ?? "")));
    } catch {
      return c.text ?? "";
    }
  });
  return `${JSON.stringify(strip(r.structuredContent) ?? null)}\n${texts.join("\n")}`;
}

function auditGrantLeak(audit: Audit, tool: string, r: CallResult): void {
  const text = scannable(tool, r);
  for (const grant of audit.grants) {
    if (text.includes(grant)) audit.grantLeaks.push(`${tool} answered a grant`);
  }
}

// ── Calls ────────────────────────────────────────────────────────────────

/** A success's payload, checked against the tool's output schema. */
async function okCall(conn: Conn, tool: string, args: Obj, over?: Over): Promise<Obj> {
  const r = await conn.call(tool, args, over);
  if (r.isError) throw new Error(`${tool}: tool error: ${firstText(r).slice(0, 300)}`);
  assert(r.structuredContent, `${tool}: no structuredContent`);
  validateOutput(tool, r.structuredContent);
  return r.structuredContent;
}

function errorBody(r: CallResult): { code?: string; error?: string } {
  assert(r.isError === true, `expected an error, got ${JSON.stringify(r).slice(0, 200)}`);
  return JSON.parse(firstText(r) || "{}") as { code?: string; error?: string };
}

function expectCode(r: CallResult, code: string, what: string): void {
  const got = errorBody(r).code;
  assert(got === code, `${what}: code ${String(got)}, want ${code}`);
}

/** A public error with `code` whose text begins with its prefix (and `rest`). */
function expectPublicError(r: CallResult, code: string, what: string, rest = ""): void {
  const { code: got, error } = errorBody(r);
  assert(got === code, `${what}: code ${String(got)}, want ${code}`);
  const want = `${publicPrefix(code)}${rest}`;
  assert(String(error).startsWith(want), `${what}: error "${error}" does not begin "${want}"`);
}

/**
 * A private tool's answer to a caller that is not `host`: `forbidden`, whatever else is wrong
 * with the call (CONTRACT.md §3). Throws on any other answer, including a success.
 */
export function expectForbidden(r: CallResult, what: string): void {
  if (r.isError !== true) throw new Error(`${what}: a non-host call succeeded`);
  const { code } = JSON.parse(firstText(r) || "{}") as { code?: string };
  if (code !== "forbidden") throw new Error(`${what}: code ${String(code)}, want forbidden`);
}

/** A JSON-RPC error with `code` and, when given, `data.code`. */
async function expectRpcError(fn: () => Promise<unknown>, code: number, dataCode?: string) {
  let thrown: unknown;
  try {
    await fn();
  } catch (err) {
    thrown = err;
  }
  assert(thrown !== undefined, "the request succeeded");
  const e = thrown as { code?: unknown; data?: unknown };
  assert(e.code === code, `JSON-RPC code ${String(e.code)}, want ${code}`);
  if (dataCode !== undefined) {
    const data = isObj(e.data) ? e.data.code : undefined;
    assert(data === dataCode, `data.code ${String(data)}, want ${dataCode}`);
  }
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
 * Every named contract tool is listed with the document's schemas, the private ones with the
 * shared `$defs` they refer to bundled beside them (CONTRACT.md §1).
 */
export function checkToolList(tools: ListedTool[], names: readonly string[]): void {
  const listed = new Set(tools.map((t) => t.name));
  const missing = names.filter((n) => !listed.has(n));
  assert(missing.length === 0, `missing contract tools: ${missing.join(", ")}`);
  const wanted = new Set(names);
  for (const t of tools.filter((x) => wanted.has(x.name))) {
    eq(t.inputSchema, contractSchema(t.name, "input"), `${t.name} inputSchema`);
    eq(t.outputSchema, contractSchema(t.name, "output"), `${t.name} outputSchema`);
    assert(t.description && t.description.length > 0, `${t.name} has no description`);
  }
}

/** None of the named tools is listed: a host's agent-facing door hides the private tools. */
export function checkAbsent(tools: ListedTool[], names: readonly string[]): void {
  const hidden = new Set(names);
  const shown = tools.filter((t) => hidden.has(t.name)).map((t) => t.name);
  assert(shown.length === 0, `private tools listed: ${shown.join(", ")}`);
}

/** Every tool the document marks `unattended: "allowed"` is annotated `readOnlyHint: true`. */
export function checkReadOnlyHints(tools: ListedTool[]): void {
  const allowed = new Set(ALLOWED_TOOLS);
  for (const t of tools.filter((x) => allowed.has(x.name))) {
    assert(t.annotations?.readOnlyHint === true, `${t.name} is not annotated readOnlyHint`);
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────

let serial = 0;
/** A distinctive string, registered as task content that no notice may carry. */
function marker(audit: Audit, what: string): string {
  const m = `zq${what}${(++serial).toString(36)}x${Math.random().toString(36).slice(2, 8)}`;
  audit.markers.add(m);
  return m;
}
/** A fresh opaque grant, registered so any answer that repeats it is caught. */
function newGrant(audit: Audit, what: string): string {
  const g = `grant.${what}.${(++serial).toString(36)}.${Math.random().toString(36).slice(2, 10)}`;
  audit.grants.add(g);
  return g;
}
function taskName(audit: Audit, what: string): string {
  return `Conformance ${what} ${marker(audit, "name")}`;
}

/** Create a task as `person` and answer its id. */
async function createTask(person: Conn, manifest: Obj, body: string): Promise<string> {
  const out = await okCall(person, "create", { manifest, body });
  return str(obj(out.task, "task").id, "task.id");
}

interface Outcome {
  start: number;
  end?: number;
  output?: string;
  stop?: string;
  error?: Obj;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  extra?: Obj;
}

/** A `run_outcome`, every instant from the fake clock. */
function outcome(o: Outcome): Obj {
  return {
    startedAt: at(o.start),
    endedAt: at(o.end ?? o.start + 1000),
    output: o.output ?? "",
    stopReason: o.stop ?? "complete",
    ...(o.error ? { error: o.error } : {}),
    usage: { inputTokens: o.inputTokens ?? 10, outputTokens: o.outputTokens ?? 5 },
    costUsd: o.cost ?? 0,
    toolCalls: [],
    filesWritten: [],
    ...(o.extra ?? {}),
  };
}

interface Occurrence {
  key: string;
  ref: string;
  notBefore?: string;
}

/** The host's side of the run flow, in one workspace. */
interface Host {
  conn: Conn;
  due(now: number, until: number, extra?: Obj): Promise<Obj>;
  /** Every page of one listing. */
  dueAll(now: number, until: number): Promise<{ occurrences: Occurrence[]; cancel: string[] }>;
  begin(ref: string, token: number, now: number, attempt?: number): Promise<Obj>;
  end(runId: string, token: number, o: Obj): Promise<Obj>;
}

function hostOf(conn: Conn, audit: Audit): Host {
  const ws = conn.ctx.workspace ?? "";
  const host: Host = {
    conn,
    due: (now, until, extra = {}) =>
      okCall(conn, "due", { version: VERSION, now: at(now), until: at(until), ...extra }),
    dueAll: async (now, until) => {
      const occurrences: Occurrence[] = [];
      let cancel: string[] = [];
      let cursor: unknown;
      for (let i = 0; i < 1000; i++) {
        const page = await host.due(now, until, typeof cursor === "string" ? { cursor } : {});
        occurrences.push(...list(page.occurrences, "occurrences").map(toOccurrence));
        cancel = Array.isArray(page.cancel) ? page.cancel.map(String) : [];
        cursor = page.nextCursor;
        if (typeof cursor !== "string") break;
      }
      return { occurrences, cancel };
    },
    begin: (ref, token, now, attempt = 1) =>
      okCall(conn, "begin_run", { version: VERSION, ref, attempt, token, now: at(now) }),
    end: async (runId, token, o) => {
      const out = await okCall(conn, "end_run", { version: VERSION, runId, token, outcome: o });
      setOf(audit.ended, ws).add(runId);
      return out;
    },
  };
  return host;
}

function toOccurrence(o: Obj): Occurrence {
  return {
    key: str(o.key, "occurrence.key"),
    ref: str(o.ref, "occurrence.ref"),
    ...(typeof o.notBefore === "string" ? { notBefore: o.notBefore } : {}),
  };
}

/** The occurrences in `after` whose key is not in `before`. */
function fresh(before: Occurrence[], after: Occurrence[]): Occurrence[] {
  const seen = new Set(before.map((o) => o.key));
  return after.filter((o) => !seen.has(o.key));
}

/** Run `fn` and answer the occurrences it made, listed by a `due` at `now`. */
async function occurrencesOf(host: Host, now: number, fn: () => Promise<unknown>) {
  const before = (await host.dueAll(now, now + DAY)).occurrences;
  await fn();
  return fresh(before, (await host.dueAll(now, now + DAY)).occurrences);
}

/** Ask for a run of `taskId` and answer its id and its one occurrence. */
async function requestRun(
  host: Host,
  person: Conn,
  taskId: string,
  now: number,
  args: Obj = {},
): Promise<{ runId: string; occ: Occurrence }> {
  let runId = "";
  const made = await occurrencesOf(host, now, async () => {
    runId = str((await okCall(person, "run", { taskId, ...args })).runId, "runId");
  });
  assert(made.length === 1, `run made ${made.length} occurrences, want 1`);
  return { runId, occ: made[0] as Occurrence };
}

/** Begin an occurrence that must answer a run, and answer that run answer. */
async function beginRun(host: Host, occ: Occurrence, token: number, now: number): Promise<Obj> {
  const answer = await host.begin(occ.ref, token, now);
  assert(answer.decision === "run", `begin_run answered ${JSON.stringify(answer).slice(0, 200)}`);
  return answer;
}

async function runResult(conn: Conn, runId: string): Promise<Obj> {
  return okCall(conn, "run_result", { runId });
}
async function execution(conn: Conn, runId: string): Promise<{ execution: string; label: string }> {
  const run = obj((await runResult(conn, runId)).run, "run");
  return { execution: String(run.execution), label: String(run.label) };
}

// ── The full run's context ───────────────────────────────────────────────

interface FullCtx {
  h: Harness;
  opts: RunnerOptions;
  audit: Audit;
  /** The one client every tool call goes through; views state each call's context. */
  base: Conn;
  /** Workspaces this run made, purged when it ends. */
  made: string[];
}

/** A host and a person (with a grant) in a fresh workspace named for `label`. */
function scenario(c: FullCtx, label: string, owner = c.opts.owner as string) {
  const workspace = `${c.opts.scratchWorkspace}-${label}`;
  if (!c.made.includes(workspace)) c.made.push(workspace);
  const host = hostOf(c.base.as({ workspace, owner, principal: "host", grant: null }), c.audit);
  const person = c.base.as({
    workspace,
    owner,
    principal: "person",
    grant: newGrant(c.audit, label),
  });
  return { workspace, host, person };
}

// ── Basics: the surface, the principal rule, unattended, scope ───────────

async function surfaceCases(c: FullCtx, host: Conn): Promise<void> {
  const { h } = c;
  await h.run("tools/list as host matches the contract schemas", async () =>
    checkToolList(await host.listTools(), [...PUBLIC_TOOLS, ...PRIVATE_TOOLS]),
  );
  await h.run("every tool allowed unattended is annotated readOnlyHint", async () =>
    checkReadOnlyHints(await host.listTools()),
  );
  await h.run("an unknown tool is unknown_tool", async () => {
    expectPublicError(await host.call("no_such_tool", {}), "unknown_tool", "no_such_tool");
  });
  await screenCases(h, host);
}

async function screenCases(h: Harness, conn: Conn): Promise<void> {
  await h.run("lists and reads the screen as MCP Apps", async () => {
    const { resources } = await conn.client.listResources();
    for (const uri of SCREEN_URIS) {
      const r = resources.find((x) => x.uri === uri);
      assert(r, `${uri} not listed (listed: ${resources.map((x) => x.uri).join(", ")})`);
      eq(r.mimeType, MCP_APP_MIME, `${uri} listed mimeType`);
      const read = await conn.client.readResource({ uri }, { cacheMode: "bypass" });
      const first = read.contents[0] as { mimeType?: string; text?: string };
      eq(first.mimeType, MCP_APP_MIME, `${uri} read mimeType`);
      assert(typeof first.text === "string" && /<html|<!doctype/i.test(first.text), "not HTML");
    }
  });
  await h.run("an unknown resource is a JSON-RPC error", async () => {
    let threw = false;
    try {
      await conn.client.readResource(
        { uri: "ui://tasks/no-such-resource" },
        { cacheMode: "bypass" },
      );
    } catch {
      threw = true;
    }
    assert(threw, "did not throw");
  });
}

/** Plausible arguments for every private tool, so only the principal decides the answer. */
function privateArgs(now: number): Record<string, Obj> {
  return {
    due: { version: VERSION, now: at(now), until: at(now + DAY) },
    begin_run: { version: VERSION, ref: "ref", attempt: 1, token: 1, now: at(now) },
    end_run: {
      version: VERSION,
      runId: "run_absent",
      token: 1,
      outcome: outcome({ start: now }),
    },
    offer_event: {
      version: VERSION,
      taskId: "absent",
      now: at(now),
      event: {
        id: "e1",
        source: "conformance",
        name: "ping",
        level: "info",
        title: "t",
        receivedAt: at(now),
      },
    },
    delete_workspace: { version: VERSION },
  };
}

async function forbiddenCases(c: FullCtx): Promise<void> {
  const { h } = c;
  const { host, person } = scenario(c, "forbidden");
  const now = CLOCK_START;
  let taskId = "";
  await h.run(
    "every private tool answers a person with forbidden and changes nothing",
    async () => {
      taskId = await createTask(
        person,
        { name: taskName(c.audit, "forbidden"), schedule: { intervalMs: HOUR } },
        "kept",
      );
      const args = privateArgs(now);
      for (const tool of PRIVATE_TOOLS) {
        expectForbidden(await person.call(tool, args[tool] ?? {}), tool);
      }
      await okCall(person, "status", { taskId });
      const due = await host.dueAll(now, now + DAY);
      assert(due.occurrences.length === 1, `the task's occurrence is gone or doubled`);
    },
  );
  await h.run("a call that names no principal is not host", async () => {
    const anon = host.conn.as({ principal: null });
    const args = privateArgs(now);
    for (const tool of PRIVATE_TOOLS)
      expectForbidden(await anon.call(tool, args[tool] ?? {}), tool);
  });
  await h.run("forbidden comes before the input and the scope", async () => {
    for (const tool of PRIVATE_TOOLS) {
      expectForbidden(await person.call(tool, { nonsense: true }), `${tool} with invalid input`);
      const bare = person.as({ workspace: null, owner: null });
      expectForbidden(await bare.call(tool, privateArgs(now)[tool] ?? {}), `${tool} unscoped`);
    }
  });
}

/** Arguments for each refused public tool that would otherwise succeed or name a real thing. */
function refusedArgs(taskId: string, runId: string, batchId: string): Record<string, Obj> {
  return {
    create: { manifest: { name: `Unattended ${serial++}` }, body: "nope" },
    update: { taskId, body: "rewritten" },
    delete: { taskId },
    run: { taskId },
    cancel: { runId },
    run_batch: { taskId, items: [1] },
    batch_control: { batchId, action: "cancel" },
  };
}

async function unattendedCases(c: FullCtx): Promise<void> {
  const { h } = c;
  const { host, person } = scenario(c, "unattended");
  await h.run(
    "every refused public tool answers an unattended call unattended_refused",
    async () => {
      const taskId = await createTask(person, { name: taskName(c.audit, "unattended") }, "body");
      const runId = str((await okCall(person, "run", { taskId })).runId, "runId");
      const batch = obj((await okCall(person, "run_batch", { taskId, items: [1] })).batch, "batch");
      const run = person.as({ unattended: true });
      const args = refusedArgs(taskId, runId, String(batch.id));
      for (const tool of REFUSED_PUBLIC) {
        expectPublicError(
          await run.call(tool, args[tool] ?? {}, { noGrant: true }),
          "unattended_refused",
          tool,
        );
      }
      const status = obj((await okCall(person, "status", { taskId })).task, "task");
      eq(status.prompt, "body", "the task's prompt");
      eq(await execution(person, runId), { execution: "queued", label: "Queued" }, "the run");
      const listed = list((await okCall(person, "list", { kind: "all" })).tasks, "tasks");
      assert(
        listed.some((t) => t.id === taskId),
        "the task was deleted",
      );
      eq(
        obj((await okCall(person, "batch", { batchId: batch.id })).batch, "batch").state,
        "running",
        "batch",
      );
      await host.dueAll(CLOCK_START, CLOCK_START + DAY);
    },
  );
  await h.run("tools allowed unattended still answer an unattended call", async () => {
    const run = person.as({ unattended: true });
    for (const [tool, args] of [
      ["list", {}],
      ["runs", {}],
      ["upcoming", {}],
      ["stats", {}],
      ["batches", {}],
    ] as const) {
      await okCall(run, tool, args);
    }
  });
}

async function scopeCases(c: FullCtx): Promise<void> {
  const { h } = c;
  const { host, person } = scenario(c, "scope");
  await h.run("a public call with no workspace or no owner is scope_missing", async () => {
    expectPublicError(await person.call("list", {}, { workspace: null }), "scope_missing", "list");
    expectPublicError(await person.call("list", {}, { owner: null }), "scope_missing", "list");
    const create = { manifest: { name: "Unscoped" }, body: "x" };
    expectPublicError(
      await person.call("create", create, { owner: null }),
      "scope_missing",
      "create",
    );
  });
  await h.run("a private call with no workspace is scope_missing", async () => {
    const args = privateArgs(CLOCK_START);
    for (const tool of ["due", "begin_run", "end_run", "delete_workspace"]) {
      expectCode(
        await host.conn.call(tool, args[tool] ?? {}, { workspace: null }),
        "scope_missing",
        tool,
      );
    }
  });
  await h.run("offer_event with no owner is scope_missing", async () => {
    const args = privateArgs(CLOCK_START).offer_event ?? {};
    expectCode(
      await host.conn.call("offer_event", args, { owner: null }),
      "scope_missing",
      "offer_event",
    );
  });
  await h.run("invalid arguments are invalid_input naming the tool", async () => {
    expectPublicError(await person.call("create", {}), "invalid_input", "create", '"create"');
    expectPublicError(
      await person.call("status", { taskId: 7 }),
      "invalid_input",
      "status",
      '"status"',
    );
    const extra = { manifest: { name: "Extra", surprise: true }, body: "x" };
    expectPublicError(await person.call("create", extra), "invalid_input", "create", '"create"');
    expectCode(await host.conn.call("due", { version: VERSION }), "invalid_input", "due");
    expectCode(
      await host.conn.call("due", { version: "2.0", now: at(CLOCK_START), until: at(CLOCK_START) }),
      "invalid_input",
      "due at another major",
    );
  });
}

// ── Walls ────────────────────────────────────────────────────────────────

async function wallCases(c: FullCtx): Promise<void> {
  const { h } = c;
  const { workspace, host, person } = scenario(c, "walls");
  await h.run("another owner and another workspace see nothing", async () => {
    const taskId = await createTask(person, { name: taskName(c.audit, "walls") }, "walled");
    const { runId } = await requestRun(host, person, taskId, CLOCK_START);
    const batchId = obj((await okCall(person, "run_batch", { taskId, items: [1] })).batch, "b").id;
    const otherOwner = person.as({ owner: `${c.opts.owner}-other`, grant: newGrant(c.audit, "o") });
    const otherWs = person.as({ workspace: `${workspace}-elsewhere` });
    for (const conn of [otherOwner, otherWs]) {
      const who = `${conn.ctx.workspace}/${conn.ctx.owner}`;
      expectPublicError(await conn.call("status", { taskId }), "task_not_found", who, taskId);
      expectPublicError(await conn.call("update", { taskId, body: "x" }), "task_not_found", who);
      expectPublicError(await conn.call("run", { taskId }), "task_not_found", who);
      expectPublicError(await conn.call("run_result", { runId }), "run_not_found", who);
      expectPublicError(await conn.call("cancel", { runId }), "run_not_found", who);
      expectPublicError(await conn.call("batch", { batchId }), "batch_not_found", who);
      const tasks = list((await okCall(conn, "list", { kind: "all" })).tasks, "tasks");
      assert(!tasks.some((t) => t.id === taskId), `${who} lists the task`);
      const runs = list((await okCall(conn, "runs", {})).runs, "runs");
      assert(!runs.some((r) => r.id === runId), `${who} lists the run`);
      const batches = list((await okCall(conn, "batches", {})).batches, "batches");
      assert(!batches.some((b) => b.id === batchId), `${who} lists the batch`);
    }
    await okCall(person, "status", { taskId });
  });
}

// ── Grants ───────────────────────────────────────────────────────────────

async function grantMissingCase(c: FullCtx): Promise<void> {
  const { person } = scenario(c, "grant-missing");
  await c.h.run(
    "every grant-marked tool without a grant is grant_missing and writes nothing",
    async () => {
      const taskId = await createTask(person, { name: taskName(c.audit, "gm") }, "original");
      const batchId = String(
        obj((await okCall(person, "run_batch", { taskId, items: [1] })).batch, "b").id,
      );
      const none = { noGrant: true };
      const name = `Never ${serial++}`;
      expectPublicError(
        await person.call("create", { manifest: { name }, body: "x" }, none),
        "grant_missing",
        "create",
      );
      expectPublicError(
        await person.call("update", { taskId, body: "changed" }, none),
        "grant_missing",
        "update",
      );
      expectPublicError(await person.call("run", { taskId }, none), "grant_missing", "run");
      expectPublicError(
        await person.call("run_batch", { taskId, items: [2] }, none),
        "grant_missing",
        "run_batch",
      );
      const pause = { batchId, action: "pause" };
      expectPublicError(
        await person.call("batch_control", pause, none),
        "grant_missing",
        "batch_control",
      );
      const tasks = list((await okCall(person, "list", { kind: "all" })).tasks, "tasks");
      assert(!tasks.some((t) => t.name === name), "create without a grant saved a task");
      eq(
        obj((await okCall(person, "status", { taskId })).task, "task").prompt,
        "original",
        "prompt",
      );
      eq(list((await okCall(person, "runs", { taskId })).runs, "runs").length, 0, "runs made");
      eq(
        list((await okCall(person, "batches", { taskId })).batches, "b").length,
        1,
        "batches made",
      );
      eq(
        obj((await okCall(person, "batch", { batchId })).batch, "b").state,
        "running",
        "batch state",
      );
    },
  );
}

async function grantCases(c: FullCtx): Promise<void> {
  const { h, audit } = c;
  const { host, person } = scenario(c, "grants");
  const t = CLOCK_START;
  const g = (what: string) => newGrant(audit, what);
  let scheduled = "";
  await h.run("begin_run answers the grant create stored, verbatim", async () => {
    const g1 = g("create");
    scheduled = await createTask(
      person.as({ grant: g1 }),
      { name: taskName(audit, "grant"), schedule: { intervalMs: HOUR } },
      "scheduled",
    );
    const [occ] = (await host.dueAll(t, t + DAY)).occurrences;
    assert(occ, "no occurrence for the scheduled task");
    const answer = await beginRun(host, occ, 1, t);
    eq(answer.grant, g1, "grant");
    await host.end(String(answer.runId), 1, outcome({ start: t, output: "ok" }));
  });
  await h.run("update re-stamps the definition's grant", async () => {
    const g2 = g("update");
    await okCall(person.as({ grant: g2 }), "update", {
      taskId: scheduled,
      manifest: { description: "re-stamped" },
    });
    const later = t + 2 * DAY;
    const [occ] = (await host.dueAll(later, later + DAY)).occurrences;
    assert(occ, "no next occurrence");
    const answer = await beginRun(host, occ, 1, later);
    eq(answer.grant, g2, "grant");
    await host.end(String(answer.runId), 1, outcome({ start: later }));
    await okCall(person, "update", { taskId: scheduled, manifest: { schedule: null } });
  });
  await grantRunCases(c, host, person);
  await h.run("delete drops the definition: its occurrence is skipped, with no grant", async () => {
    const now = t + 10 * DAY;
    let doomed = "";
    const [occ] = await occurrencesOf(host, now, async () => {
      doomed = await createTask(
        person,
        { name: taskName(audit, "doomed"), schedule: { intervalMs: HOUR } },
        "x",
      );
    });
    assert(occ, "no occurrence");
    eq((await okCall(person, "delete", { taskId: doomed })).deleted, true, "deleted");
    const answer = await host.begin(occ.ref, 1, now);
    eq(answer.decision, "skip", "decision");
    assert(!("grant" in answer), "a skip carries a grant");
    expectPublicError(await person.call("status", { taskId: doomed }), "task_not_found", "status");
  });
}

async function grantRunCases(c: FullCtx, host: Host, person: Conn): Promise<void> {
  const { h, audit } = c;
  const t = CLOCK_START + 5 * DAY;
  let taskId = "";
  await h.run("run re-stamps the definition's grant", async () => {
    taskId = await createTask(
      person.as({ grant: newGrant(audit, "m0") }),
      { name: taskName(audit, "m") },
      "m",
    );
    const g3 = newGrant(audit, "run");
    const { occ } = await requestRun(host, person.as({ grant: g3 }), taskId, t);
    const answer = await beginRun(host, occ, 1, t);
    eq(answer.grant, g3, "grant");
    await host.end(String(answer.runId), 1, outcome({ start: t }));
  });
  let batchId = "";
  await h.run("run_batch re-stamps the definition's grant", async () => {
    const g4 = newGrant(audit, "batch");
    let made: Occurrence[] = [];
    made = await occurrencesOf(host, t, async () => {
      const out = await okCall(person.as({ grant: g4 }), "run_batch", {
        taskId,
        items: [1, 2],
        concurrency: 1,
      });
      batchId = String(obj(out.batch, "batch").id);
    });
    assert(made.length === 1, `concurrency 1 listed ${made.length}`);
    const answer = await beginRun(host, made[0] as Occurrence, 1, t);
    eq(answer.grant, g4, "grant");
    await host.end(String(answer.runId), 1, outcome({ start: t }));
    await okCall(person, "batch_control", { batchId, action: "pause" });
  });
  await h.run("batch_control re-stamps the definition's grant", async () => {
    const g5 = newGrant(audit, "control");
    const made = await occurrencesOf(host, t + HOUR, () =>
      okCall(person.as({ grant: g5 }), "batch_control", { batchId, action: "resume" }),
    );
    assert(made.length === 1, `resume listed ${made.length} occurrences`);
    const answer = await beginRun(host, made[0] as Occurrence, 1, t + HOUR);
    eq(answer.grant, g5, "grant");
    await host.end(String(answer.runId), 1, outcome({ start: t + HOUR }));
  });
}

// ── The clock rule and due ───────────────────────────────────────────────

async function clockCases(c: FullCtx): Promise<void> {
  const { h, audit } = c;
  const { host, person } = scenario(c, "clock");
  const t = CLOCK_START;
  const nine = Date.UTC(2031, 2, 1, 9, 0, 0);
  const once = t + 2 * HOUR;
  let cronKey = "";
  let cronTask = "";
  let cronRef = "";
  await h.run(
    "a schedule's first occurrence comes from due's now, never the wall clock",
    async () => {
      await createTask(
        person,
        { name: taskName(audit, "interval"), schedule: { intervalMs: DAY } },
        "i",
      );
      cronTask = await createTask(
        person,
        { name: taskName(audit, "cron"), schedule: { cron: "0 9 * * *", timezone: "UTC" } },
        "c",
      );
      await createTask(person, { name: taskName(audit, "once"), schedule: { at: at(once) } }, "o");
      const { occurrences } = await host.dueAll(t, t + DAY);
      const times = occurrences.map((o) => o.notBefore ?? "at once");
      assert(occurrences.length === 3, `listed ${JSON.stringify(times)}`);
      const cron = occurrences.find((o) => o.notBefore === at(nine));
      assert(cron, `no cron occurrence at ${at(nine)}: ${JSON.stringify(times)}`);
      assert(
        times.includes(at(once)),
        `no once occurrence at ${at(once)}: ${JSON.stringify(times)}`,
      );
      const interval = times.filter((x) => x !== at(nine) && x !== at(once));
      assert(
        interval.length === 1 && ["at once", at(t), at(t + DAY)].includes(interval[0] as string),
        `the interval's first occurrence ${JSON.stringify(interval)} is not anchored on due's now`,
      );
      cronKey = cron.key;
      cronRef = cron.ref;
    },
  );
  await h.run("an occurrence due after until is not listed", async () => {
    const { occurrences } = await host.dueAll(t, t + HOUR);
    const late = occurrences.filter((o) => o.notBefore && Date.parse(o.notBefore) > t + HOUR);
    eq(late, [], "occurrences after until");
    assert(!occurrences.some((o) => o.key === cronKey), "the 09:00 occurrence is listed before it");
  });
  await h.run(
    "an occurrence whose time changes has a new key, and the old one is skipped",
    async () => {
      await okCall(person, "update", {
        taskId: cronTask,
        manifest: { schedule: { cron: "0 10 * * *", timezone: "UTC" } },
      });
      const { occurrences } = await host.dueAll(t, t + DAY);
      const ten = occurrences.find((o) => o.notBefore === at(nine + HOUR));
      assert(ten, "no occurrence at 10:00");
      assert(ten.key !== cronKey, "the key did not change with the time");
      assert(!occurrences.some((o) => o.key === cronKey), "the 09:00 occurrence is still listed");
      eq((await host.begin(cronRef, 1, nine)).decision, "skip", "the old occurrence's claim");
    },
  );
  await h.run("a disabled definition's occurrence is skipped when claimed", async () => {
    const { occurrences } = await host.dueAll(t, t + DAY);
    const ten = occurrences.find((o) => o.notBefore === at(nine + HOUR));
    assert(ten, "no occurrence at 10:00");
    await okCall(person, "update", { taskId: cronTask, manifest: { enabled: false } });
    eq((await host.begin(ten.ref, 1, nine + HOUR)).decision, "skip", "decision");
    const after = (await host.dueAll(t, t + DAY)).occurrences;
    assert(!after.some((o) => o.key === ten.key), "a disabled task's occurrence is listed");
  });
}

/**
 * A once's lateness is judged where `due` produces it (CONTRACT.md §5.1, §5.2, §6): one first
 * listed far past its time was missed while the host was down; one listed in time is owed to
 * the host's queue and runs however late it is claimed. "Far" is 30 days: past any grace an
 * implementation could choose.
 */
async function onceCases(c: FullCtx): Promise<void> {
  const { h, audit } = c;
  const { host, person } = scenario(c, "once");
  const t = CLOCK_START;
  const LATE = 30 * DAY;
  await h.run("a once listed by due runs however long the host's queue held it", async () => {
    const taskId = await createTask(
      person,
      { name: taskName(audit, "queued-once"), schedule: { at: at(t + HOUR) } },
      "q",
    );
    const listed = (await host.dueAll(t, t + DAY)).occurrences.filter(
      (o) => o.notBefore === at(t + HOUR),
    );
    assert(listed.length === 1, `the once is listed ${listed.length} times, want 1`);
    const occ = listed[0] as Occurrence;
    // The host stays up, and due keeps listing the produced occurrence as it waits.
    const later = (await host.dueAll(t + HOUR + LATE, t + HOUR + LATE)).occurrences;
    assert(
      later.some((o) => o.key === occ.key),
      "a once produced in time was judged missed by a later due",
    );
    const answer = await beginRun(host, occ, 1, t + HOUR + LATE);
    await host.end(str(answer.runId, "runId"), 1, outcome({ start: t + HOUR + LATE }));
    eq((await execution(person, str(answer.runId, "runId"))).execution, "completed", "execution");
    const task = obj((await okCall(person, "status", { taskId })).task, "task");
    eq(obj(task.onceDone, "onceDone").outcome, "ran", "onceDone.outcome");
  });
  await h.run(
    "a once first seen by due far past its time was missed: recorded skipped, never listed",
    async () => {
      const taskId = await createTask(
        person,
        { name: taskName(audit, "missed-once"), schedule: { at: at(t + 2 * HOUR) } },
        "m",
      );
      const now = t + 2 * HOUR + LATE;
      const listed = (await host.dueAll(now, now + DAY)).occurrences;
      assert(!listed.some((o) => o.notBefore === at(t + 2 * HOUR)), "the missed once is listed");
      const status = await okCall(person, "status", { taskId });
      eq(obj(obj(status.task, "task").onceDone, "onceDone").outcome, "missed", "onceDone");
      const runs = list(status.recentRuns, "recentRuns");
      eq(
        runs.map((r) => obj(r, "run").execution),
        ["skipped"],
        "the missed occurrence's record",
      );
    },
  );
}

async function pagingCases(c: FullCtx): Promise<void> {
  const { h, audit } = c;
  const { host, person } = scenario(c, "paging");
  const t = CLOCK_START;
  await h.run(
    "due pages by limit and cursor, repeating now and until, no repeats or skips",
    async () => {
      const taskId = await createTask(person, { name: taskName(audit, "paging") }, "p");
      const runIds: string[] = [];
      for (let i = 0; i < 5; i++)
        runIds.push(str((await okCall(person, "run", { taskId })).runId, "runId"));
      const keys: string[] = [];
      let cursor: unknown;
      let pages = 0;
      do {
        const page = await host.due(t, t + DAY, {
          limit: 2,
          ...(typeof cursor === "string" ? { cursor } : {}),
        });
        const occ = list(page.occurrences, "occurrences");
        assert(occ.length <= 2, `a page of ${occ.length} over limit 2`);
        keys.push(...occ.map((o) => String(o.key)));
        cursor = page.nextCursor;
        pages++;
      } while (typeof cursor === "string" && pages < 50);
      eq(cursor, null, "the last page's nextCursor");
      eq(keys.length, new Set(keys).size, "an occurrence was listed twice");
      eq(keys.length, 5, "occurrences listed");
      assert(pages >= 3, `${pages} pages for 5 occurrences at limit 2`);
    },
  );
  await h.run("every page of a listing carries the whole cancel list", async () => {
    const taskId = await createTask(person, { name: taskName(audit, "pcancel") }, "p");
    const { runId, occ } = await requestRun(host, person, taskId, t);
    await beginRun(host, occ, 1, t);
    eq((await okCall(person, "cancel", { runId })).cancelled, true, "cancelled");
    let cursor: unknown;
    let pages = 0;
    do {
      const page = await host.due(t, t + DAY, {
        limit: 1,
        ...(typeof cursor === "string" ? { cursor } : {}),
      });
      eq(page.cancel, [runId], `page ${pages + 1}'s cancel`);
      cursor = page.nextCursor;
      pages++;
    } while (typeof cursor === "string" && pages < 50);
    assert(pages >= 2, "the listing had one page");
    await host.end(runId, 1, outcome({ start: t, stop: "cancelled" }));
    eq((await host.due(t, t + DAY)).cancel, [], "cancel after end_run");
  });
}

// ── Fencing ──────────────────────────────────────────────────────────────

async function fencingCases(c: FullCtx): Promise<void> {
  const { h, audit } = c;
  const { host, person } = scenario(c, "fencing");
  const t = CLOCK_START;
  let ref = "";
  let first: Obj = {};
  let runId = "";
  await h.run("begin_run is idempotent per (ref, token)", async () => {
    const taskId = await createTask(person, { name: taskName(audit, "fence") }, "fenced");
    const { occ } = await requestRun(host, person, taskId, t);
    ref = occ.ref;
    first = await beginRun(host, occ, 3, t);
    runId = String(first.runId);
    eq(await host.begin(ref, 3, t + 5000, 2), first, "the repeated answer");
  });
  await h.run("a lower token is token_stale and writes nothing", async () => {
    const r = await host.conn.call("begin_run", {
      version: VERSION,
      ref,
      attempt: 2,
      token: 2,
      now: at(t),
    });
    expectCode(r, "token_stale", "begin_run");
    eq(await host.begin(ref, 3, t), first, "the token 3 answer after the stale call");
  });
  await h.run(
    "at most once: a higher token is answered skip with the earlier run interrupted",
    async () => {
      const skip = await host.begin(ref, 4, t + MINUTE, 3);
      eq(skip.decision, "skip", "decision");
      eq(skip.interrupted, { runId, token: 3 }, "interrupted");
      eq(await host.begin(ref, 4, t + MINUTE, 3), skip, "the repeated token 4 answer");
      eq((await host.begin(ref, 5, t + 2 * MINUTE, 4)).decision, "skip", "a later token");
    },
  );
  await h.run("end_run names only a run begin_run answered", async () => {
    const end = {
      version: VERSION,
      runId: "run_never_answered",
      token: 1,
      outcome: outcome({ start: t }),
    };
    expectCode(await host.conn.call("end_run", end), "run_not_found", "an unknown run");
    const taskId = await createTask(person, { name: taskName(audit, "queued") }, "q");
    const queued = str((await okCall(person, "run", { taskId })).runId, "runId");
    expectCode(
      await host.conn.call("end_run", { ...end, runId: queued }),
      "run_not_found",
      "a queued run",
    );
  });
  await h.run("end_run with another token is token_stale", async () => {
    const end = { version: VERSION, runId, outcome: outcome({ start: t }) };
    expectCode(await host.conn.call("end_run", { ...end, token: 99 }), "token_stale", "token 99");
    expectCode(
      await host.conn.call("end_run", { ...end, token: 4 }),
      "token_stale",
      "the skip's token",
    );
  });
  let notices: unknown;
  await h.run(
    "end_run from the interrupted run's token replaces the provisional record",
    async () => {
      const o = outcome({
        start: t,
        stop: "error",
        error: { code: "interrupted", transient: true },
      });
      notices = (await host.end(runId, 3, o)).notices;
      eq(await execution(person, runId), { execution: "failed", label: "Failed" }, "the run");
    },
  );
  await h.run(
    "end_run is first-wins: a repeat answers the first's notices and changes nothing",
    async () => {
      const again = await host.end(runId, 3, outcome({ start: t, output: "late success" }));
      eq(again.notices, notices, "notices");
      eq(await execution(person, runId), { execution: "failed", label: "Failed" }, "the run");
    },
  );
  await outcomeValidationCase(c, host, person);
}

async function outcomeValidationCase(c: FullCtx, host: Host, person: Conn): Promise<void> {
  const t = CLOCK_START + HOUR;
  await c.h.run("an outcome breaking its schema's pairings is invalid_input", async () => {
    const taskId = await createTask(person, { name: taskName(c.audit, "pairs") }, "pairs");
    const { occ } = await requestRun(host, person, taskId, t);
    const runId = String((await beginRun(host, occ, 1, t)).runId);
    const bad = [
      outcome({ start: t, error: { code: "internal", transient: false } }),
      outcome({ start: t, stop: "not_started" }),
      outcome({ start: t, stop: "error" }),
      outcome({ start: t, extra: { spendStop: "exhausted" } }),
      outcome({ start: t, stop: "timeout", extra: { wrapUpLimit: "max_iterations" } }),
      { ...outcome({ start: t }), surprise: 1 },
    ];
    for (const o of bad) {
      const r = await host.conn.call("end_run", { version: VERSION, runId, token: 1, outcome: o });
      expectCode(r, "invalid_input", `outcome ${JSON.stringify(o).slice(0, 120)}`);
    }
    eq(await execution(person, runId), { execution: "running", label: "Running" }, "the run");
    await host.end(runId, 1, outcome({ start: t, output: "fine" }));
  });
}

// ── The run flow ─────────────────────────────────────────────────────────

async function runFlowCases(c: FullCtx): Promise<void> {
  const { h, audit } = c;
  const { host, person } = scenario(c, "run");
  const t = CLOCK_START;
  const prompt = `Do the thing ${marker(audit, "prompt")}`;
  const input = { ask: marker(audit, "input") };
  let taskId = "";
  let runId = "";
  let occ: Occurrence = { key: "", ref: "" };
  await h.run("run answers runId and taskId at once, and the run reads queued", async () => {
    taskId = await createTask(person, { name: taskName(audit, "flow") }, prompt);
    let out: Obj = {};
    const made = await occurrencesOf(host, t, async () => {
      out = await okCall(person, "run", { taskId, input });
    });
    runId = str(out.runId, "runId");
    eq(out.taskId, taskId, "taskId");
    eq(await execution(person, runId), { execution: "queued", label: "Queued" }, "the run");
    const up = await okCall(person, "upcoming", {});
    assert(
      list(up.queued, "queued").some((q) => q.taskId === taskId),
      "upcoming does not list it queued",
    );
    assert(made.length === 1, `run listed ${made.length} occurrences`);
    occ = made[0] as Occurrence;
  });
  await h.run("due lists a requested run due at once", async () => {
    assert(occ.key, "no occurrence");
    assert(occ.notBefore === undefined, `notBefore ${occ.notBefore}`);
  });
  await h.run("begin_run answers the run with its work spec", async () => {
    const answer = await beginRun(host, occ, 1, t);
    eq(answer.runId, runId, "runId");
    const work = obj(answer.work, "work");
    eq([work.kind, work.prompt, work.input], ["agent", prompt, input], "work");
    if (work.trigger !== undefined) eq(work.trigger, "manual", "trigger");
    eq(await execution(person, runId), { execution: "running", label: "Running" }, "the run");
    const up = await okCall(person, "upcoming", {});
    assert(
      list(up.running, "running").some((r) => r.runId === runId),
      "upcoming does not list it running",
    );
  });
  await h.run("a complete run reads completed and Succeeded, with its result", async () => {
    const output = `Here it is ${marker(audit, "output")}`;
    await host.end(runId, 1, outcome({ start: t, end: t + 2000, output }));
    const read = await runResult(person, runId);
    eq(
      [obj(read.run, "run").execution, obj(read.run, "run").label],
      ["completed", "Succeeded"],
      "run",
    );
    const result = obj(read.result, "result");
    eq(result.output, output, "output");
    assert(typeof result.completedAt === "string", "no completedAt");
  });
  await runOutcomeCases(c, host, person, taskId);
  await runPagingCase(c, person, taskId, runId);
  await idempotencyCases(c, host, person, taskId);
  await h.run("status and list show the task", async () => {
    const status = await okCall(person, "status", { taskId });
    eq(obj(status.task, "task").prompt, prompt, "prompt");
    assert(list(status.recentRuns, "recentRuns").length > 0, "no recent runs");
    const tasks = list((await okCall(person, "list", {})).tasks, "tasks");
    assert(
      tasks.some((x) => x.id === taskId),
      "not listed",
    );
  });
}

async function runOutcomeCases(
  c: FullCtx,
  host: Host,
  person: Conn,
  taskId: string,
): Promise<void> {
  const { h, audit } = c;
  const t = CLOCK_START + HOUR;
  await h.run(
    "an error outcome reads failed and Failed, and its notices carry no task content",
    async () => {
      const { runId, occ } = await requestRun(host, person, taskId, t);
      await beginRun(host, occ, 1, t);
      const error = {
        code: "model_error",
        transient: false,
        message: `boom ${marker(audit, "error")}`,
      };
      await host.end(runId, 1, outcome({ start: t, stop: "error", error }));
      eq(await execution(person, runId), { execution: "failed", label: "Failed" }, "the run");
    },
  );
  await h.run("a not_started exclusive_busy outcome reads skipped", async () => {
    const { runId, occ } = await requestRun(host, person, taskId, t + MINUTE);
    await beginRun(host, occ, 1, t + MINUTE);
    const error = { code: "exclusive_busy", transient: true };
    await host.end(
      runId,
      1,
      outcome({ start: t + MINUTE, stop: "not_started", error, inputTokens: 0, outputTokens: 0 }),
    );
    eq((await execution(person, runId)).execution, "skipped", "execution");
  });
}

async function runPagingCase(
  c: FullCtx,
  person: Conn,
  taskId: string,
  firstRun: string,
): Promise<void> {
  await c.h.run(
    "runs lists ended runs newest first and pages by cursor without repeats",
    async () => {
      const seen: Obj[] = [];
      let cursor: unknown;
      for (let i = 0; i < 100; i++) {
        const page = await okCall(person, "runs", {
          taskId,
          limit: 1,
          ...(typeof cursor === "string" ? { cursor } : {}),
        });
        const runs = list(page.runs, "runs");
        assert(runs.length <= 1, "a page over its limit");
        seen.push(...runs);
        cursor = page.nextCursor;
        if (typeof cursor !== "string") break;
      }
      const ids = seen.map((r) => String(r.id));
      eq(ids.length, new Set(ids).size, "a run was listed twice");
      assert(ids.length >= 3 && ids.includes(firstRun), `runs listed ${JSON.stringify(ids)}`);
      const starts = seen.map((r) => Date.parse(String(r.startedAt)));
      for (let i = 1; i < starts.length; i++) {
        assert((starts[i] as number) <= (starts[i - 1] as number), "not newest first");
      }
    },
  );
}

async function idempotencyCases(
  c: FullCtx,
  host: Host,
  person: Conn,
  taskId: string,
): Promise<void> {
  const { h } = c;
  await h.run("a repeated idempotencyKey answers the first run, existing", async () => {
    const key = `key-${serial++}`;
    const first = await okCall(person, "run", { taskId, idempotencyKey: key });
    const again = await okCall(person, "run", { taskId, idempotencyKey: key });
    eq(again.runId, first.runId, "runId");
    eq(again.existing, true, "existing");
    await okCall(person, "cancel", { runId: first.runId });
    await host.dueAll(CLOCK_START, CLOCK_START + DAY);
  });
  await h.run("an idempotencyKey repeated with another inline definition is conflict", async () => {
    const key = `inline-${serial++}`;
    const first = await okCall(person, "run", {
      definition: { body: "first body" },
      idempotencyKey: key,
    });
    const same = await okCall(person, "run", {
      definition: { body: "first body" },
      idempotencyKey: key,
    });
    eq(same.runId, first.runId, "the same definition's runId");
    const other = await person.call("run", {
      definition: { body: "other body" },
      idempotencyKey: key,
    });
    expectPublicError(other, "conflict", "run");
    await okCall(person, "cancel", { runId: first.runId });
  });
}

// ── Cancel ───────────────────────────────────────────────────────────────

async function cancelCases(c: FullCtx): Promise<void> {
  const { h, audit } = c;
  const { host, person } = scenario(c, "cancel");
  const t = CLOCK_START;
  let taskId = "";
  await h.run(
    "a queued run cancelled before begin ends cancelled, and its claim is skipped",
    async () => {
      taskId = await createTask(person, { name: taskName(audit, "cancel") }, "c");
      const { runId, occ } = await requestRun(host, person, taskId, t);
      const out = await okCall(person, "cancel", { runId });
      eq([out.cancelled, out.runId], [true, runId], "cancel");
      eq((await execution(person, runId)).execution, "cancelled", "execution");
      eq((await host.begin(occ.ref, 1, t)).decision, "skip", "the claim");
      eq((await host.due(t, t + DAY)).cancel, [], "cancel of a run never begun");
    },
  );
  await h.run(
    "a begun run cancelled is in due's cancel on every due until its end_run",
    async () => {
      const { runId, occ } = await requestRun(host, person, taskId, t + MINUTE);
      await beginRun(host, occ, 1, t + MINUTE);
      eq((await okCall(person, "cancel", { runId })).cancelled, true, "cancelled");
      for (let i = 0; i < 3; i++)
        eq((await host.due(t + MINUTE * (2 + i), t + DAY)).cancel, [runId], `due ${i + 1}`);
      await host.end(runId, 1, outcome({ start: t + MINUTE, stop: "cancelled" }));
      eq((await host.due(t + 10 * MINUTE, t + DAY)).cancel, [], "after end_run");
      eq((await execution(person, runId)).execution, "cancelled", "execution");
      eq((await okCall(person, "cancel", { runId })).cancelled, false, "cancelling an ended run");
    },
  );
}

// ── Assessment ───────────────────────────────────────────────────────────

async function assessmentCases(c: FullCtx): Promise<void> {
  const { h, audit } = c;
  const { host, person } = scenario(c, "assess");
  const t = CLOCK_START;
  const outputSchema = {
    type: "object",
    required: ["answer"],
    properties: { answer: { type: "string" } },
  };
  let taskId = "";
  await h.run("a deliverable matching the output schema is verdict pass", async () => {
    taskId = await createTask(person, { name: taskName(audit, "assess"), outputSchema }, "answer");
    const { runId, occ } = await requestRun(host, person, taskId, t);
    const answer = await beginRun(host, occ, 1, t);
    eq(obj(answer.work, "work").outputSchema, outputSchema, "work.outputSchema");
    await host.end(runId, 1, outcome({ start: t, output: JSON.stringify({ answer: "yes" }) }));
    const run = obj((await runResult(person, runId)).run, "run");
    eq(obj(run.assessment, "assessment").verdict, "pass", "verdict");
  });
  await h.run(
    "a deliverable failing its output schema is verdict fail and raises a notice",
    async () => {
      const { runId, occ } = await requestRun(host, person, taskId, t + MINUTE);
      await beginRun(host, occ, 1, t + MINUTE);
      const output = `not json ${marker(audit, "output")}`;
      const out = await host.end(runId, 1, outcome({ start: t + MINUTE, output }));
      assert(list(out.notices, "notices").length > 0, "no notice");
      const run = obj((await runResult(person, runId)).run, "run");
      eq(obj(run.assessment, "assessment").verdict, "fail", "verdict");
    },
  );
  await h.run("a deliverable with no output schema is not assessed", async () => {
    const plain = await createTask(person, { name: taskName(audit, "plain") }, "p");
    const { runId, occ } = await requestRun(host, person, plain, t + HOUR);
    await beginRun(host, occ, 1, t + HOUR);
    await host.end(runId, 1, outcome({ start: t + HOUR, output: "anything" }));
    const run = obj((await runResult(person, runId)).run, "run");
    if (run.assessment !== undefined)
      eq(obj(run.assessment, "a").verdict, "not_assessed", "verdict");
  });
  await h.run("a token budget is a spend account its runs' usage lowers", async () => {
    const budgeted = await createTask(
      person,
      { name: taskName(audit, "budget"), tokenBudget: { maxInputTokens: 1000 } },
      "b",
    );
    const accounts = async (now: number) => {
      const { runId, occ } = await requestRun(host, person, budgeted, now);
      const work = obj((await beginRun(host, occ, 1, now)).work, "work");
      const account = list(work.spendAccounts, "spendAccounts").find(
        (a) => a.unit === "input_tokens",
      );
      assert(account, "no input_tokens account");
      return { runId, remaining: Number(account.remaining) };
    };
    const first = await accounts(t + 2 * HOUR);
    assert(first.remaining >= 0 && first.remaining <= 1000, `remaining ${first.remaining}`);
    await host.end(first.runId, 1, outcome({ start: t + 2 * HOUR, inputTokens: 600 }));
    const second = await accounts(t + 3 * HOUR);
    assert(
      second.remaining >= 0 && second.remaining <= 400,
      `remaining ${second.remaining} after 600 spent`,
    );
    await host.end(
      second.runId,
      1,
      outcome({ start: t + 3 * HOUR, inputTokens: 0, outputTokens: 0 }),
    );
  });
}

// ── Batches ──────────────────────────────────────────────────────────────

async function batchValidationCases(c: FullCtx, person: Conn, taskId: string): Promise<void> {
  const { h } = c;
  await h.run("run_batch validates every item first: one bad item refuses the batch", async () => {
    const r = await person.call("run_batch", { taskId, items: [{ n: 1 }, { x: 2 }, { n: 3 }] });
    expectPublicError(r, "invalid_input", "run_batch");
    eq(list((await okCall(person, "batches", { taskId })).batches, "batches"), [], "batches");
  });
  await h.run("a stopWhen on a task with no output schema is refused", async () => {
    const r = await person.call("run_batch", {
      taskId,
      items: [{ n: 1 }],
      stopWhen: { minPassRate: 0.5, afterItems: 1 },
    });
    const code = errorBody(r).code;
    assert(code === "invalid_input" || code === "conflict", `code ${String(code)}`);
    eq(list((await okCall(person, "batches", { taskId })).batches, "batches"), [], "batches");
  });
}

async function batchCases(c: FullCtx): Promise<void> {
  const { h, audit } = c;
  const { host, person } = scenario(c, "batch");
  const t = CLOCK_START;
  const inputSchema = { type: "object", required: ["n"], properties: { n: { type: "number" } } };
  const taskId = await createTask(person, { name: taskName(audit, "batch"), inputSchema }, "each");
  await batchValidationCases(c, person, taskId);
  let batchId = "";
  await h.run(
    "concurrency bounds the batch's runs, and its budget is a spend account",
    async () => {
      const items = [{ n: 1 }, { n: 2 }, { n: 3 }];
      let made: Occurrence[] = [];
      made = await occurrencesOf(host, t, async () => {
        const out = await okCall(person, "run_batch", {
          taskId,
          items,
          concurrency: 1,
          budgetUsd: 1,
        });
        batchId = String(obj(out.batch, "batch").id);
      });
      assert(made.length === 1, `concurrency 1 listed ${made.length}`);
      const answer = await beginRun(host, made[0] as Occurrence, 1, t);
      const work = obj(answer.work, "work");
      assert(
        items.some((i) => canonical(i) === canonical(work.input)),
        "work.input is no item",
      );
      const usd = list(work.spendAccounts, "spendAccounts").find((a) => a.unit === "usd");
      assert(usd, "no usd account");
      assert(
        Number(usd.remaining) >= 0 && Number(usd.remaining) <= 1,
        `remaining ${String(usd.remaining)}`,
      );
      assert(Number(usd.sharedBy ?? 1) >= 1, "sharedBy");
      eq((await host.dueAll(t, t + DAY)).occurrences, [], "occurrences while one runs");
      await host.end(String(answer.runId), 1, outcome({ start: t, output: "done", cost: 0.4 }));
      const [next] = (await host.dueAll(t + MINUTE, t + DAY)).occurrences;
      assert(next, "no next item");
      const nextWork = obj((await beginRun(host, next, 1, t + MINUTE)).work, "work");
      const usd2 = list(nextWork.spendAccounts, "spendAccounts").find((a) => a.unit === "usd");
      assert(usd2, "no usd account");
      const left = Number(usd2.remaining);
      assert(left >= 0 && left <= 0.6 + 1e-9, `remaining ${left} after $0.40 spent of $1`);
    },
  );
  await h.run("batch reports counts and pages its items by index; batches lists it", async () => {
    const out = await okCall(person, "batch", { batchId, results: true, limit: 1 });
    const batch = obj(out.batch, "batch");
    const counts = obj(batch.counts, "counts");
    eq(
      Object.values(counts).reduce((a: number, b) => a + Number(b), 0),
      3,
      "counts total",
    );
    eq(
      list(out.results, "results").map((r) => r.index),
      [0],
      "first page",
    );
    eq(out.nextCursor, 1, "nextCursor");
    const page = await okCall(person, "batch", { batchId, cursor: 1, limit: 5 });
    eq(
      list(page.results, "results").map((r) => r.index),
      [1, 2],
      "next page",
    );
    const batches = list((await okCall(person, "batches", {})).batches, "batches");
    assert(
      batches.some((b) => b.id === batchId),
      "not listed",
    );
  });
  await batchControlCases(c, host, person, taskId, batchId);
}

async function batchControlCases(
  c: FullCtx,
  host: Host,
  person: Conn,
  taskId: string,
  first: string,
) {
  const { h } = c;
  const t = CLOCK_START + HOUR;
  await h.run("cancel stops a batch: its begun run is in due's cancel", async () => {
    const running = (await host.dueAll(t, t + DAY)).cancel;
    eq(running, [], "cancel before");
    const out = await okCall(person, "batch_control", { batchId: first, action: "cancel" });
    eq(obj(out.batch, "batch").state, "cancelled", "state");
    const { cancel, occurrences } = await host.dueAll(t, t + DAY);
    eq(cancel.length, 1, "runs to cancel");
    eq(occurrences, [], "occurrences of a cancelled batch");
    await host.end(String(cancel[0]), 1, outcome({ start: t, stop: "cancelled" }));
    eq(
      obj((await okCall(person, "batch", { batchId: first })).batch, "b").state,
      "cancelled",
      "state",
    );
  });
  await h.run(
    "pause lists no new item, a queued one is skipped when claimed; resume goes on",
    async () => {
      let batchId = "";
      const made = await occurrencesOf(host, t, async () => {
        const out = await okCall(person, "run_batch", {
          taskId,
          items: [{ n: 1 }, { n: 2 }, { n: 3 }],
          concurrency: 2,
        });
        batchId = String(obj(out.batch, "b").id);
      });
      assert(made.length === 2, `concurrency 2 listed ${made.length}`);
      const [a, b] = made as [Occurrence, Occurrence];
      const running = await beginRun(host, a, 1, t);
      await okCall(person, "batch_control", { batchId, action: "pause" });
      eq((await host.dueAll(t, t + DAY)).occurrences, [], "occurrences while paused");
      eq((await host.begin(b.ref, 1, t)).decision, "skip", "the queued item's claim");
      await host.end(String(running.runId), 1, outcome({ start: t, output: "ok" }));
      const resumed = await occurrencesOf(host, t + MINUTE, () =>
        okCall(person, "batch_control", { batchId, action: "resume" }),
      );
      assert(resumed.length >= 1, "resume listed nothing");
      for (const [i, occ] of resumed.entries()) {
        const answer = await beginRun(host, occ, 1, t + MINUTE);
        await host.end(String(answer.runId), 1, outcome({ start: t + MINUTE + i, output: "ok" }));
      }
    },
  );
  await h.run("rerun_failed runs a failed item again as a new run", async () => {
    let batchId = "";
    const made = await occurrencesOf(host, t + 2 * HOUR, async () => {
      const out = await okCall(person, "run_batch", { taskId, items: [{ n: 9 }] });
      batchId = String(obj(out.batch, "b").id);
    });
    const failed = await beginRun(host, made[0] as Occurrence, 1, t + 2 * HOUR);
    const error = { code: "model_error", transient: false };
    await host.end(String(failed.runId), 1, outcome({ start: t + 2 * HOUR, stop: "error", error }));
    const done = obj((await okCall(person, "batch", { batchId })).batch, "b");
    eq([done.state, obj(done.counts, "counts").failed], ["completed", 1], "the batch");
    const again = await occurrencesOf(host, t + 3 * HOUR, () =>
      okCall(person, "batch_control", { batchId, action: "rerun_failed" }),
    );
    assert(again.length === 1, `rerun listed ${again.length}`);
    const rerun = await beginRun(host, again[0] as Occurrence, 1, t + 3 * HOUR);
    assert(rerun.runId !== failed.runId, "the rerun reused the failed run's id");
    await host.end(String(rerun.runId), 1, outcome({ start: t + 3 * HOUR, output: "ok" }));
  });
  await h.run("batch_control of an absent batch is batch_not_found", async () => {
    const r = await person.call("batch_control", { batchId: "batch_absent", action: "pause" });
    expectPublicError(r, "batch_not_found", "batch_control");
  });
}

// ── Events ───────────────────────────────────────────────────────────────

function event(id: string, now: number, extra: Obj = {}): Obj {
  return {
    id,
    source: "conformance",
    name: "thing.happened",
    level: "attention",
    title: `t-${id}`,
    receivedAt: at(now),
    ...extra,
  };
}

async function eventCases(c: FullCtx): Promise<void> {
  const { h, audit } = c;
  const { host, person } = scenario(c, "events");
  const t = CLOCK_START;
  const offer = (taskId: string, ev: Obj, now: number) =>
    okCall(host.conn.as({ owner: c.opts.owner }), "offer_event", {
      version: VERSION,
      taskId,
      event: ev,
      now: at(now),
    });
  const debounceMs = 60_000;
  let taskId = "";
  let occ: Occurrence = { key: "", ref: "" };
  const titleA = marker(audit, "evA");
  const titleB = marker(audit, "evB");
  await h.run("an accepted event opens an occurrence due at its now plus debounceMs", async () => {
    taskId = await createTask(
      person,
      {
        name: taskName(audit, "event"),
        schedule: { match: { source: "conformance" }, debounceMs },
      },
      "react",
    );
    eq((await offer(taskId, event("a", t, { title: titleA }), t)).accepted, true, "accepted");
    const { occurrences } = await host.dueAll(t, t + DAY);
    assert(occurrences.length === 1, `${occurrences.length} occurrences`);
    occ = occurrences[0] as Occurrence;
    eq(occ.notBefore, at(t + debounceMs), "notBefore");
  });
  await h.run(
    "events join the pending occurrence; a repeated (source, id) adds nothing",
    async () => {
      await offer(taskId, event("a", t + 5000, { title: titleA }), t + 5000);
      eq(
        (await offer(taskId, event("b", t + 10_000, { title: titleB }), t + 10_000)).accepted,
        true,
        "b",
      );
      const { occurrences } = await host.dueAll(t + 10_000, t + DAY);
      eq(occurrences, [occ], "occurrences");
    },
  );
  await h.run("the event run carries its events in notes, never in its prompt", async () => {
    const answer = await beginRun(host, occ, 1, t + debounceMs);
    const work = obj(answer.work, "work");
    const notes = (Array.isArray(work.notes) ? work.notes : []).join("\n");
    eq(notes.split(titleA).length - 1, 1, "times the repeated event is in notes");
    assert(notes.includes(titleB), "the second event is not in notes");
    assert(!String(work.prompt).includes(titleA), "an event is in the prompt");
    eq(work.prompt, "react", "prompt");
    if (work.trigger !== undefined) eq(work.trigger, "event", "trigger");
    await host.end(String(answer.runId), 1, outcome({ start: t + debounceMs, output: "ok" }));
  });
  await eventRefusalCases(c, host, person, offer, taskId);
}

type Offer = (taskId: string, ev: Obj, now: number) => Promise<Obj>;

async function eventRefusalCases(
  c: FullCtx,
  host: Host,
  person: Conn,
  offer: Offer,
  taskId: string,
) {
  const { h, audit } = c;
  const t = CLOCK_START + DAY;
  await h.run("an event the task's match does not want is skipped", async () => {
    const out = await offer(taskId, event("x", t, { source: "elsewhere" }), t);
    eq([out.accepted, out.outcome], [false, "skipped"], "answer");
  });
  await h.run("an event for a task with no event schedule is denied", async () => {
    const plain = await createTask(person, { name: taskName(audit, "noevent") }, "x");
    const out = await offer(plain, event("y", t), t);
    eq([out.accepted, out.outcome], [false, "denied"], "answer");
  });
  await h.run("an event for an absent task is task_not_found", async () => {
    const args = { version: VERSION, taskId: "no-such-task", event: event("z", t), now: at(t) };
    expectCode(await host.conn.call("offer_event", args), "task_not_found", "offer_event");
  });
  await h.run(
    "the fire ceiling, counted on the host's now, disables the task and refuses the event",
    async () => {
      const capped = await createTask(
        person,
        {
          name: taskName(audit, "ceiling"),
          schedule: { match: { source: "conformance" }, debounceMs: 1000, maxFiresPerHour: 1 },
        },
        "once an hour",
      );
      eq((await offer(capped, event("c1", t), t)).accepted, true, "the first event");
      const { occurrences } = await host.dueAll(t, t + DAY);
      assert(occurrences.length === 1, `${occurrences.length} occurrences`);
      const answer = await beginRun(host, occurrences[0] as Occurrence, 1, t + 1000);
      await host.end(String(answer.runId), 1, outcome({ start: t + 1000, output: "ok" }));
      const out = await offer(capped, event("c2", t + 10 * MINUTE), t + 10 * MINUTE);
      eq(out.accepted, false, "the event past the ceiling");
      eq(
        obj((await okCall(person, "status", { taskId: capped })).task, "task").enabled,
        false,
        "enabled",
      );
    },
  );
}

// ── Workspace deletion and retention ─────────────────────────────────────

async function deleteWorkspaceCases(c: FullCtx): Promise<void> {
  const { h, audit } = c;
  const a = scenario(c, "purge");
  const b = scenario(c, "purge", `${c.opts.owner}-b`);
  const t = CLOCK_START;
  await h.run("delete_workspace answers a person with forbidden and deletes nothing", async () => {
    const taskId = await createTask(a.person, { name: taskName(audit, "keep") }, "k");
    expectForbidden(
      await a.person.call("delete_workspace", { version: VERSION }),
      "delete_workspace",
    );
    await okCall(a.person, "status", { taskId });
  });
  await h.run(
    "delete_workspace purges every owner's tasks, runs and batches, idempotently",
    async () => {
      const taskA = await createTask(a.person, { name: taskName(audit, "pa") }, "a");
      const { runId, occ } = await requestRun(a.host, a.person, taskA, t);
      const answer = await beginRun(a.host, occ, 1, t);
      await a.host.end(String(answer.runId), 1, outcome({ start: t }));
      const taskB = await createTask(b.person, { name: taskName(audit, "pb") }, "b");
      const batchId = obj(
        (await okCall(b.person, "run_batch", { taskId: taskB, items: [1] })).batch,
        "b",
      ).id;
      const out = await okCall(a.host.conn, "delete_workspace", { version: VERSION });
      const removed = obj(out.removed, "removed");
      assert(
        Number(removed.tasks) >= 3 && Number(removed.runs) >= 1 && Number(removed.batches) >= 1,
        `removed ${canonical(removed)}`,
      );
      expectPublicError(
        await a.person.call("status", { taskId: taskA }),
        "task_not_found",
        "a's task",
      );
      expectPublicError(await a.person.call("run_result", { runId }), "run_not_found", "a's run");
      expectPublicError(
        await b.person.call("status", { taskId: taskB }),
        "task_not_found",
        "b's task",
      );
      expectPublicError(await b.person.call("batch", { batchId }), "batch_not_found", "b's batch");
      eq(list((await okCall(b.person, "list", { kind: "all" })).tasks, "tasks"), [], "b's list");
      eq((await a.host.dueAll(t, t + DAY)).occurrences, [], "due");
      const again = await okCall(a.host.conn, "delete_workspace", { version: VERSION });
      eq(again.removed, { tasks: 0, runs: 0, batches: 0 }, "the second purge");
      await createTask(a.person, { name: taskName(audit, "after") }, "the workspace is the host's");
    },
  );
}

async function retentionCases(c: FullCtx): Promise<void> {
  const { h, audit } = c;
  const { host, person } = scenario(c, "retention");
  const t = CLOCK_START;
  await h.run("due's now past retention removes ended runs but never an open run", async () => {
    const taskId = await createTask(person, { name: taskName(audit, "ret") }, "r");
    const ended = await requestRun(host, person, taskId, t);
    await beginRun(host, ended.occ, 1, t);
    await host.end(ended.runId, 1, outcome({ start: t, output: "old" }));
    const open = await requestRun(host, person, taskId, t + MINUTE);
    await beginRun(host, open.occ, 1, t + MINUTE);
    const queued = str((await okCall(person, "run", { taskId })).runId, "runId");
    const future = t + 50 * 365 * DAY;
    await host.due(future, future + DAY);
    expectPublicError(
      await person.call("run_result", { runId: ended.runId }),
      "run_not_found",
      "the ended run",
    );
    eq((await execution(person, open.runId)).execution, "running", "the open run");
    eq((await execution(person, queued)).execution, "queued", "the queued run");
    await host.end(open.runId, 1, outcome({ start: future, output: "late" }));
  });
}

// ── The change hint ──────────────────────────────────────────────────────

const hintUri = (workspace: string) => `tasks://due/${workspace}`;

async function hintClient(c: FullCtx, ctx: Context): Promise<Client> {
  return newClient(c.opts, () => ctx);
}

/** Subscribe to `uri` in the negotiated era's way: `subscriptions/listen` on 2026-07-28. */
async function subscribe(client: Client, uri: string): Promise<() => Promise<void>> {
  if (client.getNegotiatedProtocolVersion() === "2026-07-28") {
    const sub = await client.listen({ resourceSubscriptions: [uri] });
    return () => sub.close();
  }
  await client.subscribeResource({ uri });
  return async () => {};
}

async function hintCases(c: FullCtx): Promise<void> {
  const { h, opts } = c;
  const { workspace, person } = scenario(c, "hint");
  const owner = opts.owner as string;
  const uri = hintUri(workspace);
  const refused: Array<[string, Context, string]> = [
    ["a person", { workspace, owner, principal: "person" }, uri],
    ["another workspace's URI", { workspace, principal: "host" }, hintUri(`${workspace}-other`)],
    ["no workspace", { principal: "host" }, uri],
  ];
  await h.run("tasks://due/<workspace> reads {} for the host of that workspace", async () => {
    const client = await hintClient(c, { workspace, principal: "host" });
    try {
      const read = await client.readResource({ uri }, { cacheMode: "bypass" });
      const text = (read.contents[0] as { text?: string } | undefined)?.text ?? "";
      eq(JSON.parse(text), {}, "contents");
    } finally {
      await client.close();
    }
  });
  await h.run(
    "reading the hint is refused to a person, another workspace and no workspace",
    async () => {
      for (const [, ctx, target] of refused) {
        const client = await hintClient(c, ctx);
        try {
          await expectRpcError(
            () => client.readResource({ uri: target }, { cacheMode: "bypass" }),
            -32602,
            "forbidden",
          );
        } finally {
          await client.close();
        }
      }
    },
  );
  await h.run(
    "subscribing to the hint is refused to a person, another workspace and no workspace",
    async () => {
      for (const [, ctx, target] of refused) {
        const client = await hintClient(c, ctx);
        try {
          await expectRpcError(() => subscribe(client, target), -32602, "forbidden");
        } finally {
          await client.close();
        }
      }
    },
  );
  await hintUpdateCase(c, workspace, person);
}

async function hintUpdateCase(c: FullCtx, workspace: string, person: Conn): Promise<void> {
  const uri = hintUri(workspace);
  await c.h.run("the host's subscription is told when due changes", async () => {
    const client = await hintClient(c, { workspace, principal: "host" });
    let updates = 0;
    client.setNotificationHandler("notifications/resources/updated", (n) => {
      if (n.params.uri === uri) updates++;
    });
    const close = await subscribe(client, uri);
    const waitFor = async (what: string, before: number) => {
      for (let i = 0; i < 100 && updates === before; i++) await Bun.sleep(20);
      assert(updates > before, `no notifications/resources/updated after ${what}`);
    };
    try {
      let n = updates;
      const taskId = await createTask(
        person,
        { name: taskName(c.audit, "hint"), schedule: { intervalMs: HOUR } },
        "h",
      );
      await waitFor("a scheduled create", n);
      n = updates;
      const runId = str((await okCall(person, "run", { taskId })).runId, "runId");
      await waitFor("a run", n);
      n = updates;
      await okCall(person, "cancel", { runId });
      await waitFor("a cancel", n);
    } finally {
      await close();
      await client.close();
    }
  });
}

// ── Closing checks ───────────────────────────────────────────────────────

async function closingCases(c: FullCtx): Promise<void> {
  const { h, audit } = c;
  await h.run("a grant never appears outside begin_run's run answer", async () => {
    assert(audit.calls > 0 && audit.grants.size > 0, "nothing was audited");
    eq(audit.grantLeaks, [], "leaks");
  });
  await h.run("notices carry no task name, prompt, input, output or error text", async () => {
    eq(audit.noticeLeaks, [], "leaks");
  });
  await h.run("every error is from the contract's closed lists, with its prefix", async () => {
    eq(audit.errorViolations, [], "violations");
  });
  await h.run(
    "due's cancel names only runs the host began whose end_run has not landed",
    async () => {
      eq(audit.cancelViolations, [], "violations");
    },
  );
}

// ── The full run ─────────────────────────────────────────────────────────

const FLOW_GROUPS: Array<[string, (c: FullCtx) => Promise<void>]> = [
  ["forbidden", forbiddenCases],
  ["unattended", unattendedCases],
  ["scope", scopeCases],
  ["walls", wallCases],
  ["grant_missing", grantMissingCase],
  ["grants", grantCases],
  ["clock", clockCases],
  ["once", onceCases],
  ["paging", pagingCases],
  ["fencing", fencingCases],
  ["run flow", runFlowCases],
  ["cancel", cancelCases],
  ["assessment", assessmentCases],
  ["batches", batchCases],
  ["events", eventCases],
  ["delete_workspace", deleteWorkspaceCases],
  ["retention", retentionCases],
  ["hint", hintCases],
];

async function fullSuite(h: Harness, opts: RunnerOptions, audit: Audit): Promise<void> {
  const workspace = opts.workspace as string;
  const owner = opts.owner as string;
  const base = await connect(opts, { workspace, owner, principal: "host" }, audit);
  const c: FullCtx = { h, opts, audit, base, made: [] };
  try {
    await surfaceCases(c, base);
    if (!opts.scratchWorkspace) {
      for (const [group] of FLOW_GROUPS) h.skip(`${group} cases`, "no --scratch-workspace");
      return;
    }
    for (const [group, run] of FLOW_GROUPS) {
      try {
        await run(c);
      } catch (err) {
        h.results.push({ name: `${group} setup`, status: "fail", detail: String(err) });
      }
    }
    await closingCases(c);
  } finally {
    for (const ws of c.made) {
      await base.call("delete_workspace", { version: VERSION }, { workspace: ws }).catch(() => {});
    }
    await base.close();
  }
}

// ── Public tools, as a person ────────────────────────────────────────────

async function publicSuite(h: Harness, opts: RunnerOptions, audit: Audit): Promise<void> {
  const grant = newGrant(audit, "public");
  const conn = await connect(
    opts,
    { workspace: opts.workspace, owner: opts.owner, principal: "person", grant },
    audit,
  );
  try {
    await h.run("tools/list matches the public tools' schemas", async () =>
      checkToolList(await conn.listTools(), PUBLIC_TOOLS),
    );
    await h.run("no private tool is listed", async () =>
      checkAbsent(await conn.listTools(), PRIVATE_TOOLS),
    );
    await h.run("a private tool called here is refused", async () => {
      let refused = false;
      try {
        refused = (await conn.call("due", privateArgs(CLOCK_START).due ?? {})).isError === true;
      } catch {
        refused = true; // a JSON-RPC error refuses too
      }
      assert(refused, "due answered");
    });
    await h.run("every tool allowed unattended is annotated readOnlyHint", async () =>
      checkReadOnlyHints(await conn.listTools()),
    );
    await screenCases(h, conn);
    await h.run("invalid arguments are invalid_input naming the tool", async () => {
      expectPublicError(await conn.call("create", {}), "invalid_input", "create", '"create"');
    });
    await h.run("status of an absent task is task_not_found naming it", async () => {
      expectPublicError(
        await conn.call("status", { taskId: "no-such-task" }),
        "task_not_found",
        "status",
        "",
      );
    });
    await h.run("create, read, update and delete a task", async () => {
      const name = `Conformance public ${Math.random().toString(36).slice(2, 10)}`;
      const taskId = await createTask(conn, { name }, "first");
      const tasks = list((await okCall(conn, "list", {})).tasks, "tasks");
      assert(
        tasks.some((t) => t.id === taskId),
        "not listed",
      );
      await okCall(conn, "update", { taskId, body: "second" });
      eq(obj((await okCall(conn, "status", { taskId })).task, "task").prompt, "second", "prompt");
      eq((await okCall(conn, "delete", { taskId })).deleted, true, "deleted");
      expectPublicError(
        await conn.call("status", { taskId }),
        "task_not_found",
        "status after delete",
      );
    });
    await h.run("the reads answer", async () => {
      for (const tool of ["runs", "upcoming", "stats", "batches"]) await okCall(conn, tool, {});
    });
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
      "the whole contract states several scopes and both principals: use --carriage meta, " +
        "or check a host's door with --public-only",
    );
  }
  const results: CaseResult[] = [];
  const h = harness(opts, results);
  const audit = newAudit();
  if (opts.publicOnly) await publicSuite(h, opts, audit);
  else await fullSuite(h, opts, audit);
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
    const eqAt = kv.indexOf("=");
    if (eqAt <= 0) throw new Error(`--header wants k=v, got ${kv}`);
    headers[kv.slice(0, eqAt)] = kv.slice(eqAt + 1);
  }
  const bearerEnv = one("bearer-env");
  if (bearerEnv) {
    const token = process.env[bearerEnv];
    if (!token) throw new Error(`--bearer-env ${bearerEnv}: the variable is empty`);
    headers.authorization = `Bearer ${token}`;
  }
  const carriage = one("carriage") ?? "none";
  if (carriage !== "none" && carriage !== "meta") {
    throw new Error(`--carriage must be none or meta, got ${carriage}`);
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
