/**
 * Automation executor: runs an automation's prompt through the chat engine.
 *
 * `createDirectExecutor` runs each automation via `runtime.executeTask()`
 * in-process (wired in `tools/platform/automations.ts`) — the only path now
 * that automations is an in-process platform source (the former HTTP executor
 * + standalone MCP server were removed). A scheduled run fires as the
 * automation's owner; see `getExecutorContext` in the platform source.
 *
 * No retry logic — the scheduler handles backoff.
 */

import { type AutomationRunTrigger, isTransientError } from "./scheduler.ts";
import type { Automation, AutomationRun } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/**
 * Minimal task request shape (matches runtime `TaskRequest`).
 *
 * Automations execute via `runtime.executeTask()`, not `runtime.chat()`:
 * the agent runs unattended and produces a finished deliverable, with
 * the runtime supplying the task-mode system prompt that forbids
 * greetings and follow-up questions. The chat surface is for live user
 * conversations; this is its sibling primitive for scheduled work.
 *
 * Decoupled (locally-typed, structurally compatible) on purpose: keeps
 * the bundle from importing runtime internals — anything providing this
 * shape can inject an executor.
 */
export interface TaskFnRequest {
  /** The task description. Goes in as the user message. */
  prompt: string;
  model?: string;
  maxIterations?: number;
  maxInputTokens?: number;
  allowedTools?: string[];
  metadata?: Record<string, unknown>;
  /**
   * Focused workspace (optional). Set → tools scoped to that workspace
   * + identity tools, briefing for that workspace. Omitted →
   * cross-workspace reach, no focused-workspace briefing.
   */
  workspaceId?: string;
  /** Identity under which this automation runs. */
  identity?: { id: string; name?: string; email?: string; role?: string };
  /**
   * Cancellation signal forwarded into `runtime.executeTask()` → engine
   * → tool calls. When the scheduler's per-run controller aborts
   * (timeout, explicit cancel, scheduler stop), the in-flight LLM/tool
   * work actually stops instead of being orphaned. Before this field
   * existed, a chat that exceeded `maxRunDurationMs` ran to completion
   * in the background and wrote a complete conversation to disk
   * minutes after the executor had already synthesized a fake
   * "timeout" run record.
   */
  signal?: AbortSignal;
}

/** Minimal task result shape (matches runtime `TaskResult`). */
export interface TaskFnResult {
  /** The deliverable — the agent's final assistant message. */
  output: string;
  /** Traceability anchor — the fresh conversation backing this task. */
  conversationId: string;
  toolCalls: Array<Record<string, unknown>>;
  stopReason: string;
  usage: { inputTokens: number; outputTokens: number; iterations: number };
}

/** A function that executes a single task. Injected by the caller. */
export type TaskFn = (request: TaskFnRequest) => Promise<TaskFnResult>;

/** Runtime context injected into the executor for workspace/identity scoping. */
export interface ExecutorContext {
  workspaceId?: string;
  identity?: TaskFnRequest["identity"];
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Recursive-call guard. An automation whose `allowedTools` includes a
 * tool that creates more automations would spawn an unbounded loop on
 * every scheduled run. The LLM-facing schema doesn't accept
 * `allowedTools`, but operator file edits and bundle-contributed
 * schedules can still set it — so the guard lives at the executor,
 * which sees the merged Automation regardless of how it was authored.
 */
const RECURSIVE_TOOL_PATTERNS = [
  "automations__create",
  "automations__update",
  "automations__delete",
];

export function containsRecursiveTool(allowedTools: string[] | undefined): string | null {
  if (!allowedTools) return null;
  for (const tool of allowedTools) {
    for (const pattern of RECURSIVE_TOOL_PATTERNS) {
      if (tool === pattern || tool.includes(pattern)) return tool;
    }
  }
  return null;
}

function buildRequest(automation: Automation, ctx?: ExecutorContext): TaskFnRequest {
  const offending = containsRecursiveTool(automation.allowedTools);
  if (offending !== null) {
    throw new Error(
      `Automation "${automation.name}" lists "${offending}" in allowedTools — refusing to run. ` +
        `Automations cannot create/update/delete other automations from a scheduled run; ` +
        `that pattern produces unbounded growth. Edit the automation file to remove the entry.`,
    );
  }

  // The task surface owns the "you are running unattended, produce a
  // deliverable" framing in its system prompt — the automation's prompt
  // goes in as the plain task description, not wrapped or prefixed here.
  const req: TaskFnRequest = {
    prompt: automation.prompt,
    metadata: {
      source: "automation",
      automationId: automation.id,
      automationName: automation.name,
    },
  };
  if (automation.model != null) req.model = automation.model;
  if (automation.maxIterations != null) req.maxIterations = automation.maxIterations;
  if (automation.maxInputTokens != null) req.maxInputTokens = automation.maxInputTokens;
  if (automation.allowedTools != null) req.allowedTools = automation.allowedTools;
  if (ctx?.workspaceId) req.workspaceId = ctx.workspaceId;
  if (ctx?.identity) req.identity = ctx.identity;
  return req;
}

/**
 * Per-tool-call failure reasons that mean a connector the run NEEDED was not
 * usable — so a `complete` stop is not an honest success:
 *
 *   - `unknown_tool_source`     → the run ATTEMPTED a namespaced tool call but
 *                                 the tool's source isn't registered in that
 *                                 workspace — the app isn't installed there
 *                                 (`route.ts`: `getSource()` returned nothing).
 *                                 (Orchestrator reason; see `error-mapping.ts`.)
 *   - `workspace_access_denied` → the run ATTEMPTED a call into a workspace its
 *                                 owner isn't a member of (e.g. another user's
 *                                 personal workspace) — unreachable by design.
 *                                 (Orchestrator reason.)
 *   - `reauth_required`         → the run ATTEMPTED a call to an INSTALLED
 *                                 connector whose authorization had expired /
 *                                 been revoked — the call routed fine but failed
 *                                 downstream on auth. Emitted by the connector
 *                                 auth-loss path (`McpSource.execute`), NOT the
 *                                 orchestrator — a reactive 401 (OAuth-provider
 *                                 remote) or a proactive revalidation flip
 *                                 (Composio, via `ConnectionRevalidator`) both
 *                                 surface this same reason.
 *
 * KEY LIMITATION — every reason here requires the agent to have ATTEMPTED the
 * call. A required connector that never appears in the agent's toolset (so it
 * never tries) produces no reason and is NOT de-masked. The production standup
 * incident was actually this never-attempted variant: the agent ran `nb__search`,
 * found no Teams connector in any reachable workspace, and "completed" by
 * documenting the gap — never calling a Teams tool. So this de-masks the
 * attempted-call class (a strict improvement, zero false positives); the
 * never-attempted class needs a different signal (the agent self-reporting an
 * incomplete required step) and is tracked separately.
 *
 * These are the *connector-unreachable* reasons. Two are orchestrator routing
 * reasons (`error-mapping.ts`); `reauth_required` is the connector auth-loss
 * reason. The orchestrator emits five reasons in all — the other three are
 * agent / typo errors, not connector gaps, excluded below. Every reason in the
 * set is really produced and tested, so it stays grounded in values that occur.
 *
 * Deliberately narrower than the full reason taxonomy. Excluded on purpose:
 *   - `invalid_tool_name` / `unknown_identity_source` — usually the agent probing
 *     a wrong name and self-correcting, not a real connector gap; flagging them
 *     would mark healthy runs failed.
 *   - `unknown_workspace` — a target workspace deleted out from under the run.
 *     Real but rare, and the taxonomy frames it as a typo / cross-tenant accident
 *     (agent error) rather than a connector gap. Left out for now; revisit if it
 *     shows up in practice.
 */
const UNREACHABLE_CONNECTOR_REASONS = new Set([
  "unknown_tool_source",
  "workspace_access_denied",
  "reauth_required",
]);

/** Tool-call entries (loosely typed in `TaskFnResult`) whose routing failed. */
function unreachableConnectorCalls(toolCalls: TaskFnResult["toolCalls"]): string[] {
  if (!Array.isArray(toolCalls)) return [];
  const names: string[] = [];
  for (const tc of toolCalls) {
    const reason = tc.errorReason;
    const name = tc.name;
    if (typeof reason === "string" && UNREACHABLE_CONNECTOR_REASONS.has(reason)) {
      names.push(typeof name === "string" ? name : "(unknown tool)");
    }
  }
  return names;
}

function mapResultToRun(
  automation: Automation,
  startedAt: string,
  data: TaskFnResult,
): AutomationRun {
  const stopReason = data.stopReason as AutomationRun["stopReason"];
  let status: AutomationRun["status"] = mapStopReasonToStatus(stopReason);

  // De-mask the silent connector failure: when the model reports `complete`,
  // the run would otherwise be a green `success` — even if a tool call hit a
  // connector that couldn't be routed (missing, disconnected, or in another
  // workspace the owner can't reach). The agent commonly "completes" by
  // documenting the gap instead of doing the work, which is precisely the
  // failure operators reported (a standup summary that never reached Teams,
  // recorded as success). A connector-unreachable call means the automation
  // did not actually do its job: downgrade to `failure` and name the tool(s)
  // so the run list shows it instead of burying it in the conversation.
  //
  // Only overrides an otherwise-`success` run; a run already classified
  // failure/timeout keeps its (stronger) status.
  let error: string | undefined;
  if (status === "success") {
    const unreachable = unreachableConnectorCalls(data.toolCalls);
    if (unreachable.length > 0) {
      status = "failure";
      const unique = [...new Set(unreachable)];
      error =
        `Connector unavailable during run: ${unique.length} tool call type(s) could not be ` +
        `routed (${unique.join(", ")}). The required connector is missing, disconnected, or ` +
        `in a workspace this automation cannot reach — the run did not complete its intended action.`;
    }
  }

  return {
    id: `run_${crypto.randomUUID().slice(0, 12)}`,
    automationId: automation.id,
    startedAt,
    completedAt: new Date().toISOString(),
    status,
    conversationId: data.conversationId,
    inputTokens: data.usage.inputTokens,
    outputTokens: data.usage.outputTokens,
    toolCalls: Array.isArray(data.toolCalls) ? data.toolCalls.length : 0,
    iterations: data.usage.iterations,
    resultPreview: data.output || undefined,
    stopReason,
    ...(error ? { error } : {}),
  };
}

/**
 * Map an engine stop reason to an automation-run status.
 *
 *   complete                                 → success (model said done)
 *   max_iterations                           → timeout (agent loop cap)
 *   length / content_filter / error / other  → failure (model couldn't
 *                                              finish — surface so the
 *                                              operator knows)
 *
 * Defaulting unknown values to `failure` is intentional: the alternative
 * is silent green status, which is exactly the masking this PR's parent
 * change is meant to eliminate. Any new stop reason from the engine
 * should explicitly opt into `success` here.
 */
function mapStopReasonToStatus(stopReason: AutomationRun["stopReason"]): AutomationRun["status"] {
  switch (stopReason) {
    case "complete":
      return "success";
    case "max_iterations":
      return "timeout";
    default:
      return "failure";
  }
}

// ---------------------------------------------------------------------------
// Direct executor (in-process, for the platform automations source)
// ---------------------------------------------------------------------------

/**
 * Execute a single automation run by calling the task function directly.
 * No HTTP, no auth token — pure function call within the same process.
 *
 * @param taskFn      Direct reference to runtime.executeTask() or equivalent.
 * @param getContext  Returns the workspace/identity context for the run. Called
 *                    per-execution so it can read current state. The `trigger`
 *                    tells it whether to act as the automation's owner
 *                    (`scheduled`) or the current request's user (`manual`).
 */
export function createDirectExecutor(
  taskFn: TaskFn,
  getContext: (
    automation: Automation | undefined,
    trigger: AutomationRunTrigger,
  ) => ExecutorContext,
) {
  return async function executeDirect(
    automation: Automation,
    externalSignal?: AbortSignal,
    trigger: AutomationRunTrigger = "scheduled",
  ): Promise<AutomationRun> {
    const startedAt = new Date().toISOString();
    const timeoutMs = automation.maxRunDurationMs ?? DEFAULT_TIMEOUT_MS;
    const ctx = getContext(automation, trigger);

    // Combined cancellation: a single controller aborts when EITHER the
    // scheduler's external signal fires (manual cancel, scheduler stop)
    // OR the per-run timeout elapses. The combined signal goes into
    // taskFn → runtime.executeTask → engine.run → every tool call, so an
    // abort actually cancels in-flight LLM/tool work instead of
    // orphaning it the way the old `Promise.race` pattern did.
    //
    // Production bug this fixes: `morning-brief-6am-pt` runs took
    // 6–7 minutes while the 5-minute Promise.race rejected at the
    // 5-minute mark, returning to dispatchRun. The task kept running,
    // finished cleanly 1–2 minutes later, wrote a complete conversation
    // to disk — and the result was discarded. The agent saw a "timeout"
    // run record with `iterations: 0, toolCalls: 0` despite the agent
    // doing all the work.
    const runController = new AbortController();
    let timedOut = false;
    let externallyAborted = false;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      runController.abort();
    }, timeoutMs);

    let onExternalAbort: (() => void) | undefined;
    if (externalSignal) {
      if (externalSignal.aborted) {
        externallyAborted = true;
        runController.abort(externalSignal.reason);
      } else {
        onExternalAbort = () => {
          externallyAborted = true;
          runController.abort(externalSignal.reason);
        };
        externalSignal.addEventListener("abort", onExternalAbort, { once: true });
      }
    }

    try {
      const data = await taskFn({
        ...buildRequest(automation, ctx),
        signal: runController.signal,
      });
      const run = mapResultToRun(automation, startedAt, data);
      // An aborted run comes back as a normal result (stopReason "aborted")
      // carrying the partial usage accumulated before the abort — see
      // runtime.executeTask. The task layer can't know WHY it was aborted, so
      // classify it here from our own cancellation flags: external cancel wins
      // over the timeout for the same reason it does in the throw path below.
      // The run keeps its real inputTokens/outputTokens/toolCalls/iterations
      // and conversationId instead of the 0/0/0/0 a synthesized record carries.
      if (data.stopReason === "aborted") {
        if (externallyAborted) {
          run.status = "cancelled";
          run.error = "Cancelled by user";
          run.transient = false;
        } else {
          run.status = "timeout";
          run.error = `Automation ${automation.id} timed out after ${Math.round(timeoutMs / 1000)}s`;
          run.transient = isTransientError(run.error);
        }
        // "aborted" is not part of AutomationRun's stopReason union; the status
        // field carries the operational outcome. Record the engine's stop as
        // "other" (no natural completion) to keep the persisted record valid.
        run.stopReason = "other";
        // Match the synthesized-record path (`Scheduler.dispatchRun`) so the two
        // ways a run can end up timeout/cancelled carry identical metadata. The
        // field is currently write-only; setting it keeps the paths from drifting
        // if a future reader (e.g. retry policy) starts consuming it.
      }
      return run;
    } catch (err) {
      // Reaching here now means a genuine non-abort failure, OR an abort that
      // still surfaced as a throw (defensive: a real process kill, or any path
      // that bypasses executeTask's contract). Preserve the canonical
      // "timed out after Ns" wording so `Scheduler.dispatchRun` classifies it
      // as `timeout`. If BOTH the external abort AND the timeout fire (narrow
      // race when taskFn takes a beat to honor cancel near the timeout
      // boundary), external-cancel wins — the operator-meaningful cause is
      // "I cancelled", not "the clock ran out at the same moment". Drift here
      // would silently restamp a cancel as a timeout in the run record.
      if (timedOut && !externallyAborted) {
        throw new Error(
          `Automation ${automation.id} timed out after ${Math.round(timeoutMs / 1000)}s`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timeoutTimer);
      if (onExternalAbort) externalSignal?.removeEventListener("abort", onExternalAbort);
    }
  };
}
