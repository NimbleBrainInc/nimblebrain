import { textContent } from "./content-helpers.ts";
import type { ContentBlock, EventSink, TaskClientPort, ToolResult } from "./types.ts";

/**
 * MCP Tasks client support.
 *
 * When an MCP server returns a CreateTaskResult instead of an immediate tool
 * result, this module handles detection, polling, progress events, and
 * cancellation. See PRODUCT_SPEC.md §13 for the full design.
 */

/** Default poll interval when the server doesn't specify one. */
const DEFAULT_POLL_INTERVAL_MS = 5000;

/** Terminal task states (task will never change after reaching one). */
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);

/** Shape of a task object from the MCP protocol. */
export interface McpTask {
  taskId: string;
  status: "working" | "input_required" | "completed" | "failed" | "cancelled";
  ttl: number | null;
  createdAt: string;
  lastUpdatedAt: string;
  pollInterval?: number;
  statusMessage?: string;
}

/** Shape of a CreateTaskResult from the MCP protocol. */
export interface McpCreateTaskResult {
  task: McpTask;
  _meta?: Record<string, unknown>;
}

/** Detect if a raw tool result from MCP is actually a CreateTaskResult. */
export function isCreateTaskResult(result: unknown): result is McpCreateTaskResult {
  if (result === null || typeof result !== "object") return false;
  const obj = result as Record<string, unknown>;
  if (!obj.task || typeof obj.task !== "object") return false;
  const task = obj.task as Record<string, unknown>;
  return typeof task.taskId === "string" && typeof task.status === "string";
}

/** Check whether a task status is terminal. */
export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATES.has(status);
}

/** Extract the immediate-response string from _meta, if present. */
export function getImmediateResponse(result: McpCreateTaskResult): string | undefined {
  const meta = result._meta;
  if (!meta) return undefined;
  const val = meta["io.modelcontextprotocol/model-immediate-response"];
  return typeof val === "string" ? val : undefined;
}

/** Options for the task polling loop. */
export interface PollTaskOptions {
  runId: string;
  toolCallId: string;
  events: EventSink;
  /** AbortSignal for cancellation. When aborted, sends tasks/cancel. */
  signal?: AbortSignal;
}

/**
 * Tracks active tasks for a single engine run so they can be cancelled
 * on abort.
 */
export class ActiveTaskTracker {
  private readonly tasks = new Map<string, { client: TaskClientPort; cancel: AbortController }>();

  /** Register a task. Returns an AbortController to cancel just this task. */
  register(taskId: string, client: TaskClientPort): AbortController {
    const controller = new AbortController();
    this.tasks.set(taskId, { client, cancel: controller });
    return controller;
  }

  /** Unregister a completed/failed task. */
  unregister(taskId: string): void {
    this.tasks.delete(taskId);
  }

  /** Cancel all active tasks. Best-effort — errors are swallowed. */
  async cancelAll(): Promise<void> {
    const entries = [...this.tasks.entries()];
    this.tasks.clear();
    await Promise.allSettled(
      entries.map(async ([taskId, { client, cancel }]) => {
        cancel.abort();
        try {
          await client.cancelTask(taskId);
        } catch {
          // best effort
        }
      }),
    );
  }

  /** Number of currently active tasks. */
  get size(): number {
    return this.tasks.size;
  }
}

/**
 * Poll an MCP task until it reaches a terminal state.
 *
 * Emits `tool.progress` events during polling with task status information.
 * Returns a ToolResult (our engine's format) once the task completes/fails/cancels.
 */
export async function pollTask(
  client: TaskClientPort,
  task: McpTask,
  opts: PollTaskOptions,
): Promise<ToolResult> {
  const { runId, toolCallId, events, signal } = opts;
  let current = task;

  while (!isTerminalStatus(current.status)) {
    // Check for abort
    if (signal?.aborted) {
      try {
        await client.cancelTask(current.taskId);
      } catch {
        // best effort
      }
      return { content: textContent("Task was cancelled"), isError: true };
    }

    // Emit progress
    events.emit({
      type: "tool.progress",
      data: {
        runId,
        toolCallId,
        taskId: current.taskId,
        status: current.status,
        message: current.statusMessage,
      },
    });

    // Sleep for the server-provided interval, falling back to default
    const interval = current.pollInterval ?? DEFAULT_POLL_INTERVAL_MS;
    await sleep(interval, signal);

    // Check abort again after sleep
    if (signal?.aborted) {
      try {
        await client.cancelTask(current.taskId);
      } catch {
        // best effort
      }
      return { content: textContent("Task was cancelled"), isError: true };
    }

    // Poll for updated status
    const updated = await client.getTask(current.taskId);
    current = {
      taskId: updated.taskId,
      status: updated.status as McpTask["status"],
      ttl: updated.ttl,
      createdAt: updated.createdAt,
      lastUpdatedAt: updated.lastUpdatedAt,
      pollInterval: updated.pollInterval,
      statusMessage: updated.statusMessage,
    };

    // Handle input_required — emit event, continue polling (v1 best-effort)
    if (current.status === "input_required") {
      events.emit({
        type: "task.input_required",
        data: {
          runId,
          toolCallId,
          taskId: current.taskId,
          message: current.statusMessage,
        },
      });
    }
  }

  // Terminal state reached
  if (current.status === "completed") {
    const payload = await client.getTaskResult(current.taskId);
    return mcpResultToToolResult(payload);
  }

  if (current.status === "failed") {
    return {
      content: textContent(current.statusMessage ?? "Task failed"),
      isError: true,
    };
  }

  // cancelled
  return {
    content: textContent(current.statusMessage ?? "Task was cancelled"),
    isError: true,
  };
}

/** Convert an MCP CallToolResult to our internal ToolResult. */
function mcpResultToToolResult(result: {
  content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
}): ToolResult {
  const blocks: ContentBlock[] = Array.isArray(result.content)
    ? result.content.map((block) => {
        if (block.type === "text" && typeof block.text === "string") {
          return { type: "text" as const, text: block.text };
        }
        if (block.type === "image") {
          return block as ContentBlock;
        }
        // Fallback: serialize unknown block types as text
        return { type: "text" as const, text: JSON.stringify(block) };
      })
    : textContent(JSON.stringify(result.content));
  return { content: blocks, isError: Boolean(result.isError) };
}

/** Sleep that respects an AbortSignal. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
