/**
 * MCP Server endpoint — exposes the platform as an MCP server via Streamable HTTP.
 *
 * External MCP clients (Claude Code, Open WebUI, etc.) connect to /mcp and
 * access all installed tools through the standard MCP protocol.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  type CreateTaskResult,
  ErrorCode,
  isInitializeRequest,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  type Resource,
  type ServerCapabilities,
} from "@modelcontextprotocol/sdk/types.js";
import { isToolEnabled, isToolVisibleToRole, type ResolvedFeatures } from "../config/features.ts";
import type { UserIdentity } from "../identity/provider.ts";
import { type RequestContext, runWithRequestContext } from "../runtime/request-context.ts";
import { McpSource } from "../tools/mcp-source.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import {
  createMcpTaskStore,
  type McpTaskStore,
  type OwnerContext,
  type TaskAwareSource,
} from "./mcp-task-store.ts";

/**
 * JSON-RPC error code for "resource not found".
 *
 * MCP specifies this code for `resources/read` when the URI can't be resolved.
 * It's not part of the base JSON-RPC 2.0 set nor the SDK's `ErrorCode` enum
 * (which only covers JSON-RPC's reserved range), so we declare it here.
 */
const RESOURCE_NOT_FOUND_CODE = -32002;

const mcpPkgPath = resolve(import.meta.dirname ?? __dirname, "../../package.json");
const mcpPkg = JSON.parse(readFileSync(mcpPkgPath, "utf-8")) as {
  version: string;
};
// Prefer the build-time-injected git tag; fall back to package.json for local dev.
const MCP_SERVER_VERSION = process.env.NB_VERSION || mcpPkg.version;

/* ── Session limits (configurable via env) ── */
const MAX_MCP_SESSIONS = parseInt(process.env.MCP_MAX_SESSIONS ?? "100", 10);
const SESSION_TTL_MS = parseInt(process.env.MCP_SESSION_TTL_MS ?? String(30 * 60 * 1000), 10);

interface SessionEntry {
  transport: WebStandardStreamableHTTPServerTransport;
  createdAt: number;
  lastAccessedAt: number;
}

/** Active sessions keyed by session ID. */
const sessions = new Map<string, SessionEntry>();

/** Periodic cleanup interval handle. */
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

/** Close and delete sessions that have exceeded the TTL. */
function sweepExpiredSessions(): void {
  const now = Date.now();
  for (const [sid, entry] of sessions) {
    if (now - entry.lastAccessedAt > SESSION_TTL_MS) {
      try {
        entry.transport.close();
      } catch {
        // Ignore close errors during sweep
      }
      sessions.delete(sid);
    }
  }
}

/** Start the periodic session cleanup (60s interval). */
function startSessionCleanup(): void {
  if (cleanupInterval) return;
  cleanupInterval = setInterval(sweepExpiredSessions, 60_000);
  // Allow the process to exit even if the interval is active
  if (cleanupInterval && typeof cleanupInterval === "object" && "unref" in cleanupInterval) {
    cleanupInterval.unref();
  }
}

// Start cleanup on module load
startSessionCleanup();

/** Workspace context captured at session creation time. */
export interface McpWorkspaceContext {
  /** Pre-scoped workspace registry (already filtered to workspace-accessible sources). */
  registry: ToolRegistry;
  identity: UserIdentity | null;
  workspaceId: string | null;
}

/**
 * Server capabilities for tasks utility (MCP draft 2025-11-25).
 *
 * - `cancel: {}` — we accept `tasks/cancel` and route through McpSource.cancelTask
 * - `requests.tools.call: {}` — we accept task-augmented `tools/call` (CreateTaskResult)
 * - `list` is deliberately absent — `tasks/list` is deferred (see SPEC_REFERENCE §Deferred).
 *
 * Shape defined by `ServerCapabilitiesSchema.tasks` in the SDK types.
 */
const TASKS_CAPABILITY: NonNullable<ServerCapabilities["tasks"]> = {
  cancel: {},
  requests: { tools: { call: {} } },
};

/**
 * Create a new MCP Server instance wired to the given ToolRegistry.
 * Each session gets its own Server + Transport pair.
 *
 * When workspaceCtx is provided, the pre-scoped workspace registry is used
 * (already filtered to workspace-accessible sources) and identity is
 * set/cleared around each tool execution.
 */
function createServer(
  registry: ToolRegistry,
  features: ResolvedFeatures,
  workspaceCtx?: McpWorkspaceContext,
): Server {
  // Workspace context is required — every request must be workspace-scoped
  const activeRegistry = workspaceCtx?.registry ?? registry; // registry is always workspace-scoped now

  // Build a session-scoped in-memory task store. The SDK installs handlers
  // for tasks/{get,result,cancel,list} automatically when this is passed via
  // ProtocolOptions.taskStore — we never register them ourselves. The store
  // binds every task to (workspaceId, identityId) so cross-tenant lookups
  // surface as -32602 "task not found" per spec §8 security guidance.
  //
  // Tasks require a workspace for authorization binding. If no workspace was
  // resolved (unauthenticated dev path), the capability isn't advertised and
  // the endpoint behaves as if tasks were disabled.
  const taskStore: McpTaskStore | undefined = workspaceCtx?.workspaceId
    ? createMcpTaskStore({
        identity: workspaceCtx.identity,
        workspaceId: workspaceCtx.workspaceId,
      })
    : undefined;

  const server = new Server(
    { name: "nimblebrain", version: MCP_SERVER_VERSION },
    {
      capabilities: {
        tools: {},
        resources: {},
        ...(taskStore ? { tasks: TASKS_CAPABILITY } : {}),
      },
      ...(taskStore ? { taskStore } : {}),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = await activeRegistry.availableTools();
    const orgRole = workspaceCtx?.identity?.orgRole;
    return {
      tools: tools
        .filter((t) => isToolEnabled(t.name, features))
        .filter((t) => isToolVisibleToRole(t.name, orgRole))
        .map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema as {
            type: "object";
            properties?: Record<string, unknown>;
            required?: string[];
          },
        })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const taskParam = request.params.task; // { ttl?, pollInterval? } | undefined
    const isTaskRequest = taskParam !== undefined;

    if (!isToolEnabled(name, features)) {
      return {
        content: [{ type: "text" as const, text: `Tool "${name}" is disabled` }],
        isError: true,
      };
    }
    if (!isToolVisibleToRole(name, workspaceCtx?.identity?.orgRole)) {
      return {
        content: [{ type: "text" as const, text: `Tool "${name}" is not available` }],
        isError: true,
      };
    }

    // ── Tool-level task negotiation (MCP spec 2025-11-25 §tasks) ─────────
    //
    // The low-level SDK `Server` validates the *result shape* against the
    // request (CreateTaskResult vs CallToolResult) but does NOT enforce the
    // tool-level taskSupport semantics. We do that here:
    //   - `required` + no task param   → -32601 MethodNotFound
    //   - `forbidden`/absent + task    → -32601 MethodNotFound
    //   - `optional`                   → either path is legal
    //
    // See `src/tools/types.ts::Tool.execution.taskSupport` for the field.
    const sepIndex = name.indexOf("__");
    const sourceName = sepIndex >= 0 ? name.slice(0, sepIndex) : null;
    const localName = sepIndex >= 0 ? name.slice(sepIndex + 2) : name;
    const taskAwareSource = sourceName ? activeRegistry.findTaskAwareSource(sourceName) : null;
    // Inspect the cached tool definition (if the source is MCP-backed) to
    // read `taskSupport`. Non-MCP sources never support tasks.
    let taskSupport: "optional" | "required" | "forbidden" | undefined;
    if (taskAwareSource) {
      const tools = await taskAwareSource.tools();
      const tool = tools.find((t) => t.name === name);
      taskSupport = tool?.execution?.taskSupport;
    }

    if (taskSupport === "required" && !isTaskRequest) {
      throw new McpError(
        ErrorCode.MethodNotFound,
        `Tool ${name} requires task augmentation (taskSupport: 'required')`,
      );
    }
    if (isTaskRequest && (!taskSupport || taskSupport === "forbidden")) {
      throw new McpError(
        ErrorCode.MethodNotFound,
        `Tool ${name} does not support task augmentation (taskSupport: ${taskSupport ?? "none"})`,
      );
    }

    // Build per-request context for AsyncLocalStorage (concurrency-safe)
    const reqCtx: RequestContext = {
      identity: workspaceCtx?.identity ?? null,
      workspaceId: workspaceCtx?.workspaceId ?? null,
      workspaceAgents: null,
      workspaceModelOverride: null,
    };

    // ── Task-augmented path ─────────────────────────────────────────────
    //
    // Return a CreateTaskResult immediately. The McpSource has already
    // started the stream and is draining it in the background; its
    // TaskHandle holds the terminal deferred for later `tasks/result` and
    // its abortController for `tasks/cancel`. We stash the (source, owner)
    // pair in the session's task store so the SDK-installed task handlers
    // can find their way back.
    if (isTaskRequest && taskAwareSource && taskStore && workspaceCtx?.workspaceId) {
      const ownerContext: OwnerContext = {
        workspaceId: workspaceCtx.workspaceId,
        ...(workspaceCtx.identity?.id ? { identityId: workspaceCtx.identity.id } : {}),
      };
      const createResult: CreateTaskResult = await runWithRequestContext(reqCtx, () =>
        taskAwareSource.startToolAsTask(localName, (args ?? {}) as Record<string, unknown>, {
          ownerContext,
          ...(taskParam.ttl !== undefined ? { ttlMs: taskParam.ttl } : {}),
        }),
      );
      taskStore.recordTask({
        source: taskAwareSource as unknown as TaskAwareSource,
        toolFullName: name,
        task: createResult.task,
        ownerContext,
      });
      return createResult;
    }

    // ── Inline path ─────────────────────────────────────────────────────
    //
    // Preserve `structuredContent` — dropping it was a long-standing bug
    // that silently violated `CallToolResult must be returned as-is`
    // (SPEC_REFERENCE §Non-Negotiable Rule 4). `_meta` propagation on the
    // inline path is a no-op today because the engine's ToolResult shape
    // doesn't carry `_meta`; task-augmented flows carry `_meta` through
    // naturally because `tasks/result` returns the full CallToolResult
    // directly from `awaitToolTaskResult` (see mcp-task-store.ts).
    const result = await runWithRequestContext(reqCtx, () =>
      activeRegistry.execute({
        id: crypto.randomUUID(),
        name,
        input: (args ?? {}) as Record<string, unknown>,
      }),
    );
    return {
      content: result.content,
      ...(result.structuredContent !== undefined
        ? { structuredContent: result.structuredContent }
        : {}),
      isError: result.isError,
    };
  });

  // ── resources/list ────────────────────────────────────────────────
  //
  // Aggregate resources from every source in the workspace registry.
  //
  // Delegates to each source's underlying MCP client (via `McpSource`) so we
  // don't duplicate the server-side resource metadata. Sources that don't
  // expose resources (e.g. plain `InlineSource` without async reads) are
  // skipped. Sources that throw on `listResources` are skipped too — one
  // broken bundle must not take down the workspace-wide listing.
  //
  // Pagination: MVP returns everything in a single response (no `cursor`
  // plumbing). The SDK type allows `nextCursor`, but iframe consumers today
  // enumerate the full list. Document here so we remember to add cursor
  // support if/when resource counts grow beyond a few hundred per workspace.
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const resources: Resource[] = [];
    for (const source of activeRegistry.getSources()) {
      if (!(source instanceof McpSource)) continue;
      const client = source.getClient();
      if (!client) continue;
      try {
        const result = await client.listResources();
        for (const r of result.resources) {
          resources.push(r as Resource);
        }
      } catch {
        // Source didn't implement resources/list, or transport hiccup.
        // Swallow per-source errors so one bad source doesn't kill the list.
      }
    }
    return { resources };
  });

  // ── resources/read ────────────────────────────────────────────────
  //
  // Iterate workspace-scoped sources and return the first `ReadResourceResult`
  // that resolves. Mirrors the `nb__read_resource` tool's dispatch loop, but
  // returns the full MCP `contents[]` shape (including `blob` for binaries)
  // rather than flattening to text.
  //
  // Cross-workspace lookups: because we only iterate `activeRegistry`
  // (already scoped via `ensureWorkspaceRegistry`), a URI owned by a source
  // that lives in a different workspace simply isn't found and returns
  // `-32002`. We deliberately do not distinguish "doesn't exist anywhere"
  // from "exists but you can't see it" — per MCP spec guidance, avoid
  // leaking cross-tenant existence information.
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;

    for (const source of activeRegistry.getSources()) {
      // Prefer the MCP client path — returns the raw `ReadResourceResult`
      // (including binary `blob` payloads) as-is so callers get spec shape.
      if (source instanceof McpSource) {
        const client = source.getClient();
        if (!client) continue;
        try {
          const result = await client.readResource({ uri });
          if (result.contents && result.contents.length > 0) {
            return result;
          }
        } catch {
          // Resource not found on this source; keep trying the next one.
        }
        continue;
      }
    }

    // No source resolved the URI. Per MCP spec, raise a JSON-RPC error —
    // the SDK transport converts McpError into a proper `error` envelope.
    throw new McpError(RESOURCE_NOT_FOUND_CODE, `Resource not found: ${uri}`, { uri });
  });

  return server;
}

/**
 * Handle an incoming HTTP request on the /mcp path.
 *
 * - POST: JSON-RPC messages (initialization or subsequent)
 * - GET: SSE stream for server-initiated messages
 * - DELETE: Session termination
 */
export async function handleMcpRequest(
  request: Request,
  registry: ToolRegistry,
  features: ResolvedFeatures,
  workspaceCtx?: McpWorkspaceContext,
): Promise<Response> {
  const method = request.method;

  if (method === "POST") {
    return handlePost(request, registry, features, workspaceCtx);
  }

  if (method === "GET") {
    return handleGet(request);
  }

  if (method === "DELETE") {
    return handleDelete(request);
  }

  return new Response("Method not allowed", { status: 405 });
}

async function handlePost(
  request: Request,
  registry: ToolRegistry,
  features: ResolvedFeatures,
  workspaceCtx?: McpWorkspaceContext,
): Promise<Response> {
  const sessionId = request.headers.get("mcp-session-id");

  // Existing session — reuse transport
  if (sessionId) {
    const entry = sessions.get(sessionId);
    if (!entry) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Session not found" },
          id: null,
        }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    }
    entry.lastAccessedAt = Date.now();
    return entry.transport.handleRequest(request);
  }

  // New session — check if this is an initialize request
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error" },
        id: null,
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  if (!isInitializeRequest(body)) {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: No valid session ID provided",
        },
        id: null,
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // Evict expired sessions and enforce capacity limit
  sweepExpiredSessions();
  if (sessions.size >= MAX_MCP_SESSIONS) {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Too many active sessions",
        },
        id: null,
      }),
      { status: 429, headers: { "Content-Type": "application/json" } },
    );
  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (sid: string) => {
      const now = Date.now();
      sessions.set(sid, {
        transport,
        createdAt: now,
        lastAccessedAt: now,
      });
    },
    onsessionclosed: (sid: string) => {
      sessions.delete(sid);
    },
  });

  transport.onclose = () => {
    if (transport.sessionId) {
      sessions.delete(transport.sessionId);
    }
  };

  const server = createServer(registry, features, workspaceCtx);
  await server.connect(transport);

  return transport.handleRequest(request, { parsedBody: body });
}

async function handleGet(request: Request): Promise<Response> {
  const sessionId = request.headers.get("mcp-session-id");
  if (!sessionId) {
    return new Response("Missing session ID", { status: 400 });
  }
  const entry = sessions.get(sessionId);
  if (!entry) {
    return new Response("Session not found", { status: 404 });
  }
  entry.lastAccessedAt = Date.now();
  return entry.transport.handleRequest(request);
}

async function handleDelete(request: Request): Promise<Response> {
  const sessionId = request.headers.get("mcp-session-id");
  if (!sessionId) {
    return new Response("Missing session ID", { status: 400 });
  }
  const entry = sessions.get(sessionId);
  if (!entry) {
    return new Response("Session not found", { status: 404 });
  }
  entry.lastAccessedAt = Date.now();
  return entry.transport.handleRequest(request);
}

/**
 * Close all active MCP sessions and stop the cleanup timer. Called during server shutdown.
 */
export async function closeAllMcpSessions(): Promise<void> {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
  for (const [sid, entry] of sessions) {
    try {
      await entry.transport.close();
    } catch {
      // Ignore close errors during shutdown
    }
    sessions.delete(sid);
  }
}
