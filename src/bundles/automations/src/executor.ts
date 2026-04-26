/**
 * Automation executors: run an automation's prompt through the chat engine.
 *
 * Two implementations:
 * - executeDirect: calls runtime.chat() in-process (used by the platform's
 *   in-process automations source)
 * - executeHttp:   calls POST /v1/chat over HTTP (used by standalone MCP server)
 *
 * No retry logic — the scheduler handles backoff.
 */

import type { Automation, AutomationRun } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/** Minimal chat request shape (matches runtime ChatRequest). */
export interface ChatFnRequest {
  message: string;
  model?: string;
  maxIterations?: number;
  maxInputTokens?: number;
  allowedTools?: string[];
  metadata?: Record<string, unknown>;
  /** Workspace scope for this run. Required for workspace-aware tools. */
  workspaceId?: string;
  /** Identity under which this automation runs. */
  identity?: { id: string; name?: string; email?: string; role?: string };
}

/** Minimal chat result shape (matches runtime ChatResult). */
export interface ChatFnResult {
  response: string;
  conversationId: string;
  toolCalls: Array<Record<string, unknown>>;
  inputTokens: number;
  outputTokens: number;
  stopReason: string;
  usage: { iterations: number };
}

/** A function that executes a chat turn. Injected by the caller. */
export type ChatFn = (request: ChatFnRequest) => Promise<ChatFnResult>;

/** Runtime context injected into the executor for workspace/identity scoping. */
export interface ExecutorContext {
  workspaceId?: string;
  identity?: ChatFnRequest["identity"];
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function buildRequest(automation: Automation, ctx?: ExecutorContext): ChatFnRequest {
  const req: ChatFnRequest = {
    message: automation.prompt,
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
  data: ChatFnResult,
): AutomationRun {
  const stopReason = data.stopReason as "complete" | "max_iterations" | "token_budget";
  const status: AutomationRun["status"] =
    stopReason === "max_iterations" || stopReason === "token_budget" ? "timeout" : "success";

  return {
    id: `run_${crypto.randomUUID().slice(0, 12)}`,
    automationId: automation.id,
    startedAt,
    completedAt: new Date().toISOString(),
    status,
    conversationId: data.conversationId,
    inputTokens: data.inputTokens,
    outputTokens: data.outputTokens,
    toolCalls: Array.isArray(data.toolCalls) ? data.toolCalls.length : 0,
    iterations: data.usage?.iterations ?? 0,
    resultPreview: data.response ? data.response.slice(0, 500) : undefined,
    stopReason,
  };
}

// ---------------------------------------------------------------------------
// Direct executor (in-process, for the platform automations source)
// ---------------------------------------------------------------------------

/**
 * Execute a single automation run by calling the chat function directly.
 * No HTTP, no auth token — pure function call within the same process.
 *
 * @param chatFn     Direct reference to runtime.chat() or equivalent.
 * @param getContext  Returns the workspace/identity context for the run.
 *                    Called per-execution so it can read current state.
 */
export function createDirectExecutor(
  chatFn: ChatFn,
  getContext: (automation?: Automation) => ExecutorContext,
) {
  return async function executeDirect(
    automation: Automation,
    signal?: AbortSignal,
  ): Promise<AutomationRun> {
    const startedAt = new Date().toISOString();
    const timeoutMs = automation.maxRunDurationMs ?? DEFAULT_TIMEOUT_MS;
    const ctx = getContext(automation);

    // Race the chat call against a timeout
    const timeoutPromise = new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `Automation ${automation.id} timed out after ${Math.round(timeoutMs / 1000)}s`,
            ),
          ),
        timeoutMs,
      );
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    });

    const data = await Promise.race([chatFn(buildRequest(automation, ctx)), timeoutPromise]);

    return mapResultToRun(automation, startedAt, data);
  };
}

// ---------------------------------------------------------------------------
// HTTP executor (for standalone MCP server process)
// ---------------------------------------------------------------------------

/**
 * Execute a single automation run by calling POST /v1/chat on the host.
 * Used by the standalone MCP server where HTTP is the only path to the runtime.
 */
export async function executeHttp(
  automation: Automation,
  signal?: AbortSignal,
): Promise<AutomationRun> {
  const startedAt = new Date().toISOString();

  const hostUrl = process.env.NB_HOST_URL ?? "http://127.0.0.1:27247";
  const token = process.env.NB_INTERNAL_TOKEN;

  const timeoutMs = automation.maxRunDurationMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  const body = buildRequest(automation);

  let res: Response;
  try {
    res = await fetch(`${hostUrl}/v1/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: combinedSignal,
    });
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new Error(
        `Automation ${automation.id} timed out after ${Math.round(timeoutMs / 1000)}s`,
      );
    }
    const msg = err instanceof Error ? err.message : "Unknown network error";
    throw new Error(`Automation ${automation.id} network error: ${msg}`);
  }

  if (!res.ok) {
    let detail = "";
    try {
      const text = await res.text();
      detail = text ? ` — ${text.slice(0, 200)}` : "";
    } catch {
      // ignore body read failures
    }
    throw new Error(`Automation ${automation.id} HTTP ${res.status}${detail}`);
  }

  const data = (await res.json()) as ChatFnResult;
  return mapResultToRun(automation, startedAt, data);
}
