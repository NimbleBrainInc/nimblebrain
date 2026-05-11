import type { ResolvedFeatures } from "../config/features.ts";
import type { EventSink } from "../engine/types.ts";
import type { IdentityProvider, UserIdentity } from "../identity/provider.ts";
import type { Runtime } from "../runtime/runtime.ts";
import type { HealthMonitor } from "../tools/health-monitor.ts";
import type { UserConnectorStore } from "../users/user-connector-store.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import type { AuthMiddlewareOptions } from "./auth-middleware.ts";
import type { ConversationEventManager } from "./conversation-events.ts";
import type { SseEventManager } from "./events.ts";
import type { McpServerHost } from "./mcp-server.ts";
import type { LoginRateLimiter, RequestRateLimiter } from "./rate-limiter.ts";

// ---------------------------------------------------------------------------
// Multipart upload helper
// ---------------------------------------------------------------------------

/**
 * Minimal interface for an uploaded file pulled out of `Request.formData()`.
 *
 * Why this exists: Bun's `Request.formData()` returns the undici `FormData`,
 * whose entries are undici `File` instances. The DOM-lib `File` resolved at
 * an annotation site has incompatible iterator types, so a direct
 * `value as File` cast produces a TS error. Every multipart handler had its
 * own `value as unknown as { arrayBuffer(): Promise<ArrayBuffer>; ... }`
 * cast inline; this interface centralizes the shape.
 */
export interface UploadedFileEntry {
  arrayBuffer(): Promise<ArrayBuffer>;
  name?: string;
  type?: string;
  size?: number;
}

/**
 * Narrow a `FormData.get` / `FormData.entries` value to an
 * `UploadedFileEntry`. Returns `null` for strings, missing values, or
 * objects without an `arrayBuffer` method (which would fail at read time
 * anyway). Centralises the cross-type cast so handlers don't repeat it.
 */
export function asUploadedFile(value: unknown): UploadedFileEntry | null {
  if (!value || typeof value === "string") return null;
  const entry = value as UploadedFileEntry;
  return typeof entry.arrayBuffer === "function" ? entry : null;
}

// ---------------------------------------------------------------------------
// Standardized API error response
// ---------------------------------------------------------------------------

/** Consistent error shape returned by all API endpoints. */
export interface ApiErrorBody {
  error: string; // machine-readable error code (snake_case)
  message: string; // human-readable description
  details?: Record<string, unknown>; // optional structured context
}

/** Build a JSON error response with a consistent shape. */
export function apiError(
  status: number,
  error: string,
  message: string,
  details?: Record<string, unknown>,
  headers?: Record<string, string>,
): Response {
  const body: ApiErrorBody = { error, message };
  if (details) body.details = details;
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/**
 * Hono environment for fully-authenticated + workspace-scoped routes.
 * Routes: chat, tools, shell, files, events, resource proxy
 */
export type AppEnv = {
  Variables: {
    identity: UserIdentity;
    workspaceId: string;
  };
};

/**
 * Hono environment for authenticated-only routes (no workspace required).
 * Routes: /v1/bootstrap, /v1/auth/logout, /mcp
 */
export type AuthEnv = {
  Variables: {
    identity: UserIdentity;
  };
};

/**
 * Shared context built once in startServer(), threaded to all route files.
 */
export interface AppContext {
  runtime: Runtime;
  features: ResolvedFeatures;
  authOptions: AuthMiddlewareOptions;
  provider: IdentityProvider;
  workspaceStore: WorkspaceStore;
  /**
   * Per-user storage for personal connectors. Sits parallel to
   * workspaceStore — `users/<userId>/user.json` for personal bundles +
   * `users/<userId>/credentials/...` for the OAuth tokens those bundles
   * authenticate against.
   */
  userConnectorStore: UserConnectorStore;
  healthMonitor: HealthMonitor;
  sseManager: SseEventManager;
  conversationEventManager: ConversationEventManager;
  rateLimiter: LoginRateLimiter;
  chatLimiter: RequestRateLimiter;
  toolCallLimiter: RequestRateLimiter;
  eventSink: EventSink;
  isLocalhost: boolean;
  appOrigin: string | undefined;
  internalToken: string;
  mcpHost: McpServerHost;
}
