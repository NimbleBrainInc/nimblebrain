import type { ResolvedFeatures } from "../config/features.ts";
import type { EventSink } from "../engine/types.ts";
import type { IdentityProvider, UserIdentity } from "../identity/provider.ts";
import type { Runtime } from "../runtime/runtime.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import type { AuthMiddlewareOptions } from "./auth-middleware.ts";
import type { ConversationEventManager } from "./conversation-events.ts";
import type { SseEventManager } from "./events.ts";
import type { McpServerHost } from "./mcp-server.ts";
import type { LoginRateLimiter, RequestRateLimiter } from "./rate-limiter.ts";

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
  sseManager: SseEventManager;
  conversationEventManager: ConversationEventManager;
  rateLimiter: LoginRateLimiter;
  chatLimiter: RequestRateLimiter;
  toolCallLimiter: RequestRateLimiter;
  /** Per-identity limiter for the remote `/mcp` surface (external clients + connector iframes). */
  mcpLimiter: RequestRateLimiter;
  /**
   * The hooks door's two buckets — pre-token (keyed on the client address) and
   * post-token (keyed on `(workspace, connector)`).
   *
   * Owned here rather than inside `hooksRoutes` so `startServer`'s `stop()`
   * clears their sweep timers with every other limiter's; a limiter constructed
   * inside the route factory would outlive the server it belongs to. Present
   * whether or not the door mounts — two idle maps cost nothing, and the
   * alternative is a conditional field every reader has to reason about.
   */
  hookAnonLimiter: RequestRateLimiter;
  hookWorkspaceLimiter: RequestRateLimiter;
  eventSink: EventSink;
  /**
   * Whether auth cookies (`nb_session`, `nb_refresh`, OAuth-state) are issued
   * with the `Secure` attribute. True under every identity provider: the
   * browser↔edge leg is HTTPS even though the container itself is reached over
   * plain HTTP behind the TLS-terminating edge, and browsers treat
   * http://localhost as a secure context. Never derived from the listen address
   * or a client-supplied forwarded-scheme header (both spoofable / misleading —
   * the listen address is `0.0.0.0` in production). A browser reaching a server
   * over plain HTTP at a non-localhost address drops these cookies.
   */
  secureCookies: boolean;
  appOrigin: string | undefined;
  mcpHost: McpServerHost;
}
