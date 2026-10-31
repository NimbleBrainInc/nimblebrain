import { AsyncLocalStorage } from "node:async_hooks";
import type { ToolPromotionControls } from "../engine/types.ts";
import type { UserIdentity } from "../identity/provider.ts";
import { setRequestIdentitySource } from "../observability/identity.ts";
import { type SpanAttrs, withRootContext } from "../observability/tracing.ts";
import type { ModelSlots } from "./types.ts";

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
   * wall).
   *
   * Set on every door: chat (the workspace its request addresses, which a
   * resume shares with its conversation), task runs
   * (provenance), `/mcp` (the membership-validated workspace in its URL),
   * REST (the membership-validated workspace in its URL), and each
   * per-call restamp (the routed workspace, which the wall guarantees is the
   * same one).
   *
   * Absent ⇒ no workspace in scope (a background job), and every consumer
   * denies rather than guessing.
   *
   * No request door leaves it absent: every REST route that reaches a source
   * names its workspace in the URL, and bare `/mcp` is refused. Do not read
   * this field's optionality as licence to add an unguarded consumer.
   */
  workspaceId?: string;
  /**
   * Model-slot overrides from `workspaceId`'s config, pre-loaded because the
   * resolver that reads them (`getModelSlots`) is synchronous and cannot await
   * a workspace load.
   */
  workspaceModelOverride?: Partial<ModelSlots> | null;
  /**
   * An unattended run's tool limit (its `allowedTools` predicate), stamped by
   * the run's tool router on each call it dispatches. Absent ⇒ no limit (a
   * chat, `/mcp`, REST). Read by whatever reads on a call's behalf beyond the
   * tool called, so it reads only what the run itself could: the host resolves
   * a tool's resource arguments only when this allows `nb__read_resource`.
   */
  isToolAllowed?: (name: string) => boolean;
  /**
   * Active conversation id when this context was created inside `runtime.chat()`.
   * Tools that ask "what's happening in the current conversation" (the
   * `conversations__*` tools) read this when their input omits an explicit id.
   * Optional / undefined when the context is created outside a chat (REST tool
   * calls, MCP server requests, background jobs, task runs); tools must error
   * explicitly rather than silently falling back to the wrong conversation.
   *
   * **A value here is always a real, loadable conversation id.** An unattended
   * run carries {@link runId} instead — see there for why the two are separate
   * fields rather than one correlation id wearing whichever name fits.
   */
  conversationId?: string;
  /**
   * Correlation id of the unattended run this context belongs to
   * (`executeTask`). Undefined in a chat.
   *
   * Separate from {@link conversationId} because a run has no conversation:
   * `executeTask` persists a run result, not a chat. Carrying the run id in
   * `conversationId` made one field answer two questions, and every consumer
   * had to know which caller populated it — which five of the nine readers
   * did not. They looked the id up as a conversation and got a miss: a tool
   * reporting `Conversation not found: run_…`, a dedupe check reading a
   * conversation that does not exist, and a skill a task created
   * persisting `origin: "chat"` with a run id attached.
   *
   * A reader wanting "the conversation" reads `conversationId` and correctly
   * gets nothing in a run. A reader wanting "what correlates this work" —
   * the usage ledger, telemetry — reads this.
   */
  runId?: string;
  /**
   * The door's run id for every run, a chat turn included: the subject a model
   * credential minted inside the run names, so a model gateway attributes and
   * budgets each call per run. The usage ledger records it as a call's `runId`,
   * so ledger and gateway name the same run. Not a conversation or task
   * correlation id (those are {@link conversationId} and {@link runId}).
   * Undefined outside a run.
   */
  credentialSubject?: string;
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
  /**
   * The agent runtime executing this turn, when its agent reports its own
   * usage (`RuntimeCapabilities.usage`). Set only around the runtime's
   * `execute`, so it is on the ledger lines of the usage the agent reports and
   * not on the calls NimbleBrain makes for the run itself (the fold between
   * turns, the title), which it measured. Undefined for a measured runtime and
   * outside a run.
   */
  agentRuntime?: string;
  toolPromotion?: ToolPromotionControls;
  /**
   * True when this context belongs to an unattended run (`executeTask` — a
   * task), false/undefined for interactive chat. Set once by the runtime
   * (never from caller input) and, because it rides the AsyncLocalStorage
   * context, inherited by every tool dispatched below it. Consumers use it to
   * bar the task-authoring surface from a run that has no human present
   * to confirm — a restriction, never an escalation, which is why it is
   * safe for `IdentityToolRouter` to read at execute time even though identity
   * is not (see that module's trust-boundary note).
   */
  unattended?: boolean;
  /**
   * True when the call came from the first-party web shell: its REST
   * `tools/call`, or an app view's `/mcp` call under a first-party credential
   * (`isAppCall`). Set by those two doors only, never from caller input, and
   * read as attribution (a person's verdict on a task run records `via: "ui"`),
   * never as authority: under a provider that marks every credential
   * first-party (`oidc`, `dev`) an external client can claim to be a view.
   */
  shellCall?: boolean;
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
 * Run `fn` with no request context and no active trace.
 *
 * For arming work that outlives the caller — a timer, a background loop. A
 * `setTimeout` captures the async context it is created in, so a timer armed
 * inside a request fires as that request (its identity, workspace, and trace)
 * and hands the same context to every timer it re-arms. Arm through this and
 * each fire starts clean, like boot-time work does.
 */
export function runDetached<T>(fn: () => T): T {
  return storage.exit(() => withRootContext(fn));
}

/**
 * Retrieve the current request context.
 * Returns undefined when called outside a runWithRequestContext() scope.
 */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Whether the current call's tool limit, if it has one, allows `toolName`. */
export function callMayUseTool(toolName: string): boolean {
  const limit = storage.getStore()?.isToolAllowed;
  return !limit || limit(toolName);
}

/**
 * The identity attributes spans and log lines carry, from the verified request
 * context: opaque ids only (user, workspace, conversation, and a task run's
 * id), never a display name or email.
 */
function requestIdentityOf(ctx: RequestContext | undefined): SpanAttrs {
  if (!ctx) return {};
  const attrs: SpanAttrs = {};
  if (ctx.identity?.id) attrs.user_id = ctx.identity.id;
  if (ctx.workspaceId) attrs.workspace_id = ctx.workspaceId;
  if (ctx.conversationId) attrs.conversation_id = ctx.conversationId;
  // A task run is correlated by its run id, under its own attribute name. As
  // `conversation_id` it would be a value no conversation query can join
  // against and a label the trace cannot be trusted on.
  if (ctx.runId) attrs.run_id = ctx.runId;
  return attrs;
}

setRequestIdentitySource(() => requestIdentityOf(getRequestContext()));
