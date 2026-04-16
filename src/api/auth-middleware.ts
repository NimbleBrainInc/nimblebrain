import type { EventSink } from "../engine/types.ts";
import type { IdentityProvider, UserIdentity } from "../identity/provider.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import { constantTimeEqual, validateInternalToken } from "./auth-utils.ts";

// ── Auth mode detection ───────────────────────────────────────────

export type AuthMode = { type: "adapter"; provider: IdentityProvider } | { type: "dev" };

/**
 * Determine the auth mode from the available configuration.
 * IdentityProvider (from instance.json or DevIdentityProvider) > dev mode (no provider).
 */
export function resolveAuthMode(provider: IdentityProvider | null): AuthMode {
  if (provider) return { type: "adapter", provider };
  return { type: "dev" };
}

// ── Middleware ─────────────────────────────────────────────────────

export interface AuthMiddlewareOptions {
  /** Auth mode — adapter or dev. */
  mode: AuthMode;
  /** Internal token for bundle-to-host calls (scoped to chat endpoints). */
  internalToken: string;
  /** Event sink for audit logging. */
  eventSink: EventSink;
}

/** Successful auth result — identity is undefined for internal tokens and dev mode. */
export type AuthSuccess = { identity: UserIdentity | undefined };

/** Auth check result: a Response (rejection) or AuthSuccess. */
export type AuthResult = Response | AuthSuccess;

/** Type guard to distinguish auth rejection (Response) from success. */
export function isAuthError(result: AuthResult): result is Response {
  return result instanceof Response;
}

/**
 * Authenticate a request against the configured auth mode.
 *
 * Checks in order:
 * 1. Internal token (scoped to chat endpoints — always checked first for bundle-to-host calls)
 * 2. IdentityProvider.verifyRequest() when mode is "adapter"
 * 3. Pass-through when mode is "dev"
 *
 * Returns { identity } on success, or a Response (401/403) on failure.
 */
export async function authenticateRequest(
  req: Request,
  options: AuthMiddlewareOptions,
): Promise<AuthResult> {
  const { mode, internalToken } = options;

  // Extract bearer token if present
  const authHeader = req.headers.get("authorization") ?? "";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  // 1. Always check internal token first (bundle-to-host calls)
  if (bearerToken && constantTimeEqual(bearerToken, internalToken)) {
    const url = new URL(req.url);
    const error = validateInternalToken(bearerToken, internalToken, url.pathname, req.method);
    if (error) return error;
    return { identity: undefined };
  }

  // 2. Dev mode — no auth required
  if (mode.type === "dev") {
    return { identity: undefined };
  }

  // 3. IdentityProvider mode
  if (mode.type === "adapter") {
    const identity = await mode.provider.verifyRequest(req);
    if (identity) {
      return { identity };
    }
    // Unauthenticated
    logAuthFailure(req, options.eventSink);
    return new Response(null, { status: 401 });
  }

  // Unreachable, but satisfy TypeScript
  return new Response(null, { status: 401 });
}

// ── Workspace context ────────────────────────────────────────────

/** Valid workspace ID: ws_ prefix followed by 1-64 alphanumeric/underscore chars. */
export const WORKSPACE_ID_RE = /^ws_[a-z0-9_]{1,64}$/i;

/** Error thrown when workspace resolution fails. */
export class WorkspaceResolutionError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 400 | 403,
  ) {
    super(message);
    this.name = "WorkspaceResolutionError";
  }
}

/**
 * Resolve the workspace for a request.
 *
 * Resolution order:
 * 1. Explicit `X-Workspace-Id` header
 * 2. Conversation's workspaceId (if conversationId is provided and conversation exists)
 * 3. Default — user's single workspace (if they belong to exactly one)
 *
 * Returns the resolved workspace ID.
 * Throws WorkspaceResolutionError (400 or 403) on failure.
 */
export async function resolveWorkspace(
  req: Request,
  identity: UserIdentity,
  workspaceStore: WorkspaceStore,
  conversationWorkspaceId?: string,
): Promise<string> {
  const headerWsId = req.headers.get("x-workspace-id");

  let workspaceId: string | undefined;

  // 1. Explicit header
  if (headerWsId) {
    workspaceId = headerWsId;
  }
  // 2. Conversation's workspace
  else if (conversationWorkspaceId) {
    workspaceId = conversationWorkspaceId;
  }
  // 3. Default — single workspace
  else {
    const userWorkspaces = await workspaceStore.getWorkspacesForUser(identity.id);
    if (userWorkspaces.length === 1) {
      workspaceId = userWorkspaces[0]!.id;
    } else if (userWorkspaces.length === 0) {
      // Auto-provision a workspace when the user has none.
      // This handles: first login, manual deletion, or disk cleanup.
      const slug = identity.id
        .replace(/^user_/, "")
        .toLowerCase()
        .slice(0, 16);
      const name = identity.displayName ? `${identity.displayName}'s Workspace` : "Workspace";
      try {
        const ws = await workspaceStore.create(name, slug);
        await workspaceStore.addMember(ws.id, identity.id, "admin");
        workspaceId = ws.id;
      } catch {
        // Slug collision — try with timestamp suffix
        const fallbackSlug = `ws-${Date.now().toString(36)}`;
        const ws = await workspaceStore.create(name, fallbackSlug);
        await workspaceStore.addMember(ws.id, identity.id, "admin");
        workspaceId = ws.id;
      }
    } else {
      throw new WorkspaceResolutionError(
        "Multiple workspaces available. Set X-Workspace-Id header to specify which workspace to use.",
        400,
      );
    }
  }

  // Validate workspace ID format (prevents path traversal)
  if (workspaceId && !WORKSPACE_ID_RE.test(workspaceId)) {
    throw new WorkspaceResolutionError("Invalid workspace ID format.", 400);
  }

  // Validate membership
  const workspace = await workspaceStore.get(workspaceId);
  if (!workspace) {
    throw new WorkspaceResolutionError(`Workspace "${workspaceId}" not found.`, 400);
  }

  const isMember = workspace.members.some((m) => m.userId === identity.id);
  if (!isMember) {
    throw new WorkspaceResolutionError(
      `Access denied: not a member of workspace "${workspaceId}".`,
      403,
    );
  }

  return workspaceId;
}

// ── Helpers ───────────────────────────────────────────────────────

function logAuthFailure(req: Request, eventSink: EventSink): void {
  const ip = req.headers.get("x-forwarded-for") ?? "direct";
  console.error(`[nimblebrain] AUTH FAIL ip=${ip} timestamp=${new Date().toISOString()}`);
  eventSink.emit({
    type: "audit.auth_failure",
    data: { ip, method: req.method, path: new URL(req.url).pathname },
  });
}
