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
  isInitializeRequest,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { isToolEnabled, isToolVisibleToRole, type ResolvedFeatures } from "../config/features.ts";
import type { UserIdentity } from "../identity/provider.ts";
import { type RequestContext, runWithRequestContext } from "../runtime/request-context.ts";
import type { ToolRegistry } from "../tools/registry.ts";

const mcpPkgPath = resolve(import.meta.dirname ?? __dirname, "../../package.json");
const mcpPkg = JSON.parse(readFileSync(mcpPkgPath, "utf-8")) as {
  version: string;
};

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

  const server = new Server(
    { name: "nimblebrain", version: mcpPkg.version },
    { capabilities: { tools: {} } },
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

    // Build per-request context for AsyncLocalStorage (concurrency-safe)
    const reqCtx: RequestContext = {
      identity: workspaceCtx?.identity ?? null,
      workspaceId: workspaceCtx?.workspaceId ?? null,
      workspaceAgents: null,
      workspaceModelOverride: null,
    };

    const result = await runWithRequestContext(reqCtx, () =>
      activeRegistry.execute({
        id: crypto.randomUUID(),
        name,
        input: (args ?? {}) as Record<string, unknown>,
      }),
    );
    return {
      content: result.content,
      isError: result.isError,
    };
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
