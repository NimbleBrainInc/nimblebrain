/**
 * The conversations server: one MCP server serving every tool of the conversations
 * contract and its screen. Each `tools/call` is decided in one order:
 *
 *   0. its host context (`params._meta["ai.nimblebrain/context"]`) is read, with the
 *      dimensions its transport verified applied; a contradiction is `context_mismatch`, a
 *      JSON-RPC error before any tool runs (`contracts/host-context/CONTEXT.md`);
 *   1. a tool the contract does not name is `unknown_tool`;
 *   2. a private tool called by anyone but the host is `forbidden` (before input and scope);
 *   3. arguments that fail the tool's input schema are `invalid_input`;
 *   4. a call with no workspace or no owner is `scope_missing`;
 *   5. the tool runs, walled to that scope.
 *
 * Every request reaching the server came through an authenticated host transport
 * (`main.ts`), so its host context is the host's word.
 */

import { existsSync, readFileSync } from "node:fs";
import {
  ProtocolError,
  ProtocolErrorCode,
  Server,
  type ServerContext,
} from "@modelcontextprotocol/server";
import {
  type CallContext,
  callContext,
  contractSchema,
  publicErrorPrefix,
  refuseUnlessAllowed,
  ToolCallError,
  type ToolErrorResult,
  toolError,
  toolVisibility,
  type VerifiedDimensions,
} from "../../server-sdk/src/index.ts";
import { CONTRACT, DESCRIPTIONS, inputError } from "./contract.ts";
import {
  exportTool,
  getTool,
  listTool,
  notFound,
  searchTool,
  statsTool,
  updateTool,
} from "./public-tools.ts";
import { CorruptConversationError } from "./scan.ts";
import {
  CONVERSATION_ID_RE,
  ConversationExistsError,
  ConversationNotFoundError,
  type ConversationStore,
  isPathSegment,
  type Scope,
  WorkspaceNotFoundError,
} from "./store.ts";

export const SERVER_NAME = "conversations";
export const SCREEN_URI = "ui://conversations/browser";
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

/** The page served when no built screen is installed beside the plugin. */
const SCREEN_PLACEHOLDER =
  '<!doctype html><html><head><meta charset="utf-8"><title>Conversations</title></head>' +
  "<body><p>The conversations screen is not installed with this server.</p></body></html>";

export interface ServerOptions {
  /** The store: one, or one per transport-verified tenant (a multi-tenant server). */
  store: ConversationStore | ((tenantId: string) => ConversationStore);
  /**
   * The dimensions this request's transport verified itself; none by default. Every request
   * that reaches the server came through an authenticated host transport, so its host context
   * (`params._meta["ai.nimblebrain/context"]`) is the host's word.
   */
  verifiedOf?: (ctx: ServerContext) => VerifiedDimensions;
  /** The built screen's HTML file; the placeholder page when absent. */
  screenPath?: string;
}

/** The scope a context names, when both halves are present and each is one path segment. */
function scopeOf(ctx: CallContext): Scope | { missing: "workspace" | "owner" } {
  if (!ctx.workspaceId || !isPathSegment(ctx.workspaceId)) return { missing: "workspace" };
  if (!ctx.ownerId || !isPathSegment(ctx.ownerId)) return { missing: "owner" };
  return { workspaceId: ctx.workspaceId, ownerId: ctx.ownerId };
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

/** The conversation a public call addresses: its `id`, else the one the call is made inside. */
function resolveId(id: unknown, ctx: CallContext): string {
  if (typeof id === "string" && id !== "current") return id;
  const current = ctx.conversationId;
  if (!current || !CONVERSATION_ID_RE.test(current)) {
    throw new ToolCallError(
      "no_current_conversation",
      `${publicErrorPrefix(CONTRACT, "no_current_conversation")} \`id\` may be omitted only inside a chat, where it defaults to the current conversation; from anywhere else, pass the id returned by conversations__list or conversations__search.`,
    );
  }
  return current;
}

type Args = Record<string, unknown>;
type Handler = (
  store: ConversationStore,
  scope: Scope,
  args: Args,
  ctx: CallContext,
) => Promise<unknown>;

/** Input types the schemas already checked, read as the schema says. */
// biome-ignore lint/suspicious/noExplicitAny: each input was checked against its contract schema
type Checked = any;

const PUBLIC: Record<string, Handler> = {
  list: (store, scope, args, ctx) => listTool(store, scope, args as Checked, ctx.conversationId),
  get: (store, scope, args, ctx) =>
    getTool(
      store,
      scope,
      { ...(args as Checked), id: resolveId(args.id, ctx) },
      ctx.conversationId,
    ),
  search: (store, scope, args) => searchTool(store, scope, args as Checked),
  update: (store, scope, args, ctx) =>
    updateTool(store, scope, { ...(args as Checked), id: resolveId(args.id, ctx) }),
  stats: (store, scope, args) => statsTool(store, scope, args as Checked),
  export: (store, scope, args, ctx) =>
    exportTool(store, scope, { ...(args as Checked), id: resolveId(args.id, ctx) }),
};

const EVENTS_PAGE = 1000;

const PRIVATE: Record<string, Handler> = {
  create: async (store, scope, args) => ({
    conversation: await store.create(scope, args as Checked),
  }),
  events: async (store, scope, args) => {
    const all = (await store.events(scope, String(args.id))) ?? [];
    const lastSeq = all.length;
    const after = (args.afterSeq as number | undefined) ?? 0;
    const through = args.throughSeq as number | undefined;
    const limit = (args.limit as number | undefined) ?? EVENTS_PAGE;
    const events = all
      .filter((e) => e.seq > after && (through === undefined || e.seq <= through))
      .slice(0, limit);
    return { events, lastSeq };
  },
  append_events: async (store, scope, args) => ({
    lastSeq: await store.append(scope, String(args.id), args.events as Args[]),
  }),
  delete: async (store, scope, args) => ({ deleted: await store.remove(scope, String(args.id)) }),
  delete_workspace: async (store, scope) => ({
    deleted: await store.removeWorkspace(scope.workspaceId),
  }),
};

/** A private tool's failure as its contract code. */
function privateFailure(err: unknown): ToolErrorResult {
  if (err instanceof ToolCallError) return toolError(err.code, err.message);
  if (err instanceof ConversationNotFoundError) {
    return toolError("conversation_not_found", `no conversation ${err.message} in scope`);
  }
  if (err instanceof ConversationExistsError) return toolError("conversation_exists", err.message);
  if (err instanceof WorkspaceNotFoundError) return toolError("workspace_not_found", err.message);
  if (err instanceof CorruptConversationError) {
    return toolError(
      "conversation_corrupted",
      `the stored conversation cannot be read: ${err.message}`,
    );
  }
  return toolError("internal_error", err instanceof Error ? err.message : String(err));
}

/**
 * A public tool's failure as its contract code. A failure the contract has no public code
 * for is rethrown, and answers as a JSON-RPC error.
 */
function publicFailure(err: unknown, args: Args): ToolErrorResult {
  if (err instanceof ToolCallError) return toolError(err.code, err.message);
  if (err instanceof CorruptConversationError || err instanceof ConversationNotFoundError) {
    const id = typeof args.id === "string" ? args.id : "";
    return toolError("conversation_not_found", notFound(id).message);
  }
  throw err;
}

function scopeMissing(visibility: "public" | "private", missing: "workspace" | "owner") {
  if (visibility === "private") {
    return toolError("scope_missing", `the call carries no ${missing} in its scope`);
  }
  const what = missing === "workspace" ? "workspace" : "authenticated identity";
  return toolError(
    "scope_missing",
    `${publicErrorPrefix(CONTRACT, "scope_missing")}${what} in scope: conversations are read and written only within one workspace, for one owner.`,
  );
}

async function callTool(
  store: ConversationStore,
  name: string,
  args: Args,
  ctx: CallContext,
): Promise<ReturnType<typeof success> | ToolErrorResult> {
  const visibility = toolVisibility(CONTRACT, name);
  if (!visibility) {
    return toolError("unknown_tool", `${publicErrorPrefix(CONTRACT, "unknown_tool")}"${name}"`);
  }
  const refused = refuseUnlessAllowed(CONTRACT, name, ctx);
  if (refused) return refused;
  const invalid = inputError(name, args);
  if (invalid !== null) {
    return toolError(
      "invalid_input",
      visibility === "public"
        ? `${publicErrorPrefix(CONTRACT, "invalid_input")}"${name}": ${invalid}`
        : invalid,
    );
  }
  const scope = scopeOf(ctx);
  if ("missing" in scope) return scopeMissing(visibility, scope.missing);
  const handler = (visibility === "public" ? PUBLIC : PRIVATE)[name];
  if (!handler) throw new Error(`no handler for contract tool "${name}"`);
  try {
    const result = (await handler(store, scope, args, ctx)) as Record<string, unknown>;
    return success(result, visibility === "public");
  } catch (err) {
    return visibility === "private" ? privateFailure(err) : publicFailure(err, args);
  }
}

function readScreen(path: string | undefined): string {
  if (path && existsSync(path)) return readFileSync(path, "utf-8");
  return SCREEN_PLACEHOLDER;
}

/** The store a call is served from: the one store, or the verified tenant's. */
function storeFor(opts: ServerOptions, tenantId: string | undefined): ConversationStore {
  if (typeof opts.store !== "function") {
    if (tenantId !== undefined) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidRequest,
        "this server serves one tenant; the transport named one",
      );
    }
    return opts.store;
  }
  if (tenantId === undefined) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidRequest,
      "this server serves several tenants; the transport verified none",
    );
  }
  return opts.store(tenantId);
}

/** A conversations server over `store`. One per connection; they share the store. */
export function buildServer(opts: ServerOptions): Server {
  const server = new Server(
    { name: SERVER_NAME, version: "1.0.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler("tools/list", async () => ({
    tools: Object.keys(CONTRACT.tools).map((name) => {
      const visibility = toolVisibility(CONTRACT, name);
      const readOnly = (visibility === "public" && name !== "update") || name === "events";
      return {
        name,
        description: DESCRIPTIONS[name] ?? name,
        inputSchema: contractSchema(CONTRACT, name, "input") as { type: "object" },
        outputSchema: contractSchema(CONTRACT, name, "output") as { type: "object" },
        ...(readOnly ? { annotations: { readOnlyHint: true } } : {}),
      };
    }),
  }));

  server.setRequestHandler("tools/call", async (request, ctx) => {
    const verified = opts.verifiedOf?.(ctx) ?? {};
    const read = callContext(request.params._meta, verified);
    if (!read.ok) {
      // The host's word contradicts its transport's: refused before any tool runs.
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, read.error, { code: read.code });
    }
    const store = storeFor(opts, read.tenantId);
    const args = (request.params.arguments ?? {}) as Args;
    return callTool(store, request.params.name, args, read.context);
  });

  server.setRequestHandler("resources/list", async () => ({
    resources: [{ uri: SCREEN_URI, name: "Conversations", mimeType: MCP_APP_MIME_TYPE }],
  }));

  server.setRequestHandler("resources/read", async (request) => {
    if (request.params.uri !== SCREEN_URI) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `Resource not found: ${request.params.uri}`,
        { uri: request.params.uri },
      );
    }
    return {
      contents: [
        { uri: SCREEN_URI, mimeType: MCP_APP_MIME_TYPE, text: readScreen(opts.screenPath) },
      ],
    };
  });

  return server;
}
