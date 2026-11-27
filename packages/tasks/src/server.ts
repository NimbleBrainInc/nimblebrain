/**
 * The tasks server: one MCP server serving every tool of the tasks contract,
 * its screen and the change hint. Each `tools/call` is decided in one order,
 * under the host context it carries (`params._meta["ai.nimblebrain/context"]`,
 * `contracts/host-context/CONTEXT.md`):
 *
 *   1. a tool the contract does not name is `unknown_tool`;
 *   2. a private tool called by anyone but the host is `forbidden` (before input and scope);
 *   3. a public tool marked `unattended: "refused"` on a call with `unattended: true` is
 *      `unattended_refused`;
 *   4. arguments that fail the tool's input schema are `invalid_input`;
 *   5. a call missing what its tool is walled to is `scope_missing` (public tools and
 *      `offer_event`: a workspace and an owner; the other private tools: a workspace);
 *   6. a tool marked `grant: true` called with no grant is `grant_missing`;
 *   7. the tool runs, walled to that scope, as one store transaction.
 *
 * Every request reaching the server came through an authenticated host transport
 * (`main.ts`), so its host context is the host's word.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ProtocolError, ProtocolErrorCode, Server } from "@modelcontextprotocol/server";
import {
  type CallContext,
  contractSchema,
  declareHostMeta,
  publicErrorPrefix,
  readHostContext,
  refuseUnlessAllowed,
  ToolCallError,
  type ToolErrorResult,
  toolError,
  toolVisibility,
} from "../../server-sdk/src/index.ts";
import { CONTRACT, DESCRIPTIONS, inputError, sharedSchemaError } from "./contract.ts";
import { beginRun, due, endRun, offerEvent, workspaceCounts } from "./flow.ts";
import * as pub from "./public.ts";
import { stats, upcoming } from "./reads.ts";
import { isPathSegment, type Store, type Tx } from "./store.ts";

export const SERVER_NAME = "tasks";
export const PANEL_URI = "ui://tasks/panel";
export const CARD_URI = "ui://tasks/card";
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
/** The change hint's URI for a workspace (CONTRACT.md §5.1). */
export const HINT_PREFIX = "tasks://due/";
export const hintUri = (workspaceId: string) => `${HINT_PREFIX}${workspaceId}`;

/** This server's host metadata: the panel's place in a host's shell, answered on the handshake. */
export const HOST_META = {
  hostVersion: "1.0",
  placements: [
    {
      slot: "sidebar",
      resourceUri: PANEL_URI,
      route: "@nimblebraininc/tasks",
      label: "Scheduled",
      icon: "clock",
      priority: 3,
    },
  ],
} as const;

const SCREEN_PLACEHOLDER =
  '<!doctype html><html><head><meta charset="utf-8"><title>Scheduled</title></head>' +
  "<body><p>The tasks screen is not built. Run: cd packages/tasks/ui &amp;&amp; bun install &amp;&amp; bun run build</p></body></html>";

/** The card is the panel's bundle marked as the card; the app reads the mark to pick its view. */
export function cardHtml(panelHtml: string): string {
  const mark = '<meta name="nb-tasks-view" content="card">';
  return panelHtml.includes("<head>")
    ? panelHtml.replace("<head>", `<head>${mark}`)
    : `${mark}${panelHtml}`;
}

/** The default retention of ended runs' data: 180 days. */
export const DEFAULT_RETENTION_MS = 180 * 86_400_000;

export interface ServerOptions {
  store: Store;
  /** The built screen's HTML file; a placeholder page when absent. */
  screenPath?: string;
  /** How long an ended run's data is kept, judged on `due`'s `now`. */
  retentionMs?: number;
}

type Args = Record<string, unknown>;
// biome-ignore lint/suspicious/noExplicitAny: each input was checked against its contract schema
type Checked = any;
type Handler = (tx: Tx, caller: pub.Caller, args: Checked, retentionMs: number) => unknown;

const PUBLIC: Record<string, Handler> = {
  create: pub.create,
  update: pub.update,
  delete: pub.remove,
  list: pub.list,
  status: pub.status,
  run: pub.run,
  run_result: pub.runResult,
  runs: pub.runs,
  cancel: pub.cancel,
  upcoming,
  stats,
  run_batch: pub.runBatch,
  batch: pub.batch,
  batches: pub.batches,
  batch_control: pub.batchControl,
};

const PRIVATE: Record<string, Handler> = {
  due: (tx, _caller, args, retentionMs) => due(tx, args, retentionMs),
  begin_run: (tx, _caller, args) => beginRun(tx, args),
  end_run: (tx, _caller, args) => endRun(tx, args),
  offer_event: (tx, caller, args) => offerEvent(tx, caller.ownerId, args),
};

/** What a caller is told about a failure the contract has no code for; the detail goes to stderr. */
const INTERNAL_ERROR = "the tasks server failed; its log has the detail";

function logInternal(what: string, err: unknown): void {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`nb-tasks: ${what} failed: ${detail}\n`);
}

function success(result: Record<string, unknown>, readable: boolean) {
  return {
    content: [
      {
        type: "text" as const,
        text: readable ? JSON.stringify(result, null, 2) : JSON.stringify(result),
      },
    ],
    structuredContent: result,
  };
}

function isReadOnly(tool: string): boolean {
  return CONTRACT.tools[tool]?.unattended === "allowed";
}

/** The scope a tool is walled to, or what is missing. */
function scopeOf(tool: string, ctx: CallContext): pub.Caller | { missing: "workspace" | "owner" } {
  if (!ctx.workspaceId || !isPathSegment(ctx.workspaceId)) return { missing: "workspace" };
  const needsOwner = toolVisibility(CONTRACT, tool) === "public" || tool === "offer_event";
  if (needsOwner && !ctx.ownerId) return { missing: "owner" };
  return {
    workspaceId: ctx.workspaceId,
    ownerId: ctx.ownerId ?? "",
    ...(ctx.grant ? { grant: ctx.grant } : {}),
  };
}

function refusalBefore(tool: string, args: Args, ctx: CallContext): ToolErrorResult | null {
  const visibility = toolVisibility(CONTRACT, tool);
  if (!visibility)
    return toolError("unknown_tool", `${publicErrorPrefix(CONTRACT, "unknown_tool")}"${tool}"`);
  const forbidden = refuseUnlessAllowed(CONTRACT, tool, ctx);
  if (forbidden) return forbidden;
  if (
    visibility === "public" &&
    ctx.unattended === true &&
    CONTRACT.tools[tool]?.unattended === "refused"
  ) {
    return toolError(
      "unattended_refused",
      `${publicErrorPrefix(CONTRACT, "unattended_refused")}"${tool}" authors, starts or stops work.`,
    );
  }
  const invalid = inputError(tool, args);
  if (invalid !== null) {
    return toolError(
      "invalid_input",
      visibility === "public"
        ? `${publicErrorPrefix(CONTRACT, "invalid_input")}"${tool}": ${invalid}`
        : invalid,
    );
  }
  return null;
}

function scopeMissing(tool: string, missing: "workspace" | "owner"): ToolErrorResult {
  if (toolVisibility(CONTRACT, tool) === "private") {
    return toolError("scope_missing", `the call carries no ${missing} in its scope`);
  }
  const what = missing === "workspace" ? "workspace" : "authenticated identity";
  return toolError(
    "scope_missing",
    `${publicErrorPrefix(CONTRACT, "scope_missing")}${what} in scope: tasks are read and written only within one workspace, for one owner.`,
  );
}

/** Run a private tool's handler, holding its answer to its closed output schema. */
function runPrivate(
  opts: Required<Omit<ServerOptions, "screenPath">>,
  tool: string,
  caller: pub.Caller,
  args: Args,
) {
  if (tool === "delete_workspace") {
    const removed = opts.store.read(caller.workspaceId, (ws) => workspaceCounts(ws));
    opts.store.removeWorkspace(caller.workspaceId);
    return { removed };
  }
  const handler = PRIVATE[tool];
  if (!handler) throw new Error(`no handler for "${tool}"`);
  const result = opts.store.mutate(caller.workspaceId, (tx) =>
    handler(tx, caller, args, opts.retentionMs),
  ) as Args;
  const problem = sharedSchemaError(`${tool}_output`, result);
  if (problem) throw new Error(`${tool} answer fails its schema: ${problem}`);
  return result;
}

function runPublic(store: Store, tool: string, caller: pub.Caller, args: Args) {
  const handler = PUBLIC[tool];
  if (!handler) throw new Error(`no handler for "${tool}"`);
  const fn = (tx: Tx) => handler(tx, caller, args, 0);
  return (
    isReadOnly(tool) ? store.view(caller.workspaceId, fn) : store.mutate(caller.workspaceId, fn)
  ) as Args;
}

/**
 * One `tools/call` decided as the server decides it (steps 1 to 7 above), for a context
 * already read. Exported so tests drive the contract in process.
 */
export async function callTool(
  opts: ServerOptions,
  tool: string,
  args: Args,
  ctx: CallContext,
): Promise<ReturnType<typeof success> | ToolErrorResult> {
  const refused = refusalBefore(tool, args, ctx);
  if (refused) return refused;
  const scope = scopeOf(tool, ctx);
  if ("missing" in scope) return scopeMissing(tool, scope.missing);
  if (CONTRACT.tools[tool]?.grant === true && !ctx.grant) {
    return toolError(
      "grant_missing",
      `${publicErrorPrefix(CONTRACT, "grant_missing")}the host stamped no run grant on this call to "${tool}"; nothing was written.`,
    );
  }
  const visibility = toolVisibility(CONTRACT, tool);
  const full = { store: opts.store, retentionMs: opts.retentionMs ?? DEFAULT_RETENTION_MS };
  try {
    return visibility === "private"
      ? success(runPrivate(full, tool, scope, args), false)
      : success(runPublic(opts.store, tool, scope, args), true);
  } catch (err) {
    if (err instanceof ToolCallError) return toolError(err.code, err.message);
    logInternal(tool, err);
    if (visibility === "private") return toolError("internal_error", INTERNAL_ERROR);
    throw new ProtocolError(ProtocolErrorCode.InternalError, INTERNAL_ERROR);
  }
}

/**
 * Why a read of or subscription to `uri` is refused, or null. The change hint is the
 * host's alone, and only for the workspace in its context (CONTRACT.md §5.1).
 */
export function hintRefusal(uri: string, meta: unknown): ProtocolError | null {
  if (!uri.startsWith(HINT_PREFIX)) return null;
  const ctx = readHostContext(meta);
  if (ctx?.principal === "host" && ctx.workspaceId && uri === hintUri(ctx.workspaceId)) return null;
  return new ProtocolError(
    ProtocolErrorCode.InvalidParams,
    `forbidden: ${uri} is readable only by the host, for the workspace in its context`,
    { code: "forbidden" },
  );
}

function readScreen(path: string | undefined): string {
  if (path && existsSync(path)) return readFileSync(path, "utf-8");
  return SCREEN_PLACEHOLDER;
}

function resourceContents(uri: string, screenPath: string | undefined) {
  if (uri === PANEL_URI || uri === CARD_URI) {
    let text: string;
    try {
      const panel = readScreen(screenPath);
      text = uri === CARD_URI ? cardHtml(panel) : panel;
    } catch (err) {
      logInternal("resources/read", err);
      throw new ProtocolError(ProtocolErrorCode.InternalError, INTERNAL_ERROR);
    }
    return { contents: [{ uri, mimeType: MCP_APP_MIME_TYPE, text }] };
  }
  if (uri.startsWith(HINT_PREFIX)) {
    return { contents: [{ uri, mimeType: "application/json", text: "{}" }] };
  }
  throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Resource not found: ${uri}`, { uri });
}

/** A tasks server over `store`. `subscribed` collects the hint URIs a 2025-era client subscribed to. */
export function buildServer(opts: ServerOptions, subscribed: Set<string> = new Set()): Server {
  const instructions = authoringGuide();
  const server = new Server(
    { name: SERVER_NAME, version: "1.0.0" },
    {
      capabilities: { tools: {}, resources: { subscribe: true } },
      ...(instructions ? { instructions } : {}),
    },
  );
  declareHostMeta(server, HOST_META);

  server.setRequestHandler("tools/list", async () => ({
    tools: Object.keys(CONTRACT.tools).map((name) => ({
      name,
      description: DESCRIPTIONS[name] ?? name,
      inputSchema: contractSchema(CONTRACT, name, "input") as { type: "object" },
      outputSchema: contractSchema(CONTRACT, name, "output") as { type: "object" },
      ...(isReadOnly(name) ? { annotations: { readOnlyHint: true } } : {}),
      // MCP Apps: a host that renders views shows the saved task as a card under
      // the call, fed its result. The model still reads the text result.
      ...(name === "create" ? { _meta: { ui: { resourceUri: CARD_URI } } } : {}),
    })),
  }));

  server.setRequestHandler("tools/call", async (request) => {
    const context = readHostContext(request.params._meta) ?? {};
    return callTool(opts, request.params.name, (request.params.arguments ?? {}) as Args, context);
  });

  server.setRequestHandler("resources/list", async () => ({
    resources: [
      { uri: PANEL_URI, name: "Scheduled", mimeType: MCP_APP_MIME_TYPE },
      { uri: CARD_URI, name: "Scheduled task", mimeType: MCP_APP_MIME_TYPE },
    ],
  }));

  server.setRequestHandler("resources/read", async (request) => {
    const refused = hintRefusal(request.params.uri, request.params._meta);
    if (refused) throw refused;
    return resourceContents(request.params.uri, opts.screenPath);
  });

  server.setRequestHandler("resources/subscribe", async (request) => {
    const refused = hintRefusal(request.params.uri, request.params._meta);
    if (refused) throw refused;
    subscribed.add(request.params.uri);
    return {};
  });

  server.setRequestHandler("resources/unsubscribe", async (request) => {
    subscribed.delete(request.params.uri);
    return {};
  });

  return server;
}

/**
 * The plugin's authoring guide (`skills/task-authoring/SKILL.md`, its body
 * without the frontmatter), served as the server's instructions so an MCP
 * client that loads no skills still learns which tools a job takes and in what
 * order. A host that loads the plugin's skills reads the same file. Empty when
 * the file is missing.
 */
function authoringGuide(): string {
  try {
    const text = readFileSync(join(import.meta.dir, "../skills/task-authoring/SKILL.md"), "utf-8");
    return text.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
  } catch {
    return "";
  }
}
