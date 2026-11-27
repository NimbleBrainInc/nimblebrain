/**
 * The files server: one MCP server serving every tool of the files contract, its screen and
 * the `files://{id}` resource template. Each `tools/call` is decided in one order, under the
 * host context it carries (`params._meta["ai.nimblebrain/context"]`,
 * `contracts/host-context/CONTEXT.md`):
 *
 *   1. a tool the contract does not name is `unknown_tool`;
 *   2. a private tool called by anyone but the host is `forbidden` (before input and scope);
 *   3. arguments that fail the tool's input schema are `invalid_input`;
 *   4. a call missing what its tool is walled to is `scope_missing` (`delete_workspace`: a
 *      workspace; every other tool: a workspace and an owner);
 *   5. the tool runs, walled to that scope.
 *
 * No tool of this contract is refused unattended but the private ones, which step 2 already
 * refuses (a host call never carries `unattended`). Every request reaching the server came
 * through an authenticated host transport (`main.ts`), so its host context is the host's word.
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
import { CONTRACT, DESCRIPTIONS, inputError, outputError } from "./contract.ts";
import {
  beginUpload,
  completeUpload,
  DEFAULT_MAX_FILE_BYTES,
  deleteWorkspace,
  MAX_DOWNLOAD_TTL_MS,
  MAX_UPLOAD_TTL_MS,
  type PrivateEnv,
  resolveUris,
  sweepUploads,
} from "./private.ts";
import * as pub from "./public.ts";
import { type FileRow, isPathSegment, type Store } from "./store.ts";
import type { Transfers } from "./transfer.ts";

export const SERVER_NAME = "files";
export const SCREEN_URI = "ui://files/browser";
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
export const FILE_URI_TEMPLATE = "files://{id}";

/** This server's host metadata: the screen's place in a host's shell, answered on the handshake. */
export const HOST_META = {
  hostVersion: "1.0",
  placements: [
    {
      slot: "sidebar",
      resourceUri: SCREEN_URI,
      route: "@nimblebraininc/files",
      label: "Files",
      icon: "folder",
      priority: 3,
    },
  ],
} as const;

const SCREEN_PLACEHOLDER =
  '<!doctype html><html><head><meta charset="utf-8"><title>Files</title></head>' +
  "<body><p>The files screen is not built. Run: cd packages/files/ui &amp;&amp; bun install &amp;&amp; bun run build</p></body></html>";

export interface ServerOptions {
  store: Store;
  transfers: Transfers;
  /** The plugin's clock, epoch ms. */
  now?: () => number;
  /** How long an upload URL lives, at most 900 s. */
  uploadTtlMs?: number;
  /** How long a download URL lives, at most 300 s. */
  downloadTtlMs?: number;
  /** The largest body `begin_upload` accepts. */
  maxFileBytes?: number;
  /** The built screen's HTML file; a placeholder page when absent. */
  screenPath?: string;
}

type Args = Record<string, unknown>;
// biome-ignore lint/suspicious/noExplicitAny: each input was checked against its contract schema
type Checked = any;
type Handler = (env: PrivateEnv, caller: pub.Caller, args: Checked) => unknown;

const PUBLIC: Record<string, Handler> = {
  list: pub.list,
  search: pub.search,
  tag: pub.tag,
  move: pub.move,
  delete: pub.remove,
  create_folder: pub.createFolderTool,
  update_folder: pub.updateFolderTool,
  delete_folder: pub.deleteFolderTool,
};

/** The public tools besides `read` whose answer is one file, so carries its `resource_link`. */
const ONE_FILE: Record<
  string,
  (env: PrivateEnv, caller: pub.Caller, args: Checked) => pub.FileAnswer
> = {
  info: pub.info,
  create: pub.create,
};

const PRIVATE: Record<string, Handler> = {
  begin_upload: beginUpload,
  complete_upload: completeUpload,
  resolve: resolveUris,
  delete_workspace: deleteWorkspace,
};

/** What a caller is told about a failure the contract has no code for; the detail goes to stderr. */
const INTERNAL_ERROR = "the files server failed; its log has the detail";

function logInternal(what: string, err: unknown): void {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`nb-files: ${what} failed: ${detail}\n`);
}

type Content =
  | { type: "text"; text: string }
  | { type: "resource_link"; uri: string; name: string; mimeType: string; size: number };

function success(result: Record<string, unknown>, content: Content[]) {
  return { content, structuredContent: result };
}

/** The env every handler runs in, with the contract's bounds applied to the options. */
export function envOf(opts: ServerOptions): PrivateEnv {
  return {
    store: opts.store,
    transfers: opts.transfers,
    now: opts.now ?? Date.now,
    uploadTtlMs: Math.min(opts.uploadTtlMs ?? MAX_UPLOAD_TTL_MS, MAX_UPLOAD_TTL_MS),
    downloadTtlMs: Math.min(opts.downloadTtlMs ?? MAX_DOWNLOAD_TTL_MS, MAX_DOWNLOAD_TTL_MS),
    maxFileBytes: opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
  };
}

/** The scope a tool is walled to, or what is missing. */
function scopeOf(tool: string, ctx: CallContext): pub.Caller | { missing: "workspace" | "owner" } {
  if (!ctx.workspaceId || !isPathSegment(ctx.workspaceId)) return { missing: "workspace" };
  if (tool !== "delete_workspace" && !ctx.ownerId) return { missing: "owner" };
  return {
    workspaceId: ctx.workspaceId,
    ownerId: ctx.ownerId ?? "",
    conversationId: ctx.conversationId ?? null,
    runId: ctx.runId ?? null,
  };
}

function refusalBefore(tool: string, args: Args, ctx: CallContext): ToolErrorResult | null {
  const visibility = toolVisibility(CONTRACT, tool);
  if (!visibility) {
    return toolError("unknown_tool", `${publicErrorPrefix(CONTRACT, "unknown_tool")}"${tool}"`);
  }
  const forbidden = refuseUnlessAllowed(CONTRACT, tool, ctx);
  if (forbidden) return forbidden;
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
  const what = missing === "workspace" ? "no workspace" : "no authenticated identity";
  return toolError(
    "scope_missing",
    `${publicErrorPrefix(CONTRACT, "scope_missing")}${what} in scope: files are read and written only within one workspace, for one owner.`,
  );
}

function jsonText(result: Record<string, unknown>): Content[] {
  return [{ type: "text", text: JSON.stringify(result, null, 2) }];
}

/** The `resource_link` a public answer about one file carries (CONTRACT.md §5). */
function fileLink(row: FileRow): Content {
  return {
    type: "resource_link",
    uri: `files://${row.id}`,
    name: row.filename,
    mimeType: row.mimeType,
    size: row.size,
  };
}

async function runPublic(env: PrivateEnv, tool: string, caller: pub.Caller, args: Args) {
  if (tool === "read") {
    const { output, row } = await pub.read(env, caller, args as Checked);
    return success(output, [fileLink(row), { type: "text", text: pub.readText(output) }]);
  }
  const one = ONE_FILE[tool];
  if (one) {
    const { output, row } = one(env, caller, args);
    return success(output, [fileLink(row), ...jsonText(output)]);
  }
  const handler = PUBLIC[tool];
  if (!handler) throw new Error(`no handler for "${tool}"`);
  const result = handler(env, caller, args) as Args;
  return success(result, jsonText(result));
}

function runPrivate(env: PrivateEnv, tool: string, caller: pub.Caller, args: Args) {
  const handler = PRIVATE[tool];
  if (!handler) throw new Error(`no handler for "${tool}"`);
  const result = handler(env, caller, args) as Args;
  const problem = outputError(tool, result);
  if (problem) throw new Error(`${tool} answer fails its schema: ${problem}`);
  return success(result, [{ type: "text", text: JSON.stringify(result) }]);
}

/**
 * One `tools/call` decided as the server decides it (steps 1 to 5 above), for a context
 * already read, in the env {@link envOf} builds. Exported so tests drive the contract in
 * process.
 */
export async function callTool(
  env: PrivateEnv,
  tool: string,
  args: Args,
  ctx: CallContext,
): Promise<ReturnType<typeof success> | ToolErrorResult> {
  const refused = refusalBefore(tool, args, ctx);
  if (refused) return refused;
  const scope = scopeOf(tool, ctx);
  if ("missing" in scope) return scopeMissing(tool, scope.missing);
  const visibility = toolVisibility(CONTRACT, tool);
  try {
    sweepUploads(env, scope.workspaceId);
    return visibility === "private"
      ? runPrivate(env, tool, scope, args)
      : await runPublic(env, tool, scope, args);
  } catch (err) {
    if (err instanceof ToolCallError) return toolError(err.code, err.message);
    logInternal(tool, err);
    if (visibility === "private") return toolError("internal_error", INTERNAL_ERROR);
    throw new ProtocolError(ProtocolErrorCode.InternalError, INTERNAL_ERROR);
  }
}

function readScreen(path: string | undefined): string {
  if (path && existsSync(path)) return readFileSync(path, "utf-8");
  return SCREEN_PLACEHOLDER;
}

/** A files server over `opts.store`, issuing transfer URLs through `opts.transfers`. */
export function buildServer(opts: ServerOptions): Server {
  const env = envOf(opts);
  const instructions = filesGuide();
  const server = new Server(
    { name: SERVER_NAME, version: "1.0.0" },
    {
      capabilities: { tools: {}, resources: {} },
      ...(instructions ? { instructions } : {}),
    },
  );
  declareHostMeta(server, HOST_META);

  server.setRequestHandler("tools/list", async () => ({
    tools: Object.keys(CONTRACT.tools).map((name) => {
      const annotations = CONTRACT.tools[name]?.annotations;
      return {
        name,
        description: DESCRIPTIONS[name] ?? name,
        inputSchema: contractSchema(CONTRACT, name, "input") as { type: "object" },
        outputSchema: contractSchema(CONTRACT, name, "output") as { type: "object" },
        ...(annotations ? { annotations } : {}),
      };
    }),
  }));

  server.setRequestHandler("tools/call", async (request) => {
    const context = readHostContext(request.params._meta) ?? {};
    return callTool(env, request.params.name, (request.params.arguments ?? {}) as Args, context);
  });

  server.setRequestHandler("resources/list", async () => ({
    resources: [{ uri: SCREEN_URI, name: "Files", mimeType: MCP_APP_MIME_TYPE }],
  }));

  server.setRequestHandler("resources/templates/list", async () => ({
    resourceTemplates: [{ uriTemplate: FILE_URI_TEMPLATE, name: "file" }],
  }));

  server.setRequestHandler("resources/read", async (request) => {
    const { uri } = request.params;
    if (uri === SCREEN_URI) {
      let text: string;
      try {
        text = readScreen(opts.screenPath);
      } catch (err) {
        logInternal("resources/read", err);
        throw new ProtocolError(ProtocolErrorCode.InternalError, INTERNAL_ERROR);
      }
      return { contents: [{ uri, mimeType: MCP_APP_MIME_TYPE, text }] };
    }
    // A `files://` URI is always the host's to read (CONTRACT.md §5): this server never
    // serves a body over MCP.
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Resource not found: ${uri}`, {
      uri,
    });
  });

  return server;
}

/**
 * The plugin's guide (`skills/files/SKILL.md`, its body without the frontmatter), served as
 * the server's instructions so an MCP client that loads no skills learns the same use of the
 * tools. A host that loads the plugin's skills reads the same file. Empty when missing.
 */
function filesGuide(): string {
  try {
    const text = readFileSync(join(import.meta.dir, "../skills/files/SKILL.md"), "utf-8");
    return text.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
  } catch {
    return "";
  }
}
