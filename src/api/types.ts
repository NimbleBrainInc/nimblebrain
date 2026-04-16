import type { ResolvedFeatures } from "../config/features.ts";
import type { EventSink } from "../engine/types.ts";
import type { IdentityProvider, UserIdentity } from "../identity/provider.ts";
import type { Runtime } from "../runtime/runtime.ts";
import type { HealthMonitor } from "../tools/health-monitor.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import type { AuthMiddlewareOptions } from "./auth-middleware.ts";
import type { ConversationEventManager } from "./conversation-events.ts";
import type { SseEventManager } from "./events.ts";
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
}
