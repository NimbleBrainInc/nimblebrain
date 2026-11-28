#!/usr/bin/env bun
/**
 * Black-box conformance runner for `ai.nimblebrain.files` 1.0.
 *
 * It speaks only MCP to an implementation (Streamable HTTP at a URL, or stdio to a command
 * it starts), and HTTP to the transfer URLs it is answered, and reads only the contract's
 * published document (`schemas/contracts/files/v1/contract.json`: tools, visibility,
 * unattended marking, annotations, schemas, errors). It imports no implementation code, so
 * it checks an implementation in any language.
 *
 *   bun --no-env-file contracts/files/runner/conformance.ts \
 *     (--server <url> | --command <cmd> [--arg <a>]...) [--public-only] \
 *     [transport options] --workspace <id> --owner <id> [--skip <text>]... [--wait-grace]
 *
 * The runner plays the host: it states the host context on every call (principal,
 * workspace, owner, conversation, run), so it reaches every wall the contract states. The
 * implementation keeps its own clock; the runner reads each `expiresAt` against its own
 * wall clock.
 *
 * Modes.
 *   (full)                 every tool, public and private, under several scopes and both
 *                          principals; --carriage must be meta (stdio is always meta). An
 *                          implementation is conformant when this passes.
 *   --public-only          only the public tools, as a person, and that no private tool is
 *                          listed or answers a call: how a host's agent-facing door is
 *                          checked.
 *
 * Transport options. How this runner reaches an implementation; not part of the contract.
 *   --server <url>         the implementation's Streamable HTTP endpoint
 *   --command <cmd>        start the implementation and speak MCP on its stdio
 *   --arg <a>              an argument to --command (repeatable, in order)
 *   --header <k=v>         an extra header on every MCP request (repeatable)
 *   --bearer-env <VAR>     send `Authorization: Bearer $VAR`; the value is never printed
 *   --carriage <c>         none (the connection fixes scope and principal; --public-only
 *                          only) or meta (the host context on each call)
 *   --protocol-version <v> pin this MCP revision instead of negotiating
 *   --tool-prefix <p>      the tools are listed as <p><tool>; only those are judged
 *
 * Scope options.
 *   --workspace <id>       a disposable workspace. The full run also uses `<id>-other`, and
 *                          purges both with delete_workspace when it ends.
 *   --owner <id>           the scope's owner. The full run also uses `<id>-other`.
 *   --skip <text>          skip every case whose name contains <text> (repeatable)
 *   --wait-grace           also check that an upload past its 300-second completion window
 *                          is upload_not_found, which waits that long
 *
 * Timing cases. An upload URL expires at most 900 s after issue and a download URL at most
 * 300 s. The cases that need a URL to expire run when the implementation issues URLs that
 * expire within 15 seconds (an implementation option, such as nb-files' --upload-ttl and
 * --download-ttl), and are skipped, saying so, otherwise.
 *
 * Output: one line per case (`ok`, `FAIL`, `skip`), then a total. Exit 0 when no case
 * fails, 1 when one does, 2 on bad arguments.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

// ── Options and results ──────────────────────────────────────────────────

export type Carriage = "none" | "meta";
export type Principal = "host" | "person";

export interface RunnerOptions {
  server?: string;
  command?: string;
  args?: string[];
  /** Environment for --command; the runner's own PATH when absent. */
  env?: Record<string, string>;
  publicOnly?: boolean;
  headers?: Record<string, string>;
  carriage?: Carriage;
  workspace?: string;
  owner?: string;
  protocolVersion?: string;
  toolPrefix?: string;
  skip?: string[];
  waitGrace?: boolean;
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

const CONTRACT_PATH = resolve(import.meta.dir, "../../../schemas/contracts/files/v1/contract.json");
const HOST_CONTEXT_META_KEY = "ai.nimblebrain/context";
const MCP_APP_MIME = "text/html;profile=mcp-app";
const SCREEN_URI = "ui://files/browser";
const VERSION = "1.0";
const DEFS_PREFIX = "#/$defs/";
const MIB = 1024 * 1024;
/** The characters a URL path carries unescaped, beyond `.` and `~`: base64url's alphabet. */
const URL_SAFE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
/** Bounds of the contract (CONTRACT.md §6, §7, §12). */
const MAX_CREATE_BYTES = 4 * MIB;
const MAX_READ_TEXT_BYTES = MIB;
/** The MCP request body a server reached over HTTP accepts at least (CONTRACT.md §7). */
const MIN_REQUEST_BYTES = 8 * MIB;
const DOWNLOAD_TTL_S = 300;
const UPLOAD_TTL_S = 900;
const GRACE_S = 300;
/** Clock skew allowed between the runner and the implementation. */
const SKEW_MS = 5_000;
/** A URL that expires within this is short enough to wait out. */
const SHORT_TTL_MS = 15_000;
/** Fields a host owns on a PUT and an upload's `headers` must never name (CONTRACT.md §7). */
const HOST_OWNED_HEADERS = [
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "upgrade",
  "expect",
  "te",
  "trailer",
  "keep-alive",
  "cookie",
  "authorization",
];

type Obj = Record<string, unknown>;

interface ContractTool {
  visibility: "public" | "private";
  unattended: "allowed" | "refused";
  annotations?: Record<string, boolean>;
  input: { $ref: string };
  output: { $ref: string };
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

const PRIVATE_CODES = new Set(CONTRACT.errors.private.map((e) => e.code));
const PUBLIC_CODES = new Map(CONTRACT.errors.public.map((e) => [e.code, e.prefix]));

/** The allowlist, as the document's `create` input states it (CONTRACT.md §7). */
const ALLOWLIST: readonly string[] = (() => {
  const create = CONTRACT.$defs.create_input as {
    properties: { manifest: { properties: { mimeType: { description: string } } } };
  };
  const text = create.properties.manifest.properties.mimeType.description;
  return text
    .slice(text.indexOf("one of:") + 7, text.indexOf(". A generic"))
    .split(",")
    .map((s) => s.trim());
})();

function publicPrefix(code: string): string {
  const prefix = PUBLIC_CODES.get(code);
  if (prefix === undefined) throw new Error(`the contract has no public error "${code}"`);
  return prefix;
}

/** A tool's schema as a server lists it: the `$defs` entry its `$ref` names (CONTRACT.md §1). */
export function contractSchema(tool: string, kind: "input" | "output"): Obj {
  const entry = CONTRACT.tools[tool];
  if (!entry) throw new Error(`the contract has no tool "${tool}"`);
  const ref = entry[kind].$ref;
  if (!ref.startsWith(DEFS_PREFIX)) throw new Error(`unsupported $ref ${ref}`);
  const schema = CONTRACT.$defs[ref.slice(DEFS_PREFIX.length)];
  if (!schema) throw new Error(`${tool} ${kind} schema is missing`);
  return schema;
}

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(CONTRACT);

function validateOutput(tool: string, value: unknown): void {
  const entry = CONTRACT.tools[tool];
  if (!entry) throw new Error(`the contract has no tool "${tool}"`);
  const validate = ajv.getSchema(new URL(entry.output.$ref, CONTRACT.$id).href);
  if (!validate) throw new Error(`${entry.output.$ref} does not resolve in the contract`);
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
  if (v === undefined) return "undefined";
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
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── What the whole run watches ───────────────────────────────────────────

/**
 * Facts gathered from every answer, judged by the closing cases: no transfer URL and no
 * binary body may appear in a public output or any error, and every error must be from the
 * closed lists.
 */
interface Audit {
  urls: Set<string>;
  bodies: Set<string>;
  leaks: string[];
  errorViolations: string[];
  calls: number;
}

function newAudit(): Audit {
  return { urls: new Set(), bodies: new Set(), leaks: [], errorViolations: [], calls: 0 };
}

// ── Connections ──────────────────────────────────────────────────────────

/** The host context one connection's calls carry. */
interface Context {
  workspace?: string;
  owner?: string;
  principal?: Principal;
  conversation?: string;
  run?: string;
  unattended?: boolean;
}

/** A per-call change to the context: `null` removes a field. */
type Over = { [K in keyof Context]?: Context[K] | null };

interface CallResult {
  isError?: boolean;
  structuredContent?: Obj;
  content?: Array<{ type: string; text?: string; uri?: string; [k: string]: unknown }>;
}

export interface ListedTool {
  name: string;
  description?: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  annotations?: Record<string, unknown>;
}

interface Conn {
  ctx: Context;
  client: Client;
  call(tool: string, args: Obj, over?: Over): Promise<CallResult>;
  listTools(): Promise<ListedTool[]>;
  as(patch: Over): Conn;
  close(): Promise<void>;
}

function merged(ctx: Context, over: Over = {}): Context {
  const out: Record<string, unknown> = { ...ctx };
  for (const [k, v] of Object.entries(over)) {
    if (v === null) delete out[k];
    else if (v !== undefined) out[k] = v;
  }
  return out as Context;
}

/** The host context object as the host stamps it. */
function contextObject(ctx: Context): Obj {
  return {
    ...(ctx.principal ? { principal: ctx.principal } : {}),
    ...(ctx.workspace ? { workspaceId: ctx.workspace } : {}),
    ...(ctx.owner ? { ownerId: ctx.owner } : {}),
    ...(ctx.conversation ? { conversationId: ctx.conversation } : {}),
    ...(ctx.run ? { runId: ctx.run } : {}),
    ...(ctx.unattended !== undefined ? { unattended: ctx.unattended } : {}),
  };
}

async function newClient(opts: RunnerOptions): Promise<Client> {
  const client = new Client(
    { name: "files-contract-conformance", version: "1.0.0" },
    {
      versionNegotiation: { mode: opts.protocolVersion ? { pin: opts.protocolVersion } : "auto" },
    },
  );
  if (opts.command) {
    await client.connect(
      new StdioClientTransport({
        command: opts.command,
        args: opts.args ?? [],
        env: opts.env ?? { PATH: process.env.PATH ?? "" },
      }),
    );
    return client;
  }
  const headers = opts.headers ?? {};
  await client.connect(
    new StreamableHTTPClientTransport(new URL(opts.server as string), {
      fetch: (input, init) => {
        const h = new Headers(init?.headers);
        for (const [k, v] of Object.entries(headers)) h.set(k, v);
        return fetch(input, { ...init, headers: h });
      },
    }),
  );
  return client;
}

function makeConn(opts: RunnerOptions, client: Client, ctx: Context, audit: Audit): Conn {
  const carriage = opts.command ? "meta" : (opts.carriage ?? "none");
  const prefix = opts.toolPrefix ?? "";
  return {
    ctx,
    client,
    call: async (tool, args, over) => {
      const c = merged(ctx, over);
      const meta = carriage === "meta" ? { [HOST_CONTEXT_META_KEY]: contextObject(c) } : undefined;
      const r = (await client.callTool({
        name: `${prefix}${tool}`,
        arguments: args,
        ...(meta ? { _meta: meta } : {}),
      })) as CallResult;
      auditAnswer(audit, tool, r);
      return r;
    },
    listTools: async () =>
      ((await client.listTools()).tools as ListedTool[])
        .filter((t) => t.name.startsWith(prefix))
        .map((t) => ({ ...t, name: t.name.slice(prefix.length) })),
    as: (patch) => makeConn(opts, client, merged(ctx, patch), audit),
    close: () => client.close(),
  };
}

async function connect(opts: RunnerOptions, ctx: Context, audit: Audit): Promise<Conn> {
  return makeConn(opts, await newClient(opts), ctx, audit);
}

// ── The audit of every answer ────────────────────────────────────────────

function firstText(r: CallResult): string {
  return r.content?.find((c) => c.type === "text")?.text ?? "";
}

function auditAnswer(audit: Audit, tool: string, r: CallResult): void {
  audit.calls++;
  const visibility = CONTRACT.tools[tool]?.visibility ?? "public";
  if (r.isError) auditError(audit, tool, r, visibility);
  if (r.isError || visibility === "public") auditLeaks(audit, tool, r);
}

function auditError(audit: Audit, tool: string, r: CallResult, visibility: string): void {
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

/** Every transfer URL issued so far, and every binary body sent, must be absent here. */
function auditLeaks(audit: Audit, tool: string, r: CallResult): void {
  const text = `${JSON.stringify(r.structuredContent ?? null)}\n${JSON.stringify(r.content ?? [])}`;
  for (const url of audit.urls) {
    const token = url.slice(url.lastIndexOf("/") + 1);
    if (text.includes(url) || (token.length >= 16 && text.includes(token))) {
      audit.leaks.push(`${tool} answered a transfer URL`);
    }
  }
  for (const body of audit.bodies) {
    if (text.includes(body)) audit.leaks.push(`${tool} answered a body`);
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

function expectForbidden(r: CallResult, what: string): void {
  if (r.isError !== true) throw new Error(`${what}: a non-host call succeeded`);
  const { code } = JSON.parse(firstText(r) || "{}") as { code?: string };
  if (code !== "forbidden") throw new Error(`${what}: code ${String(code)}, want forbidden`);
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

// ── Fixtures ─────────────────────────────────────────────────────────────

let serial = 0;
function unique(what: string): string {
  return `${what}-${(++serial).toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** A binary body no public output may carry: its base64 and a hex marker are audited. */
function binaryBody(audit: Audit): Buffer {
  const marker = `zqbody${unique("m").replace(/-/g, "")}`;
  const bytes = Buffer.concat([Buffer.from([0, 1, 2, 255, 254]), Buffer.from(marker)]);
  audit.bodies.add(marker);
  audit.bodies.add(bytes.toString("base64"));
  return bytes;
}

/** An uncompressed PDF whose page `i` shows `texts[i]` (no text when empty). */
export function pdfOf(texts: string[]): Buffer {
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const kids: string[] = [];
  for (const text of texts) {
    const content = text ? `BT /F1 12 Tf 72 720 Td (${text}) Tj ET` : "";
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    const contents = objects.length;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contents} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
    );
    kids.push(`${objects.length} 0 R`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${texts.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out);
}

interface Made {
  id: string;
  filename: string;
  size: number;
}

/** Create a file through `create`, base64. */
async function createFile(
  conn: Conn,
  manifest: Obj,
  body: Buffer | string,
  over?: Over,
): Promise<Made> {
  const args =
    typeof body === "string"
      ? { manifest, body, encoding: "text" }
      : { manifest, body: body.toString("base64") };
  const out = await okCall(conn, "create", args, over);
  return { id: str(out.id, "id"), filename: str(out.filename, "filename"), size: Number(out.size) };
}

// ── Transfers ────────────────────────────────────────────────────────────

/** Record a transfer URL so the audit can catch it anywhere public, and check its shape. */
function transferUrl(audit: Audit, url: unknown, what: string): string {
  const u = str(url, what);
  audit.urls.add(u);
  return u;
}

async function get(url: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, { method: "GET", headers, redirect: "manual" });
}

/** An upload's transfer: its URL and the headers its PUT must carry (CONTRACT.md §7). */
interface Grant {
  url: string;
  headers: Obj;
}

/** PUT a body to an upload's URL with every header `begin_upload` returned for it. */
async function put(up: Grant, body: Uint8Array): Promise<Response> {
  const headers = up.headers as Record<string, string>;
  return fetch(up.url, { method: "PUT", body, headers, redirect: "manual" });
}

/** The body a GET answers, checked for status 200, its length and its encoding. */
async function download(url: string): Promise<Buffer> {
  const res = await get(url);
  assert(res.status === 200, `GET answered ${res.status}`);
  const enc = res.headers.get("content-encoding");
  assert(!enc || enc === "identity", `GET answered Content-Encoding ${enc}`);
  const body = Buffer.from(await res.arrayBuffer());
  assert(
    res.headers.get("content-length") === String(body.length),
    `Content-Length ${res.headers.get("content-length")} for ${body.length} bytes`,
  );
  return body;
}

function isLoopbackUrl(url: string): boolean {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  return host === "::1" || /^127(\.\d{1,3}){3}$/.test(host) || host === "localhost";
}

/** CONTRACT.md §7: absolute http(s), at most 4096 characters, no userinfo, expiring in bound. */
function checkTransferUrl(url: string, expiresAt: unknown, ttlSeconds: number, issuedAt: number) {
  assert(url.length <= 4096, `a transfer URL of ${url.length} characters`);
  const u = new URL(url);
  assert(u.protocol === "http:" || u.protocol === "https:", `scheme ${u.protocol}`);
  assert(u.username === "" && u.password === "", "a transfer URL carries userinfo");
  const at = Date.parse(str(expiresAt, "expiresAt"));
  assert(Number.isFinite(at), `expiresAt ${String(expiresAt)} is not an instant`);
  assert(
    at <= issuedAt + ttlSeconds * 1000 + SKEW_MS,
    `expiresAt is ${Math.round((at - issuedAt) / 1000)} s after issue, past ${ttlSeconds} s`,
  );
  assert(at > issuedAt - SKEW_MS, "expiresAt is already past");
}

// ── The full run ─────────────────────────────────────────────────────────

interface FullCtx {
  h: Harness;
  opts: RunnerOptions;
  audit: Audit;
  /** The host, walled to the run's workspace and owner. */
  host: Conn;
  /** A person, the same owner in the same workspace. */
  person: Conn;
  ws: string;
  ws2: string;
  owner: string;
  owner2: string;
}

async function upload(
  c: FullCtx,
  body: Buffer,
  meta: Obj = {},
  over?: Over,
): Promise<{ uploadId: string; url: string; expiresAt: string; issuedAt: number; headers: Obj }> {
  const issuedAt = Date.now();
  const out = await okCall(
    c.host,
    "begin_upload",
    {
      version: VERSION,
      filename: "upload.bin",
      mimeType: "application/octet-stream",
      size: body.length,
      source: "manual",
      ...meta,
    },
    over,
  );
  return {
    uploadId: str(out.uploadId, "uploadId"),
    url: transferUrl(c.audit, out.url, "url"),
    expiresAt: str(out.expiresAt, "expiresAt"),
    headers: obj(out.headers, "headers"),
    issuedAt,
  };
}

async function putOk(up: Grant, body: Buffer): Promise<void> {
  const res = await put(up, body);
  assert(res.status >= 200 && res.status < 300, `PUT answered ${res.status}`);
}

/** Resolve one URI as the host and answer its entry. */
async function resolveOne(conn: Conn, id: string, over?: Over): Promise<Obj> {
  const out = await okCall(conn, "resolve", { version: VERSION, uris: [`files://${id}`] }, over);
  return list(out.files, "files")[0] as Obj;
}

async function downloadUrl(c: FullCtx, id: string, over?: Over): Promise<string> {
  const entry = await resolveOne(c.host, id, over);
  assert(entry.found === true, `files://${id} is not found`);
  return transferUrl(c.audit, obj(entry.download, "download").url, "download.url");
}

async function surfaceCases(c: FullCtx): Promise<void> {
  const { h, host } = c;
  await h.run("tools/list lists every tool with the document's schemas", async () => {
    const tools = await host.listTools();
    const listed = new Map(tools.map((t) => [t.name, t]));
    for (const name of [...PUBLIC_TOOLS, ...PRIVATE_TOOLS]) {
      const t = listed.get(name);
      assert(t, `${name} is not listed`);
      eq(t.inputSchema, contractSchema(name, "input"), `${name} inputSchema`);
      eq(t.outputSchema, contractSchema(name, "output"), `${name} outputSchema`);
      assert(t.description && t.description.length > 0, `${name} has no description`);
    }
  });
  await h.run(
    "every public tool lists the document's annotations; no private tool has any",
    async () => {
      const tools = new Map((await host.listTools()).map((t) => [t.name, t]));
      for (const name of PUBLIC_TOOLS) {
        const want = CONTRACT.tools[name]?.annotations;
        assert(want, `the document states no annotations for ${name}`);
        const got = tools.get(name)?.annotations ?? {};
        for (const [k, v] of Object.entries(want)) {
          assert(got[k] === v, `${name}.${k} is ${String(got[k])}, want ${v}`);
        }
      }
      for (const name of PRIVATE_TOOLS) {
        const got = tools.get(name)?.annotations;
        assert(!got || Object.keys(got).length === 0, `${name} is annotated`);
      }
    },
  );
  await h.run("the screen ui://files/browser is served as an MCP App", async () => {
    const read = await host.client.readResource({ uri: SCREEN_URI });
    const part = read.contents[0] as { mimeType?: string; text?: string };
    eq(part.mimeType, MCP_APP_MIME, "mimeType");
    assert(typeof part.text === "string" && part.text.length > 0, "no HTML");
  });
  await h.run("the server advertises the files://{id} resource template", async () => {
    const out = await host.client.listResourceTemplates();
    const templates = out.resourceTemplates.map((t) => t.uriTemplate);
    assert(templates.includes("files://{id}"), `templates: ${templates.join(", ")}`);
  });
  await h.run("an unknown tool is unknown_tool, with its prefix", async () => {
    expectPublicError(await host.call("no_such_tool", {}), "unknown_tool", "no_such_tool");
  });
}

async function principalCases(c: FullCtx): Promise<void> {
  const { h, person, host } = c;
  await h.run(
    "every private tool answers a person with forbidden, before input and scope",
    async () => {
      for (const tool of PRIVATE_TOOLS) {
        expectForbidden(
          await person.call(tool, { version: VERSION, bogus: 1 }),
          `${tool} bad args`,
        );
        expectForbidden(
          await person.call(tool, {}, { workspace: null, owner: null }),
          `${tool} no scope`,
        );
      }
    },
  );
  await h.run("a call that names no principal is not host", async () => {
    for (const tool of PRIVATE_TOOLS) {
      expectForbidden(await host.call(tool, { version: VERSION }, { principal: null }), tool);
    }
  });
  await h.run(
    "forbidden changes nothing: delete_workspace by a person keeps the files",
    async () => {
      const made = await createFile(
        person,
        { filename: "keep.txt", mimeType: "text/plain" },
        "kept",
      );
      expectForbidden(
        await person.call("delete_workspace", { version: VERSION }),
        "delete_workspace",
      );
      await okCall(person, "info", { id: made.id });
    },
  );
  await h.run(
    "the host may call a public tool, walled to an owner, as that owner's call",
    async () => {
      const made = await createFile(
        host,
        { filename: "host.txt", mimeType: "text/plain" },
        "by host",
      );
      const read = await okCall(host, "read", { id: made.id, maxBytes: 100 });
      eq(read.extractedText, "by host", "text");
      await okCall(person, "info", { id: made.id });
      eq((await okCall(host, "delete", { id: made.id })).deleted, true, "deleted");
    },
  );
}

async function scopeCases(c: FullCtx): Promise<void> {
  const { h, person, host } = c;
  await h.run(
    "a public call without a workspace or an owner is scope_missing, writing nothing",
    async () => {
      const before = Number((await okCall(person, "list", {})).total);
      const args = {
        manifest: { filename: "x.txt", mimeType: "text/plain" },
        body: "x",
        encoding: "text",
      };
      expectPublicError(
        await person.call("create", args, { owner: null }),
        "scope_missing",
        "no owner",
      );
      expectPublicError(
        await person.call("create", args, { workspace: null }),
        "scope_missing",
        "no ws",
      );
      expectPublicError(await person.call("list", {}, { owner: null }), "scope_missing", "list");
      eq(Number((await okCall(person, "list", {})).total), before, "total");
    },
  );
  await h.run(
    "begin_upload, complete_upload and resolve need an owner; delete_workspace a workspace",
    async () => {
      const begin = {
        version: VERSION,
        filename: "a.txt",
        mimeType: "text/plain",
        size: 1,
        source: "app",
      };
      expectCode(
        await host.call("begin_upload", begin, { owner: null }),
        "scope_missing",
        "begin_upload",
      );
      expectCode(
        await host.call("complete_upload", { version: VERSION, uploadId: "up_x" }, { owner: null }),
        "scope_missing",
        "complete_upload",
      );
      expectCode(
        await host.call("resolve", { version: VERSION, uris: ["files://x"] }, { owner: null }),
        "scope_missing",
        "resolve",
      );
      expectCode(
        await host.call("delete_workspace", { version: VERSION }, { workspace: null }),
        "scope_missing",
        "delete_workspace",
      );
    },
  );
  await h.run("invalid arguments are invalid_input; a public one names the tool", async () => {
    expectPublicError(await person.call("create", {}), "invalid_input", "create", '"create"');
    expectPublicError(
      await person.call("read", { id: "a", maxBytes: 0 }),
      "invalid_input",
      "read",
      '"read"',
    );
    expectCode(
      await host.call("resolve", { version: VERSION, uris: ["files://x"], extra: true }),
      "invalid_input",
      "resolve with an extra field",
    );
    expectCode(
      await host.call("resolve", { version: "2.0", uris: ["files://x"] }),
      "invalid_input",
      "resolve at version 2.0",
    );
  });
}

async function createCases(c: FullCtx): Promise<void> {
  const { h, person, audit } = c;
  await h.run(
    "create's base64 body round-trips unchanged through resolve and its download URL",
    async () => {
      const body = binaryBody(audit);
      const made = await createFile(
        person,
        { filename: "blob.bin", mimeType: "application/octet-stream" },
        body,
      );
      eq(made.size, body.length, "size");
      const got = await download(await downloadUrl(c, made.id));
      assert(got.equals(body), "the downloaded body differs");
    },
  );
  await h.run('create with encoding "text" stores the body verbatim as UTF-8', async () => {
    const text = "# Notes\n\nnaïve café ✓\n";
    const made = await createFile(
      person,
      { filename: "notes.md", mimeType: "text/markdown" },
      text,
    );
    eq(made.size, Buffer.byteLength(text), "size");
    const got = await download(await downloadUrl(c, made.id));
    eq(got.toString("utf-8"), text, "body");
  });
  await h.run(
    "create refuses unpadded and base64url bodies with invalid_input, writing nothing",
    async () => {
      const before = Number((await okCall(person, "list", {})).total);
      const manifest = { filename: "a.bin", mimeType: "application/octet-stream" };
      for (const body of ["YWJj ZA==", "YWJjZA", "_-8=", "the quick brown fox"]) {
        expectPublicError(
          await person.call("create", { manifest, body }),
          "invalid_input",
          `body ${body}`,
          '"create"',
        );
      }
      eq(Number((await okCall(person, "list", {})).total), before, "total");
    },
  );
  await h.run("create past 4 MiB decoded is too_large", async () => {
    const body = Buffer.alloc(MAX_CREATE_BYTES + 1, 0x61).toString("base64");
    expectPublicError(
      await person.call("create", {
        manifest: { filename: "big.txt", mimeType: "text/plain" },
        body,
      }),
      "too_large",
      "create",
    );
  });
  await h.run(
    "create stores a body of exactly 4 MiB, and a request of nearly 8 MiB reaches the tool",
    async () => {
      const exact = Buffer.alloc(MAX_CREATE_BYTES, 0x62);
      const made = await createFile(
        person,
        { filename: "four.bin", mimeType: "application/octet-stream" },
        exact,
      );
      eq(made.size, MAX_CREATE_BYTES, "size");
      // A request body just under 8 MiB (CONTRACT.md §7): the tool answers it, not the transport.
      const body = "YWJj".repeat((MIN_REQUEST_BYTES - 64 * 1024) / 4);
      expectPublicError(
        await person.call("create", {
          manifest: { filename: "eight.txt", mimeType: "text/plain" },
          body,
        }),
        "too_large",
        "create",
      );
    },
  );
  await h.run("create of a type off the allowlist is type_not_allowed", async () => {
    for (const mimeType of ["application/x-msdownload", "video/mp4", "text/javascript-ish"]) {
      expectPublicError(
        await person.call("create", { manifest: { filename: "x", mimeType }, body: "eA==" }),
        "type_not_allowed",
        mimeType,
      );
    }
  });
  await h.run(
    "create accepts every type on the allowlist, with its parameters and in any case",
    async () => {
      assert(
        ALLOWLIST.length > 20,
        `the allowlist read from the document has ${ALLOWLIST.length} types`,
      );
      for (const mimeType of ALLOWLIST) {
        await createFile(
          person,
          { filename: "allowed", mimeType: `${mimeType.toUpperCase()}; x=1` },
          "a",
        );
      }
    },
  );
  await h.run(
    "create records a known extension's type for a generic one, a specific one as given",
    async () => {
      const cases: Array<[string, string, string]> = [
        ["paper.typ", "application/octet-stream", "text/plain"],
        [".env", "", "text/plain"],
        ["data.YAML", "application/octet-stream; charset=x", "application/yaml"],
        ["Makefile", "", "application/octet-stream"],
        ["a.md", "Text/CSV; charset=utf-8", "Text/CSV; charset=utf-8"],
      ];
      for (const [filename, mimeType, want] of cases) {
        const made = await createFile(person, { filename, mimeType }, "x");
        eq((await okCall(person, "info", { id: made.id })).mimeType, want, filename);
      }
    },
  );
  await h.run("create takes provenance from the context, never from arguments", async () => {
    const conversation = unique("conv");
    const run = unique("run");
    const a = await createFile(person, { filename: "p.txt", mimeType: "text/plain" }, "p", {
      conversation,
      run,
      unattended: true,
    });
    const rec = await okCall(person, "info", { id: a.id });
    eq([rec.conversationId, rec.runId, rec.source], [conversation, run, "agent"], "provenance");
    const b = await createFile(person, { filename: "q.txt", mimeType: "text/plain" }, "q");
    const rec2 = await okCall(person, "info", { id: b.id });
    eq([rec2.conversationId, rec2.runId ?? null], [null, null], "no provenance");
    const filtered = list((await okCall(person, "list", { runId: run })).files, "files");
    eq(
      filtered.map((f) => f.id),
      [a.id],
      "list by runId",
    );
    const byConv = list(
      (await okCall(person, "list", { conversationId: conversation })).files,
      "f",
    );
    eq(
      byConv.map((f) => f.id),
      [a.id],
      "list by conversationId",
    );
  });
  await h.run(
    "create makes the folders manifest.folder names, reusing one case-insensitively",
    async () => {
      const top = unique("Reports");
      const a = await createFile(
        person,
        { filename: "a.txt", mimeType: "text/plain", folder: `${top}/Q3` },
        "a",
      );
      const b = await createFile(
        person,
        { filename: "b.txt", mimeType: "text/plain", folder: `${top.toUpperCase()}/q3` },
        "b",
      );
      const fa = await okCall(person, "info", { id: a.id });
      const fb = await okCall(person, "info", { id: b.id });
      assert(fa.folderId && fa.folderId === fb.folderId, "the two files are in different folders");
      const listed = list((await okCall(person, "list", { folderId: fa.folderId })).files, "files");
      eq(listed.map((f) => f.id).sort(), [a.id, b.id].sort(), "the folder's files");
      assert(
        listed.every((f) => f.folderPath === `${top}/Q3`),
        "folderPath",
      );
      expectPublicError(
        await person.call("create", {
          manifest: { filename: "c.txt", mimeType: "text/plain", folder: `${top}//x` },
          body: "c",
          encoding: "text",
        }),
        "invalid_input",
        "empty segment",
      );
    },
  );
  await h.run(
    "a folder path with a leading or trailing '/' or an empty segment is invalid_input",
    async () => {
      const top = unique("Paths");
      const before = Number((await okCall(person, "list", {})).total);
      for (const folder of [`/${top}`, `${top}/`, `${top}//x`, `${top}/ /x`, "/"]) {
        expectPublicError(
          await person.call("create", {
            manifest: { filename: "p.txt", mimeType: "text/plain", folder },
            body: "p",
            encoding: "text",
          }),
          "invalid_input",
          `create ${folder}`,
        );
        expectCode(
          await c.host.call("begin_upload", {
            version: VERSION,
            filename: "p.txt",
            mimeType: "text/plain",
            size: 1,
            source: "app",
            folder,
          }),
          "invalid_input",
          `begin_upload ${folder}`,
        );
      }
      eq(Number((await okCall(person, "list", {})).total), before, "total");
      const folders = list((await okCall(person, "list", { query: top })).folders, "folders");
      eq(folders.length, 0, "a refused path made a folder");
    },
  );
  await h.run("create is not idempotent: each call makes a new file", async () => {
    const m = { filename: "same.txt", mimeType: "text/plain" };
    const a = await createFile(person, m, "same");
    const b = await createFile(person, m, "same");
    assert(a.id !== b.id, "one id for two creates");
    for (const id of [a.id, b.id]) assert(/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id), `id ${id}`);
  });
}

async function wallCases(c: FullCtx): Promise<void> {
  const { h, person, host } = c;
  const walls: Array<[string, Over]> = [
    ["another owner", { owner: c.owner2 }],
    ["another workspace", { workspace: c.ws2 }],
  ];
  for (const [who, over] of walls) {
    await h.run(`${who}'s file is absent: not found, unlisted, unresolved`, async () => {
      const tag = unique("walltag");
      const made = await createFile(
        person,
        { filename: `${tag}.txt`, mimeType: "text/plain", tags: [tag] },
        "secret",
      );
      const other = person.as(over);
      for (const [tool, args] of [
        ["info", { id: made.id }],
        ["read", { id: made.id }],
        ["tag", { id: made.id, add: ["x"] }],
        ["delete", { id: made.id }],
      ] as const) {
        expectPublicError(await other.call(tool, args), "file_not_found", `${tool}`);
      }
      expectPublicError(
        await other.call("move", { ids: [made.id], folderId: "root" }),
        "file_not_found",
        "move",
      );
      eq(list((await okCall(other, "list", { tags: [tag] })).files, "files").length, 0, "list");
      eq(Number((await okCall(other, "search", { query: tag })).total), 0, "search");
      const entry = await resolveOne(host, made.id, over);
      eq(entry, { uri: `files://${made.id}`, found: false }, "resolve");
      const mine = await okCall(person, "info", { id: made.id });
      eq(mine.tags, [tag], "the owner's file is unchanged");
    });
  }
  await h.run("another owner's folder is folder_not_found", async () => {
    const folder = await okCall(person, "create_folder", { manifest: { name: unique("Mine") } });
    const other = person.as({ owner: c.owner2 });
    const id = str(folder.id, "id");
    expectPublicError(await other.call("list", { folderId: id }), "folder_not_found", "list");
    expectPublicError(
      await other.call("update_folder", { id, manifest: { name: "x" } }),
      "folder_not_found",
      "update_folder",
    );
    expectPublicError(await other.call("delete_folder", { id }), "folder_not_found", "delete");
    expectPublicError(
      await other.call("create_folder", { manifest: { name: "child", parentId: id } }),
      "folder_not_found",
      "create_folder",
    );
  });
}

async function listCases(c: FullCtx): Promise<void> {
  const { h, person } = c;
  const tag = unique("pagetag");
  const made: Made[] = [];
  for (let i = 0; i < 7; i++) {
    made.push(
      await createFile(
        person,
        {
          filename: `page-${i}.${i % 2 ? "csv" : "txt"}`,
          mimeType: i % 2 ? "text/csv" : "text/plain",
          tags: [tag],
        },
        "x".repeat(i + 1),
      ),
    );
  }
  await h.run(
    "list's cursor reaches every file once, and nextCursor is null on the last page",
    async () => {
      for (const sort of ["createdAt", "filename", "size"] as const) {
        const seen: string[] = [];
        let cursor: string | null = null;
        let pages = 0;
        do {
          const page = await okCall(person, "list", {
            tags: [tag],
            sort,
            limit: 2,
            ...(cursor ? { cursor } : {}),
          });
          eq(page.total, made.length, "total");
          seen.push(...list(page.files, "files").map((f) => str(f.id, "id")));
          cursor = page.nextCursor as string | null;
          pages++;
          assert(pages < 10, "the cursor never ends");
        } while (cursor);
        eq([...seen].sort(), made.map((m) => m.id).sort(), `${sort}: files across pages`);
        eq(new Set(seen).size, seen.length, `${sort}: a file repeated`);
      }
    },
  );
  await h.run("list's order follows sort and order, the id breaking a tie", async () => {
    const names = list(
      (await okCall(person, "list", { tags: [tag], sort: "filename" })).files,
      "f",
    ).map((f) => f.filename);
    eq(
      names,
      [...names].sort((a, b) => String(a).localeCompare(String(b))),
      "filename asc",
    );
    const sizes = list(
      (await okCall(person, "list", { tags: [tag], sort: "size" })).files,
      "f",
    ).map((f) => Number(f.size));
    eq(
      sizes,
      [...sizes].sort((a, b) => b - a),
      "size desc by default",
    );
    const asc = list(
      (await okCall(person, "list", { tags: [tag], sort: "size", order: "asc" })).files,
      "f",
    ).map((f) => Number(f.size));
    eq(
      asc,
      [...asc].sort((a, b) => a - b),
      "size asc",
    );
  });
  await h.run(
    "a cursor passed with other filters, or one never issued, is invalid_input",
    async () => {
      const first = await okCall(person, "list", { tags: [tag], limit: 2 });
      const cursor = str(first.nextCursor, "nextCursor");
      expectPublicError(
        await person.call("list", { tags: [tag], kinds: ["data"], limit: 2, cursor }),
        "invalid_input",
        "other filters",
        '"list"',
      );
      expectPublicError(
        await person.call("list", { tags: [tag], sort: "size", limit: 2, cursor }),
        "invalid_input",
        "other sort",
      );
      expectPublicError(
        await person.call("list", { cursor: "not-a-cursor" }),
        "invalid_input",
        "garbled",
      );
    },
  );
  await h.run("total, facets, folders and breadcrumb are the same on every page", async () => {
    const a = await okCall(person, "list", { tags: [tag], limit: 3 });
    const b = await okCall(person, "list", {
      tags: [tag],
      limit: 3,
      cursor: str(a.nextCursor, "next"),
    });
    for (const k of ["total", "facets", "folders", "breadcrumb"]) eq(b[k], a[k], k);
  });
  await h.run("each facet counts with every filter but its own", async () => {
    const all = await okCall(person, "list", { tags: [tag], kinds: ["data"] });
    eq(all.total, 3, "data files");
    const facets = obj(all.facets, "facets");
    eq(obj(facets.kinds, "kinds").data, 3, "kinds.data");
    eq(obj(facets.kinds, "kinds").document, 4, "kinds.document, counted without the kind filter");
    eq(obj(facets.sources, "sources").agent, 3, "sources.agent, with the kind filter");
  });
  await h.run(
    "a folder lists its files and folders; recursive its subtree; a file filter hides folders",
    async () => {
      const top = await okCall(person, "create_folder", { manifest: { name: unique("Top") } });
      const topId = str(top.id, "id");
      const sub = await okCall(person, "create_folder", {
        manifest: { name: "Sub", parentId: topId },
      });
      const subPath = `${top.name}/Sub`;
      eq(sub.path, subPath, "path");
      const inTop = await createFile(
        person,
        { filename: "t.txt", mimeType: "text/plain", folder: String(top.name) },
        "t",
      );
      const inSub = await createFile(
        person,
        { filename: "s.txt", mimeType: "text/plain", folder: subPath },
        "s",
      );
      const flat = await okCall(person, "list", { folderId: topId });
      eq(
        list(flat.files, "files").map((f) => f.id),
        [inTop.id],
        "files",
      );
      eq(
        list(flat.folders, "folders").map((f) => f.id),
        [sub.id],
        "folders",
      );
      eq(
        list(flat.breadcrumb, "breadcrumb").map((f) => f.id),
        [topId],
        "breadcrumb",
      );
      const deep = await okCall(person, "list", { folderId: topId, recursive: true });
      eq(
        list(deep.files, "files")
          .map((f) => f.id)
          .sort(),
        [inTop.id, inSub.id].sort(),
        "recursive",
      );
      eq(
        list((await okCall(person, "list", { folderId: topId, kinds: ["document"] })).folders, "f")
          .length,
        0,
        "folders with a filter",
      );
      const sub2 = await okCall(person, "list", { folderId: str(sub.id, "id") });
      eq(
        list(sub2.breadcrumb, "b").map((f) => f.name),
        [top.name, "Sub"],
        "breadcrumb names",
      );
      expectPublicError(
        await person.call("list", { folderId: "fd-missing" }),
        "folder_not_found",
        "absent",
      );
    },
  );
  await h.run(
    "search matches name, description and tags, newest first, counting every match",
    async () => {
      const word = unique("needle");
      await createFile(person, { filename: `${word}.txt`, mimeType: "text/plain" }, "a");
      await createFile(
        person,
        { filename: "d.txt", mimeType: "text/plain", description: `about ${word.toUpperCase()}` },
        "b",
      );
      await createFile(person, { filename: "t.txt", mimeType: "text/plain", tags: [word] }, "c");
      const out = await okCall(person, "search", { query: word, limit: 2 });
      eq(out.total, 3, "total");
      const files = list(out.files, "files");
      eq(files.length, 2, "limit");
      assert(String(files[0]?.createdAt) >= String(files[1]?.createdAt), "newest first");
    },
  );
}

async function readCases(c: FullCtx): Promise<void> {
  const { h, person } = c;
  await h.run("read answers a text file's text, a resource_link, and no body block", async () => {
    const made = await createFile(
      person,
      { filename: "r.txt", mimeType: "text/plain" },
      "hello read",
    );
    const r = await person.call("read", { id: made.id });
    assert(!r.isError, firstText(r));
    validateOutput("read", r.structuredContent);
    const out = obj(r.structuredContent, "read");
    eq([out.extractedText, out.truncated], ["hello read", false], "text");
    const link = r.content?.find((b) => b.type === "resource_link");
    eq(link?.uri, `files://${made.id}`, "resource_link uri");
    eq([link?.name, link?.mimeType, link?.size], ["r.txt", "text/plain", made.size], "link fields");
    assert(!r.content?.some((b) => b.type === "resource" || b.type === "image"), "a body block");
  });
  await h.run("create and info answer a resource_link to the file, and no body block", async () => {
    // A generic type with a known extension: the link carries the recorded type (§5 Types).
    const r = await person.call("create", {
      manifest: { filename: "linked.md", mimeType: "application/octet-stream" },
      body: "# linked",
      encoding: "text",
    });
    assert(!r.isError, firstText(r));
    validateOutput("create", r.structuredContent);
    const made = obj(r.structuredContent, "create");
    const id = str(made.id, "id");
    for (const [tool, got] of [
      ["create", r],
      ["info", await person.call("info", { id })],
    ] as const) {
      assert(!got.isError, firstText(got));
      const links = got.content?.filter((b) => b.type === "resource_link") ?? [];
      eq(links.length, 1, `${tool}: one resource_link`);
      const link = links[0];
      eq(link?.uri, `files://${id}`, `${tool}: resource_link uri`);
      eq(
        [link?.name, link?.mimeType, link?.size],
        ["linked.md", "text/markdown", Buffer.byteLength("# linked")],
        `${tool}: link fields`,
      );
      assert(
        !got.content?.some((b) => b.type === "resource" || b.type === "image"),
        `${tool}: a body block`,
      );
    }
  });
  await h.run("read's maxBytes cuts at a character boundary and says truncated", async () => {
    const made = await createFile(person, { filename: "u.txt", mimeType: "text/plain" }, "aé✓b");
    for (const [maxBytes, want] of [
      [1, "a"],
      [2, "a"],
      [3, "aé"],
      [5, "aé"],
      [6, "aé✓"],
    ] as const) {
      const out = await okCall(person, "read", { id: made.id, maxBytes });
      eq([out.extractedText, out.truncated], [want, true], `maxBytes ${maxBytes}`);
    }
    eq((await okCall(person, "read", { id: made.id, maxBytes: 7 })).truncated, false, "whole");
  });
  await h.run("read never answers more than 1 MiB of text", async () => {
    const big = `${"é".repeat(MIB / 2)}${"z".repeat(MIB)}`;
    const made = await createFile(person, { filename: "big.txt", mimeType: "text/plain" }, big);
    const out = await okCall(person, "read", { id: made.id });
    assert(Buffer.byteLength(str(out.extractedText, "text")) <= MAX_READ_TEXT_BYTES, "over 1 MiB");
    eq(out.truncated, true, "truncated");
  });
  await h.run("read of a type with no text answers extractedText null", async () => {
    const made = await createFile(
      person,
      { filename: "i.png", mimeType: "image/png" },
      binaryBody(c.audit),
    );
    const out = await okCall(person, "read", { id: made.id });
    eq([out.extractedText, out.truncated], [null, false], "no text");
  });
  await h.run(
    "read with pages of a PDF answers its pages, sorted and once, and the missing ones",
    async () => {
      const pdf = pdfOf(["Alpha page", "", "Gamma page"]);
      const made = await createFile(
        person,
        { filename: "doc.pdf", mimeType: "application/pdf" },
        pdf,
      );
      const out = await okCall(person, "read", { id: made.id, pages: [3, 1, 3, 9, 2] });
      eq([out.totalPages, out.requestedPages, out.missingPages], [3, [1, 2, 3, 9], [9]], "pages");
      eq([out.extractedText, out.truncated], [null, false], "extractedText and truncated");
      const pages = list(out.pages, "pages");
      eq(
        pages.map((p) => p.page),
        [1, 2, 3],
        "page numbers",
      );
      assert(String(pages[0]?.text).includes("Alpha"), "page 1 text");
      eq(pages[1]?.empty, true, "page 2 empty");
      const whole = await okCall(person, "read", { id: made.id });
      assert(String(whole.extractedText).includes("Gamma"), "whole text");
      const bounded = await okCall(person, "read", { id: made.id, pages: [1, 3], maxBytes: 6 });
      eq(bounded.truncated, false, "the top-level truncated with pages");
      eq(list(bounded.pages, "pages")[0]?.truncated, true, "page 1 truncated");
      const total = list(bounded.pages, "pages").reduce(
        (n, p) => n + Buffer.byteLength(String(p.text)),
        0,
      );
      assert(total <= 6, `pages hold ${total} bytes past maxBytes 6`);
    },
  );
  await h.run("read with pages of a file with no pages is not_paged", async () => {
    const made = await createFile(
      person,
      { filename: "n.txt", mimeType: "text/plain" },
      "no pages",
    );
    expectPublicError(await person.call("read", { id: made.id, pages: [1] }), "not_paged", "text");
  });
  await h.run(
    "a PDF that cannot be read: extraction_failed by page, extractedText null whole",
    async () => {
      const made = await createFile(
        person,
        { filename: "bad.pdf", mimeType: "application/pdf" },
        Buffer.from("%PDF-1.4 broken"),
      );
      expectPublicError(
        await person.call("read", { id: made.id, pages: [1] }),
        "extraction_failed",
        "pages",
      );
      const out = await okCall(person, "read", { id: made.id });
      eq(out.extractedText, null, "whole");
    },
  );
  await h.run("read of an absent file is file_not_found naming it", async () => {
    expectPublicError(
      await person.call("read", { id: "fl-absent" }),
      "file_not_found",
      "read",
      "fl-absent",
    );
  });
}

async function folderCases(c: FullCtx): Promise<void> {
  const { h, person } = c;
  await h.run(
    "folders: create, rename, move; sibling names unique case-insensitively",
    async () => {
      const a = await okCall(person, "create_folder", { manifest: { name: unique("Alpha") } });
      const aId = str(a.id, "id");
      const name = str(a.name, "name");
      expectPublicError(
        await person.call("create_folder", { manifest: { name: name.toUpperCase() } }),
        "conflict",
        "duplicate",
      );
      const b = await okCall(person, "create_folder", {
        manifest: { name: "Beta", parentId: aId },
      });
      eq(b.parentId, aId, "parentId");
      const renamed = await okCall(person, "update_folder", {
        id: str(b.id, "id"),
        manifest: { name: "Gamma" },
      });
      eq([renamed.name, renamed.path], ["Gamma", `${name}/Gamma`], "renamed");
      const moved = await okCall(person, "update_folder", {
        id: str(b.id, "id"),
        manifest: { parentId: "root" },
      });
      eq([moved.parentId, moved.path], [null, "Gamma"], "moved to the top");
    },
  );
  await h.run("a folder moved into itself or below it is a conflict", async () => {
    const a = await okCall(person, "create_folder", { manifest: { name: unique("Outer") } });
    const b = await okCall(person, "create_folder", {
      manifest: { name: "Inner", parentId: str(a.id, "a") },
    });
    expectPublicError(
      await person.call("update_folder", {
        id: str(a.id, "a"),
        manifest: { parentId: str(a.id, "a") },
      }),
      "conflict",
      "self",
    );
    expectPublicError(
      await person.call("update_folder", {
        id: str(a.id, "a"),
        manifest: { parentId: str(b.id, "b") },
      }),
      "conflict",
      "descendant",
    );
  });
  await h.run(
    "delete_folder refuses a folder that holds anything, deletes an empty one",
    async () => {
      const top = await okCall(person, "create_folder", { manifest: { name: unique("Full") } });
      const id = str(top.id, "id");
      const file = await createFile(
        person,
        { filename: "f.txt", mimeType: "text/plain", folder: String(top.name) },
        "f",
      );
      expectPublicError(await person.call("delete_folder", { id }), "conflict", "holds a file");
      await okCall(person, "move", { ids: [file.id], folderId: "root" });
      const child = await okCall(person, "create_folder", {
        manifest: { name: "Child", parentId: id },
      });
      expectPublicError(await person.call("delete_folder", { id }), "conflict", "holds a folder");
      eq(
        (await okCall(person, "delete_folder", { id: str(child.id, "c") })).deleted,
        true,
        "child",
      );
      eq((await okCall(person, "delete_folder", { id })).deleted, true, "top");
      expectPublicError(
        await person.call("delete_folder", { id }),
        "folder_not_found",
        "again",
        id,
      );
    },
  );
  await h.run("move moves every id or none", async () => {
    const dest = await okCall(person, "create_folder", { manifest: { name: unique("Dest") } });
    const destId = str(dest.id, "id");
    const a = await createFile(person, { filename: "m1.txt", mimeType: "text/plain" }, "1");
    const b = await createFile(person, { filename: "m2.txt", mimeType: "text/plain" }, "2");
    expectPublicError(
      await person.call("move", { ids: [a.id, "fl-absent", b.id], folderId: destId }),
      "file_not_found",
      "one absent",
    );
    eq((await okCall(person, "info", { id: a.id })).folderId ?? null, null, "a did not move");
    expectPublicError(
      await person.call("move", { ids: [a.id], folderId: "fd-absent" }),
      "folder_not_found",
      "absent folder",
    );
    const out = await okCall(person, "move", { ids: [a.id, b.id], folderId: destId });
    eq(out.folderId, destId, "folderId");
    eq(list((await okCall(person, "list", { folderId: destId })).files, "f").length, 2, "moved");
  });
  await h.run("tag adds and removes, answering the tags after", async () => {
    const made = await createFile(
      person,
      { filename: "tag.txt", mimeType: "text/plain", tags: ["a", "b"] },
      "t",
    );
    const out = await okCall(person, "tag", { id: made.id, add: ["c"], remove: ["a"] });
    eq([...(out.tags as string[])].sort(), ["b", "c"], "tags");
    eq(
      [...((await okCall(person, "info", { id: made.id })).tags as string[])].sort(),
      ["b", "c"],
      "info",
    );
  });
  await h.run("delete removes the file everywhere; a second delete is file_not_found", async () => {
    const made = await createFile(person, { filename: "gone.txt", mimeType: "text/plain" }, "gone");
    eq((await okCall(person, "delete", { id: made.id })).deleted, true, "deleted");
    expectPublicError(await person.call("info", { id: made.id }), "file_not_found", "info");
    expectPublicError(await person.call("delete", { id: made.id }), "file_not_found", "again");
    eq(await resolveOne(c.host, made.id), { uri: `files://${made.id}`, found: false }, "resolve");
  });
}

async function uploadCases(c: FullCtx): Promise<void> {
  const { h, host, person, audit } = c;
  await h.run(
    "an upload end to end: begin_upload, PUT, complete_upload, resolve, GET",
    async () => {
      const body = binaryBody(audit);
      const conversation = unique("conv");
      const run = unique("run");
      const before = Number((await okCall(person, "list", {})).total);
      const up = await upload(
        c,
        body,
        {
          filename: "photo.png",
          mimeType: "image/png",
          source: "chat",
          folder: unique("Up"),
          tags: ["u"],
          description: "d",
        },
        { conversation, run },
      );
      eq(Number((await okCall(person, "list", {})).total), before, "begin_upload made a file");
      await putOk(up, body);
      const done = await okCall(host, "complete_upload", {
        version: VERSION,
        uploadId: up.uploadId,
      });
      const file = obj(done.file, "file");
      eq(done.uri, `files://${file.id}`, "uri");
      eq(
        [
          file.size,
          file.source,
          file.conversationId,
          file.runId,
          file.tags,
          file.description,
          file.mimeType,
        ],
        [body.length, "chat", conversation, run, ["u"], "d", "image/png"],
        "record",
      );
      assert(file.folderId, "the folder was not made");
      const got = await download(await downloadUrl(c, String(file.id)));
      assert(got.equals(body), "the downloaded body differs");
      await okCall(person, "info", { id: String(file.id) });
    },
  );
  await h.run(
    "complete_upload is upload_incomplete for no body or a short one, and the upload stays open",
    async () => {
      const body = Buffer.from("twelve bytes");
      const up = await upload(c, body);
      expectCode(
        await host.call("complete_upload", { version: VERSION, uploadId: up.uploadId }),
        "upload_incomplete",
        "no body",
      );
      await putOk(up, body.subarray(0, 5));
      expectCode(
        await host.call("complete_upload", { version: VERSION, uploadId: up.uploadId }),
        "upload_incomplete",
        "short",
      );
      await putOk(up, body);
      await okCall(host, "complete_upload", { version: VERSION, uploadId: up.uploadId });
    },
  );
  await h.run("a repeated PUT replaces the earlier body", async () => {
    const first = Buffer.from("first-body");
    const second = Buffer.from("other-body");
    const up = await upload(c, first);
    await putOk(up, first);
    await putOk(up, second);
    const done = await okCall(host, "complete_upload", { version: VERSION, uploadId: up.uploadId });
    const got = await download(await downloadUrl(c, String(obj(done.file, "file").id)));
    eq(got.toString(), "other-body", "body");
  });
  await h.run(
    "complete_upload is idempotent: a repeat answers the first and makes nothing",
    async () => {
      const body = Buffer.from("idempotent");
      const up = await upload(c, body);
      await putOk(up, body);
      const first = await okCall(host, "complete_upload", {
        version: VERSION,
        uploadId: up.uploadId,
      });
      const total = Number((await okCall(person, "list", {})).total);
      const again = await okCall(host, "complete_upload", {
        version: VERSION,
        uploadId: up.uploadId,
      });
      eq(again, first, "the repeat");
      eq(Number((await okCall(person, "list", {})).total), total, "total");
    },
  );
  await h.run(
    "a complete_upload repeat answers the first even after its file is tagged and moved",
    async () => {
      const body = Buffer.from("replayed");
      const up = await upload(c, body);
      await putOk(up, body);
      const first = await okCall(host, "complete_upload", {
        version: VERSION,
        uploadId: up.uploadId,
      });
      const id = str(obj(first.file, "file").id, "id");
      const folder = await okCall(person, "create_folder", { manifest: { name: unique("Moved") } });
      await okCall(person, "tag", { id, add: ["later"] });
      await okCall(person, "move", { ids: [id], folderId: str(folder.id, "id") });
      const again = await okCall(host, "complete_upload", {
        version: VERSION,
        uploadId: up.uploadId,
      });
      eq(again, first, "the repeat");
    },
  );
  await h.run(
    "a complete_upload repeat after its file is deleted is upload_not_found",
    async () => {
      const body = Buffer.from("deleted since");
      const up = await upload(c, body);
      await putOk(up, body);
      const first = await okCall(host, "complete_upload", {
        version: VERSION,
        uploadId: up.uploadId,
      });
      await okCall(person, "delete", { id: str(obj(first.file, "file").id, "id") });
      expectCode(
        await host.call("complete_upload", { version: VERSION, uploadId: up.uploadId }),
        "upload_not_found",
        "after delete",
      );
    },
  );
  await h.run(
    "begin_upload records a known extension's type for a generic one, a specific one as given",
    async () => {
      const cases: Array<[string, string, string]> = [
        ["notes.md", "application/octet-stream", "text/markdown"],
        ["main.PY", "application/octet-stream; charset=x", "text/plain"],
        ["blob", "application/octet-stream", "application/octet-stream"],
        ["a.md", "text/csv", "text/csv"],
      ];
      for (const [filename, mimeType, want] of cases) {
        const body = Buffer.from("x");
        const up = await upload(c, body, { filename, mimeType });
        await putOk(up, body);
        const done = await okCall(host, "complete_upload", {
          version: VERSION,
          uploadId: up.uploadId,
        });
        eq(obj(done.file, "file").mimeType, want, filename);
      }
    },
  );
  await h.run("a PUT past the declared size is refused and stores nothing", async () => {
    const body = Buffer.from("declared");
    const up = await upload(c, body);
    await putOk(up, body);
    const res = await put(up, Buffer.concat([body, Buffer.from("-and-more")]));
    const own =
      isLoopbackUrl(up.url) ||
      (c.opts.server !== undefined && new URL(up.url).origin === new URL(c.opts.server).origin);
    if (own) eq(res.status, 413, "status");
    else assert(res.status >= 400 && res.status < 500, `an overlong PUT answered ${res.status}`);
    const done = await okCall(host, "complete_upload", { version: VERSION, uploadId: up.uploadId });
    const got = await download(await downloadUrl(c, String(obj(done.file, "file").id)));
    eq(got.toString(), "declared", "the earlier body");
  });
  await h.run("an upload URL stops accepting once its upload is completed", async () => {
    const body = Buffer.from("closed");
    const up = await upload(c, body);
    await putOk(up, body);
    await okCall(host, "complete_upload", { version: VERSION, uploadId: up.uploadId });
    const res = await put(up, body);
    assert(res.status < 200 || res.status >= 300, `a PUT after completion answered ${res.status}`);
  });
  await h.run(
    "another owner's, another workspace's and an unknown upload are upload_not_found",
    async () => {
      const body = Buffer.from("walled");
      const up = await upload(c, body);
      await putOk(up, body);
      const args = { version: VERSION, uploadId: up.uploadId };
      expectCode(
        await host.call("complete_upload", args, { owner: c.owner2 }),
        "upload_not_found",
        "owner",
      );
      expectCode(
        await host.call("complete_upload", args, { workspace: c.ws2 }),
        "upload_not_found",
        "ws",
      );
      expectCode(
        await host.call("complete_upload", { version: VERSION, uploadId: "up_never_issued" }),
        "upload_not_found",
        "unknown",
      );
      await okCall(host, "complete_upload", args);
    },
  );
  await h.run(
    "begin_upload is type_not_allowed off the allowlist and too_large past its limit",
    async () => {
      const base = { version: VERSION, filename: "x", size: 1, source: "app" };
      expectCode(
        await host.call("begin_upload", { ...base, mimeType: "video/mp4" }),
        "type_not_allowed",
        "type",
      );
      expectCode(
        await host.call("begin_upload", {
          ...base,
          mimeType: "text/plain",
          size: Number.MAX_SAFE_INTEGER,
        }),
        "too_large",
        "size",
      );
    },
  );
  await h.run("begin_upload is not idempotent: each call opens a new upload", async () => {
    const a = await upload(c, Buffer.from("a"));
    const b = await upload(c, Buffer.from("a"));
    assert(a.uploadId !== b.uploadId && a.url !== b.url, "one upload for two calls");
  });
}

async function transferCases(c: FullCtx): Promise<void> {
  const { h, person, audit } = c;
  await h.run(
    "every transfer URL is absolute http(s), bounded, without userinfo, expiring in bound",
    async () => {
      const body = Buffer.from("shape");
      const up = await upload(c, body);
      checkTransferUrl(up.url, up.expiresAt, UPLOAD_TTL_S, up.issuedAt);
      await putOk(up, body);
      const done = await okCall(c.host, "complete_upload", {
        version: VERSION,
        uploadId: up.uploadId,
      });
      const issuedAt = Date.now();
      const entry = await resolveOne(c.host, String(obj(done.file, "file").id));
      const dl = obj(entry.download, "download");
      checkTransferUrl(transferUrl(audit, dl.url, "url"), dl.expiresAt, DOWNLOAD_TTL_S, issuedAt);
    },
  );
  await h.run("an upload's headers name no field the host owns", async () => {
    const up = await upload(c, Buffer.from("h"));
    for (const name of Object.keys(up.headers)) {
      const lower = name.toLowerCase();
      assert(!HOST_OWNED_HEADERS.includes(lower) && !lower.startsWith("proxy-"), `header ${name}`);
    }
  });
  await h.run(
    "a download URL refuses PUT and an upload URL refuses GET; neither redirects",
    async () => {
      const body = Buffer.from("one operation");
      const made = await createFile(
        person,
        { filename: "op.bin", mimeType: "application/octet-stream" },
        body,
      );
      const dl = await downloadUrl(c, made.id);
      for (const res of [
        await fetch(dl, { method: "PUT", body, redirect: "manual" }),
        await fetch(dl, { method: "POST", redirect: "manual" }),
      ]) {
        assert(res.status < 200 || res.status >= 300, `download URL answered ${res.status}`);
        assert(res.status < 300 || res.status >= 400, `download URL redirected (${res.status})`);
      }
      const up = await upload(c, body);
      const g = await get(up.url);
      assert(g.status < 200 || g.status >= 300, `upload URL answered GET ${g.status}`);
      assert(g.status < 300 || g.status >= 400, `upload URL redirected (${g.status})`);
      const ok = await get(dl);
      assert(ok.status === 200, `GET ${ok.status}`);
    },
  );
  await h.run(
    "a single Range is answered 206 with Content-Range and that range's length",
    async () => {
      const body = Buffer.from("0123456789abcdef");
      const made = await createFile(
        person,
        { filename: "r.bin", mimeType: "application/octet-stream" },
        body,
      );
      const dl = await downloadUrl(c, made.id);
      for (const [range, want, cr] of [
        ["bytes=2-5", "2345", "bytes 2-5/16"],
        ["bytes=10-", "abcdef", "bytes 10-15/16"],
        ["bytes=-3", "def", "bytes 13-15/16"],
      ] as const) {
        const res = await get(dl, { range });
        eq(res.status, 206, `${range} status`);
        eq(res.headers.get("content-range"), cr, `${range} Content-Range`);
        const got = Buffer.from(await res.arrayBuffer());
        eq([got.toString(), res.headers.get("content-length")], [want, String(want.length)], range);
      }
    },
  );
  await h.run("several ranges are answered 200 whole, an unsatisfiable range 416", async () => {
    const body = Buffer.from("0123456789abcdef");
    const made = await createFile(
      person,
      { filename: "rr.bin", mimeType: "application/octet-stream" },
      body,
    );
    const dl = await downloadUrl(c, made.id);
    const multi = await get(dl, { range: "bytes=0-1,4-5" });
    eq(multi.status, 200, "several ranges");
    assert(Buffer.from(await multi.arrayBuffer()).equals(body), "several ranges: the whole body");
    for (const range of ["bytes=16-", "bytes=99-100", "bytes=-0"]) {
      const res = await get(dl, { range });
      eq(res.status, 416, range);
      await res.arrayBuffer();
    }
  });
  await h.run(
    "a loopback listener answers an unknown token 404 and sends no CORS headers",
    async () => {
      const made = await createFile(
        person,
        { filename: "c.bin", mimeType: "application/octet-stream" },
        Buffer.from("cors"),
      );
      const dl = await downloadUrl(c, made.id);
      if (!isLoopbackUrl(dl)) return;
      const ok = await get(dl, { origin: "https://evil.example" });
      assert(!ok.headers.has("access-control-allow-origin"), "CORS on a GET");
      const u = new URL(dl);
      // Every other last character, so a token that differs only in bits a decoder
      // ignores (base64's unused low bits) is held to 404 like any other change.
      const stem = u.pathname.slice(0, -1);
      for (const ch of URL_SAFE) {
        if (stem + ch === u.pathname) continue;
        const forged = await get(`${u.origin}${stem}${ch}`);
        eq(forged.status, 404, `a token with its last character changed to ${ch}`);
        await forged.arrayBuffer();
      }
      eq((await get(`${u.origin}/`)).status, 404, "the root");
      const pre = await fetch(dl, {
        method: "OPTIONS",
        headers: { origin: "https://evil.example" },
      });
      assert(!pre.headers.has("access-control-allow-origin"), "CORS on a preflight");
    },
  );
  await expiryCases(c);
}

async function expiryCases(c: FullCtx): Promise<void> {
  const { h, host, person } = c;
  const probe = await upload(c, Buffer.from("probe")).catch(() => null);
  const uploadShort = probe ? Date.parse(probe.expiresAt) - Date.now() <= SHORT_TTL_MS : false;
  const graceCase = "complete_upload succeeds within 300 s past expiresAt for a PUT begun in time";
  const expiredPut = "an upload URL refuses a PUT begun after expiresAt";
  if (!uploadShort || !probe) {
    const why =
      "upload URLs expire later than 15 s after issue: give the implementation a short upload TTL";
    h.skip(graceCase, why);
    h.skip(expiredPut, why);
  } else {
    await h.run(graceCase, async () => {
      const body = Buffer.from("in time");
      const up = await upload(c, body);
      await putOk(up, body);
      await sleep(Math.max(0, Date.parse(up.expiresAt) - Date.now()) + 1_000);
      await okCall(host, "complete_upload", { version: VERSION, uploadId: up.uploadId });
    });
    await h.run(expiredPut, async () => {
      const body = Buffer.from("too late");
      const up = await upload(c, body);
      await sleep(Math.max(0, Date.parse(up.expiresAt) - Date.now()) + 1_000);
      const res = await put(up, body);
      assert(res.status < 200 || res.status >= 300, `a late PUT answered ${res.status}`);
      expectCode(
        await host.call("complete_upload", { version: VERSION, uploadId: up.uploadId }),
        "upload_incomplete",
        "a late PUT stored nothing",
      );
    });
  }
  const pastGrace = "complete_upload past the 300 s window is upload_not_found";
  if (!c.opts.waitGrace || !uploadShort) {
    h.skip(
      pastGrace,
      "waits 300 s past an upload's expiry: pass --wait-grace with a short upload TTL",
    );
  } else {
    await h.run(pastGrace, async () => {
      const body = Buffer.from("never completed");
      const up = await upload(c, body);
      await putOk(up, body);
      await sleep(Math.max(0, Date.parse(up.expiresAt) - Date.now()) + GRACE_S * 1000 + 2_000);
      expectCode(
        await host.call("complete_upload", { version: VERSION, uploadId: up.uploadId }),
        "upload_not_found",
        "past the window",
      );
    });
  }
  const made = await createFile(
    person,
    { filename: "exp.bin", mimeType: "application/octet-stream" },
    Buffer.from("expiry"),
  );
  const entry = await resolveOne(host, made.id);
  const dl = obj(entry.download, "download");
  const downloadCase = "a download URL refuses a GET begun after expiresAt";
  if (Date.parse(String(dl.expiresAt)) - Date.now() > SHORT_TTL_MS) {
    h.skip(
      downloadCase,
      "download URLs expire later than 15 s after issue: give the implementation a short download TTL",
    );
  } else {
    await h.run(downloadCase, async () => {
      const url = transferUrl(c.audit, dl.url, "url");
      await sleep(Math.max(0, Date.parse(String(dl.expiresAt)) - Date.now()) + 1_000);
      const res = await get(url);
      assert(
        res.status < 200 || res.status >= 300,
        `an expired download URL answered ${res.status}`,
      );
    });
  }
}

async function resolveCases(c: FullCtx): Promise<void> {
  const { h, host, person } = c;
  await h.run(
    "resolve answers each URI in order, a repeat at each place, the absent found: false",
    async () => {
      const a = await createFile(person, { filename: "a.txt", mimeType: "text/plain" }, "a");
      const b = await createFile(person, { filename: "b.txt", mimeType: "text/plain" }, "b");
      const uris = [`files://${b.id}`, "files://fl-absent", `files://${a.id}`, `files://${b.id}`];
      const out = await okCall(host, "resolve", { version: VERSION, uris });
      const files = list(out.files, "files");
      eq(
        files.map((f) => f.uri),
        uris,
        "order",
      );
      eq(
        files.map((f) => f.found),
        [true, false, true, true],
        "found",
      );
      eq(obj(files[0]?.file, "file").id, b.id, "record");
      for (const f of files) if (f.found) transferUrl(c.audit, obj(f.download, "d").url, "url");
    },
  );
  await h.run("resolve called as host with a runId in the context succeeds", async () => {
    const made = await createFile(person, { filename: "run.txt", mimeType: "text/plain" }, "run");
    const entry = await resolveOne(host, made.id, { run: unique("run") });
    eq(entry.found, true, "found");
    transferUrl(c.audit, obj(entry.download, "d").url, "url");
  });
  await h.run("resolve refuses more than 100 URIs and a URI that is not files://<id>", async () => {
    const many = Array.from({ length: 101 }, (_, i) => `files://f${i}`);
    expectCode(
      await host.call("resolve", { version: VERSION, uris: many }),
      "invalid_input",
      "101",
    );
    for (const uri of ["files://ws_1/x", "https://x/y", "files://Upper"]) {
      expectCode(
        await host.call("resolve", { version: VERSION, uris: [uri] }),
        "invalid_input",
        uri,
      );
    }
  });
  await h.run("the server answers no resources/read of a files:// URI", async () => {
    const made = await createFile(
      person,
      { filename: "res.txt", mimeType: "text/plain" },
      "resource",
    );
    let answered = false;
    try {
      const out = await host.client.readResource({ uri: `files://${made.id}` });
      answered = out.contents.length > 0;
    } catch {
      answered = false;
    }
    assert(!answered, "the server served a files:// body over MCP");
  });
}

async function deleteWorkspaceCases(c: FullCtx): Promise<void> {
  const { h, host } = c;
  await h.run(
    "delete_workspace purges every owner's files, folders and uploads, idempotently",
    async () => {
      const ws = `${c.ws}-purge`;
      const a = host.as({ workspace: ws });
      const b = host.as({ workspace: ws, owner: c.owner2 });
      const keep = await createFile(host, { filename: "keep.txt", mimeType: "text/plain" }, "keep");
      const fa = await createFile(
        a,
        { filename: "a.txt", mimeType: "text/plain", folder: "F" },
        "a",
      );
      await createFile(b, { filename: "b.txt", mimeType: "text/plain" }, "b");
      const body = Buffer.from("open upload");
      const up = await upload(c, body, {}, { workspace: ws });
      await putOk(up, body);
      const out = await okCall(
        host,
        "delete_workspace",
        { version: VERSION },
        { workspace: ws, owner: null },
      );
      eq(out.removed, { files: 2, folders: 1 }, "removed");
      eq(Number((await okCall(a, "list", {})).total), 0, "a's files");
      eq(Number((await okCall(b, "list", {})).total), 0, "b's files");
      eq(await resolveOne(a, fa.id), { uri: `files://${fa.id}`, found: false }, "resolve");
      expectCode(
        await a.call("complete_upload", { version: VERSION, uploadId: up.uploadId }),
        "upload_not_found",
        "the open upload",
      );
      const again = await okCall(
        host,
        "delete_workspace",
        { version: VERSION },
        { workspace: ws, owner: null },
      );
      eq(again.removed, { files: 0, folders: 0 }, "the repeat");
      await okCall(host, "info", { id: keep.id });
    },
  );
}

async function closingCases(c: FullCtx): Promise<void> {
  const { h, audit } = c;
  await h.run("no public output or error carries a transfer URL or a body", async () => {
    assert(audit.calls > 0 && audit.urls.size > 0 && audit.bodies.size > 0, "nothing was audited");
    eq([...new Set(audit.leaks)], [], "leaks");
  });
  await h.run("the screen carries no transfer URL", async () => {
    const read = await c.host.client.readResource({ uri: SCREEN_URI });
    const text = JSON.stringify(read.contents);
    for (const url of audit.urls) assert(!text.includes(url), "the screen holds a transfer URL");
  });
  await h.run("every error is from the contract's closed lists, with its prefix", async () => {
    eq(audit.errorViolations, [], "violations");
  });
}

const GROUPS: Array<[string, (c: FullCtx) => Promise<void>]> = [
  ["surface", surfaceCases],
  ["principal", principalCases],
  ["scope", scopeCases],
  ["create", createCases],
  ["walls", wallCases],
  ["list", listCases],
  ["read", readCases],
  ["folders", folderCases],
  ["uploads", uploadCases],
  ["transfers", transferCases],
  ["resolve", resolveCases],
  ["delete_workspace", deleteWorkspaceCases],
];

async function fullSuite(h: Harness, opts: RunnerOptions, audit: Audit): Promise<void> {
  const ws = opts.workspace as string;
  const owner = opts.owner as string;
  const host = await connect(opts, { workspace: ws, owner, principal: "host" }, audit);
  const c: FullCtx = {
    h,
    opts,
    audit,
    host,
    person: host.as({ principal: "person" }),
    ws,
    ws2: `${ws}-other`,
    owner,
    owner2: `${owner}-other`,
  };
  try {
    for (const [group, run] of GROUPS) {
      try {
        await run(c);
      } catch (err) {
        h.results.push({ name: `${group} setup`, status: "fail", detail: String(err) });
      }
    }
    await closingCases(c);
  } finally {
    for (const w of [c.ws, c.ws2]) {
      await host
        .call("delete_workspace", { version: VERSION }, { workspace: w, owner: null })
        .catch(() => {});
    }
    await host.close();
  }
}

// ── Public tools, as a person ────────────────────────────────────────────

async function publicSuite(h: Harness, opts: RunnerOptions, audit: Audit): Promise<void> {
  const conn = await connect(
    opts,
    { workspace: opts.workspace, owner: opts.owner, principal: "person" },
    audit,
  );
  try {
    await h.run("tools/list lists the public tools with the document's schemas", async () => {
      const listed = new Map((await conn.listTools()).map((t) => [t.name, t]));
      for (const name of PUBLIC_TOOLS) {
        const t = listed.get(name);
        assert(t, `${name} is not listed`);
        eq(t.inputSchema, contractSchema(name, "input"), `${name} inputSchema`);
        eq(t.outputSchema, contractSchema(name, "output"), `${name} outputSchema`);
      }
    });
    await h.run("no private tool is listed", async () => {
      const shown = (await conn.listTools()).filter((t) => PRIVATE_TOOLS.includes(t.name));
      assert(shown.length === 0, `private tools listed: ${shown.map((t) => t.name).join(", ")}`);
    });
    await h.run("a private tool called here is refused", async () => {
      let refused = false;
      try {
        refused =
          (await conn.call("resolve", { version: VERSION, uris: ["files://x"] })).isError === true;
      } catch {
        refused = true;
      }
      assert(refused, "resolve answered");
    });
    await h.run("every public tool lists the document's annotations", async () => {
      const tools = new Map((await conn.listTools()).map((t) => [t.name, t]));
      for (const name of PUBLIC_TOOLS) {
        for (const [k, v] of Object.entries(CONTRACT.tools[name]?.annotations ?? {})) {
          assert(tools.get(name)?.annotations?.[k] === v, `${name}.${k}`);
        }
      }
    });
    await h.run("invalid arguments are invalid_input naming the tool", async () => {
      expectPublicError(await conn.call("create", {}), "invalid_input", "create", '"create"');
    });
    await h.run("create, read, list, tag and delete a file", async () => {
      const name = `${unique("public")}.md`;
      const made = await createFile(
        conn,
        { filename: name, mimeType: "text/markdown" },
        "# Public",
      );
      eq((await okCall(conn, "read", { id: made.id })).extractedText, "# Public", "read");
      const files = list((await okCall(conn, "list", { query: name })).files, "files");
      eq(
        files.map((f) => f.id),
        [made.id],
        "list",
      );
      eq((await okCall(conn, "tag", { id: made.id, add: ["p"] })).tags, ["p"], "tag");
      eq((await okCall(conn, "delete", { id: made.id })).deleted, true, "delete");
      expectPublicError(await conn.call("info", { id: made.id }), "file_not_found", "info");
    });
    await h.run("every error is from the contract's closed lists, with its prefix", async () => {
      eq(audit.errorViolations, [], "violations");
    });
  } finally {
    await conn.close();
  }
}

// ── Entry points ─────────────────────────────────────────────────────────

/** Run every case the options allow: the whole contract, or with `publicOnly` the public tools. */
export async function runConformance(opts: RunnerOptions): Promise<CaseResult[]> {
  if (!opts.server && !opts.command) throw new Error("give --server <url> or --command <cmd>");
  const carriage = opts.command ? "meta" : (opts.carriage ?? "none");
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
    argv.flatMap((a, i) =>
      a === `--${name}` && argv[i + 1] !== undefined ? [argv[i + 1] as string] : [],
    );
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
    command: one("command"),
    args: many("arg"),
    publicOnly: argv.includes("--public-only"),
    headers,
    carriage,
    workspace: one("workspace"),
    owner: one("owner"),
    protocolVersion: one("protocol-version"),
    toolPrefix: one("tool-prefix"),
    skip: many("skip"),
    waitGrace: argv.includes("--wait-grace"),
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
