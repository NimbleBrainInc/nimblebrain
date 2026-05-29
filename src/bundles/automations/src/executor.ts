/**
 * Automation executor: runs an automation's prompt through the chat engine.
 *
 * `createDirectExecutor` calls `runtime.chat()` in-process — the only path now
 * that automations is an in-process platform source (the former HTTP executor
 * + standalone MCP server were removed). A scheduled run fires as the
 * automation's owner; see `getExecutorContext` in the platform source.
 *
 * No retry logic — the scheduler handles backoff.
 */

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

function mapResultToRun(
  automation: Automation,
  startedAt: string,
  data: TaskFnResult,
): AutomationRun {
  const stopReason = data.stopReason as AutomationRun["stopReason"];
  const status: AutomationRun["status"] = mapStopReasonToStatus(stopReason);

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
 * @param getContext  Returns the workspace/identity context for the run.
 *                    Called per-execution so it can read current state.
 */
export function createDirectExecutor(
  taskFn: TaskFn,
  getContext: (automation?: Automation) => ExecutorContext,
) {
  return async function executeDirect(
    automation: Automation,
    externalSignal?: AbortSignal,
  ): Promise<AutomationRun> {
    const startedAt = new Date().toISOString();
    const timeoutMs = automation.maxRunDurationMs ?? DEFAULT_TIMEOUT_MS;
    const ctx = getContext(automation);

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
      return mapResultToRun(automation, startedAt, data);
    } catch (err) {
      // Preserve the canonical "timed out after Ns" wording so
      // `Scheduler.dispatchRun` classifies this as `timeout`. If
      // BOTH the external abort AND the timeout fire (narrow race
      // when taskFn takes a beat to honor cancel near the timeout
      // boundary), external-cancel wins — the operator-meaningful
      // cause is "I cancelled", not "the clock ran out at the same
      // moment". Drift here would silently restamp a cancel as a
      // timeout in the run record.
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
