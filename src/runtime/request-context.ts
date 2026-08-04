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
   * The workspace this request is BOUND to — the one whose data it may read and
   * write. Distinct from `scope.workspaceId`, which is the door the request came
   * through (the session/personal workspace on the identity door), and the two
   * genuinely differ: a chat resumed in workspace A while the client is focused
   * on B has `scope.workspaceId = B`'s session and `boundWorkspaceId = A`. That
   * is the seal — the conversation's own workspace wins, so it is deliberately
   * NOT "the focused workspace".
   *
   * Set on every door: chat (the conversation's own workspace), automation runs
   * (provenance), `/mcp` and REST (the validated `X-Workspace-Id`). Read by
   * every kernel identity source — `files__*`, `automations__*`,
   * `conversations__*` — because all three own workspace-partitioned data while
   * dispatching through the identity door.
   *
   * Optional on the type because plenty of contexts genuinely have no bound
   * workspace (background jobs, resource reads outside a workspace). Absence
   * NARROWS — every consumer denies — so it is never the widening default that
   * a missing list-filter would be.
   */
  boundWorkspaceId?: string;
  toolPromotion?: ToolPromotionControls;
  /**
   * True when this context belongs to an unattended run (`executeTask` — an
   * automation), false/undefined for interactive chat. Set once by the runtime
   * (never from caller input) and, because it rides the AsyncLocalStorage
   * context, inherited by every delegated sub-agent at any depth. Consumers use
   * it to bar the automation-authoring surface from a run that has no human
   * present to confirm — a restriction, never an escalation, which is why it is
   * safe for `IdentityToolRouter` to read at execute time even though identity
   * is not (see that module's trust-boundary note).
   */
  unattended?: boolean;
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
