import { AsyncLocalStorage } from "node:async_hooks";
import type { ToolPromotionControls } from "../engine/types.ts";
import type { UserIdentity } from "../identity/provider.ts";
import type { AgentProfile, ModelSlots } from "./types.ts";

/**
 * Per-request context threaded through AsyncLocalStorage.
 * Eliminates mutable module-level state for identity/workspace,
 * making concurrent request handling safe.
 */
export interface RequestContext {
  identity: UserIdentity | null;
  /**
   * The ONE workspace this request is bound to — the workspace whose data it
   * may read and write, whose tools it may dispatch, and whose config applies.
   *
   * There is exactly one, because a session reaches exactly one workspace (the
   * wall). A personal workspace is not special in this model — it is the
   * workspace created at first login, and it reaches this field the same way
   * any other does.
   *
   * Set on every door: chat (the conversation's own workspace — a chat resumed
   * in A while the client is focused on B reads A), automation runs
   * (provenance), `/mcp` and REST (the validated `X-Workspace-Id`), and each
   * per-call restamp (the routed workspace, which the wall guarantees is the
   * same one).
   *
   * Absent ⇒ no workspace in scope (an external `/mcp` request with no
   * `X-Workspace-Id`, a background job), and every consumer denies rather than
   * guessing.
   *
   * Note this is a property of the CONSUMERS, not a guarantee that absence
   * survives to them: the REST door substitutes the caller's personal
   * workspace when `X-Workspace-Id` is absent (`buildRestToolCallContext`), so
   * a headerless REST call reads the caller's own personal workspace rather
   * than being refused. `/mcp` has no such fallback and does refuse. Do not
   * read this field's optionality as licence to add an unguarded consumer.
   */
  workspaceId?: string;
  /**
   * Agent profiles and model-slot overrides from `workspaceId`'s config,
   * pre-loaded because the resolvers that read them (`agents` getter,
   * `getModelSlots`) are synchronous and cannot await a workspace load.
   */
  workspaceAgents?: Record<string, AgentProfile> | null;
  workspaceModelOverride?: Partial<ModelSlots> | null;
  /**
   * Active conversation id when this context was created inside `runtime.chat()`.
   * Tools that ask "what's happening in the current conversation" (the
   * `conversations__*` tools) read this when their input omits an explicit id.
   * Optional / undefined when the context is created outside a chat (REST tool
   * calls, MCP server requests, background jobs); tools must error explicitly
   * rather than silently falling back to the wrong conversation.
   */
  conversationId?: string;
  /**
   * The model this turn is actually running on, already resolved and
   * provider-qualified.
   *
   * A conversation is bound to one model for its life, so this is not the same
   * question as "what is the default model" — after a slot change or a profile
   * edit the configured default moves and this does not. A tool asked what it
   * is running on must answer from here; deriving it from config describes a
   * setting rather than the turn, and the two disagree exactly when someone
   * changes their model and asks.
   *
   * Undefined outside a run (REST tool calls, MCP requests, background jobs) —
   * there is no turn to describe.
   */
  model?: string;
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
