import { AsyncLocalStorage } from "node:async_hooks";
import type { ToolPromotionControls } from "../engine/types.ts";
import type { UserIdentity } from "../identity/provider.ts";
import type { AgentProfile, ModelSlots } from "./types.ts";

/**
 * The request's scope — the door it came through. A **discriminated union, not
 * a nullable workspaceId**: a workspace request structurally carries its
 * (non-null) `workspaceId`, and an identity request has no workspace fields at
 * all. This makes "a workspace request with no workspace" *unrepresentable*
 * rather than rejected at runtime — `requireWorkspaceId()` can't be defeated by
 * a stray `null`, because there is no null to pass.
 *
 * - `workspace` — owned by a workspace, authorized by membership. Carries the
 *   workspace's agent profiles + model overrides (loaded for the chat path;
 *   `null` for the leaner REST / MCP dispatch paths).
 * - `identity` — owned by the user (conversations, …), authorized by ownership.
 *   No workspace, so no workspace fields. See `tools/identity-sources.ts`.
 */
export type RequestScope =
  | {
      kind: "workspace";
      workspaceId: string;
      workspaceAgents: Record<string, AgentProfile> | null;
      workspaceModelOverride: Partial<ModelSlots> | null;
    }
  | { kind: "identity" };

/**
 * Per-request context threaded through AsyncLocalStorage.
 * Eliminates mutable module-level state for identity/workspace,
 * making concurrent request handling safe.
 *
 * `identity` is orthogonal to `scope` (an authenticated principal is present on
 * both doors; some internal paths — e.g. a resource read — carry `null`). The
 * workspace-vs-identity decision lives entirely in `scope`.
 */
export interface RequestContext {
  identity: UserIdentity | null;
  scope: RequestScope;
  /**
   * Active conversation id when this context was created inside `runtime.chat()`.
   * Tools that ask "what's happening in the current conversation" (e.g.
   * `skills__active_for`) read this when their input omits an explicit id.
   * Optional / undefined when the context is created outside a chat (REST tool
   * calls, MCP server requests, background jobs); tools must error explicitly
   * rather than silently falling back to the wrong conversation.
   */
  conversationId?: string;
  /**
   * The workspace that owns files created or read in this request — the focused
   * workspace. Orthogonal to `scope`, and set on BOTH doors: identity-door
   * `files__*` tools need it because `scope.workspaceId` is the personal/session
   * workspace, not the focused workspace. Absent ⇒ no workspace in scope (e.g. an external
   * `/mcp` request with no `X-Workspace-Id`): file storage denies rather than
   * guessing a workspace.
   */
  fileWorkspaceId?: string;
  toolPromotion?: ToolPromotionControls;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Execute a function within a request-scoped context.
 * All async operations within `fn` (including parallel tool calls)
 * will see the same context via getRequestContext().
 */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/**
 * Retrieve the current request context.
 * Returns undefined when called outside a runWithRequestContext() scope.
 */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}
