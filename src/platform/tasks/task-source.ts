/**
 * The tasks source's task surface (`IdentityTaskSource`): how a remote
 * client runs `tasks__run` as a task at `/mcp` (the tasks extension), and how `tasks/get` and `tasks/cancel` read and
 * cancel the run.
 *
 * Over the wire a run is a task, and the task id is the run id (ADR-0045). The
 * run's ticket (`run-tickets/<runId>.json`) is written before the handle is
 * returned and holds the run's current record, so a lookup reads the record on
 * disk: the handle outlives the connection and a restart of the runtime. There
 * is no task table here.
 *
 * Ownership is the path. A ticket lives under the workspace and owner it was
 * started for, and a lookup reads only under the (workspace, identity) the
 * request presents, so another identity's run, another workspace's, and one
 * that does not exist are all the same `TaskNotFoundError`.
 */

import type { Task as McpTask } from "@modelcontextprotocol/server";
import type {
  IdentityTaskResult,
  IdentityTaskSource,
  IdentityTaskStart,
} from "../../tools/identity-task-source.ts";
import {
  TaskAlreadyTerminalError,
  TaskNotFoundError,
  type TaskOwnerContext,
} from "../../tools/types.ts";
import { validateToolInput } from "../../tools/validate-input.ts";
import { TasksRunInput } from "../schemas/tasks.ts";
import { executionOf, labelOf } from "./assessment.ts";
import { isOpenRun } from "./scheduler.ts";
import { prepareRun, type ToolContext } from "./server.ts";
import type { RunTicket, TaskRun, TaskRunResult } from "./types.ts";

/** The source's name: the `<source>` of `tasks__run`, and the task's origin. */
const SOURCE = "tasks";

/** How often a client is asked to poll a working run. */
const POLL_INTERVAL_MS = 5_000;

/** How long `tasks/cancel` waits for a cancelled in-flight run to record its end. */
const CANCEL_SETTLE_MS = 5_000;

/** What the task surface reads and drives. */
export interface TaskRunSourceDeps {
  /** The tool context for the request in scope (its identity and workspace), as the tool uses. */
  toolContext: () => ToolContext;
  /** A requested run's ticket for an owner in a workspace, settled when a stopped process left it open. */
  readTicket: (wsId: string, ownerId: string, runId: string) => RunTicket | null;
  /** A run's result sidecar, when it left one. */
  readResult: (
    wsId: string,
    ownerId: string,
    taskId: string,
    runId: string,
  ) => TaskRunResult | null;
  /** The record of a run this process is carrying, once it ends. */
  runEnded: (runId: string) => Promise<TaskRun> | undefined;
  /** Cancel a run this process is carrying for that owner in that workspace. */
  cancelRun: (wsId: string, ownerId: string, runId: string) => boolean;
  /** Why a call is refused inside an unattended run, or null when it is not in one. */
  unattendedRefusal: () => string | null;
}

/**
 * The task status a run's record maps to, through its execution
 * (`executionOf`):
 *
 *   queued, running        → working
 *   completed, incomplete  → completed (the result carries the deliverable and the record)
 *   failed, skipped        → failed, with the record's reason
 *   cancelled              → cancelled
 */
export function taskStatusOf(run: TaskRun): McpTask["status"] {
  switch (executionOf(run)) {
    case "queued":
    case "running":
      return "working";
    case "completed":
    case "incomplete":
      return "completed";
    case "cancelled":
      return "cancelled";
    default:
      return "failed";
  }
}

/** The run as an MCP task: id, status, and the record's own times. */
export function taskOf(ticket: RunTicket): McpTask {
  const { run } = ticket;
  const status = taskStatusOf(run);
  const statusMessage =
    status === "working"
      ? `${run.status}`
      : status === "completed"
        ? run.status === "success"
          ? undefined
          : `${run.status}${run.error ? `: ${run.error}` : ""}`
        : (run.error ?? run.status);
  return {
    taskId: ticket.runId,
    status,
    ...(statusMessage ? { statusMessage } : {}),
    createdAt: ticket.requestedAt,
    lastUpdatedAt: run.completedAt ?? run.startedAt,
    // Run history is kept indefinitely, so the task never expires.
    ttl: null,
    ...(status === "working" ? { pollInterval: POLL_INTERVAL_MS } : {}),
  };
}

function errorResult(message: string): IdentityTaskResult {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

export function createTaskRunSource(deps: TaskRunSourceDeps): IdentityTaskSource {
  /** The ticket `taskId` names for the presented owner, or `TaskNotFoundError`. */
  function lookup(taskId: string, owner: TaskOwnerContext): RunTicket {
    if (owner.originApp !== undefined && owner.originApp !== SOURCE) {
      throw new TaskNotFoundError(taskId);
    }
    if (!owner.identityId || !owner.workspaceId) throw new TaskNotFoundError(taskId);
    const ticket = deps.readTicket(owner.workspaceId, owner.identityId, taskId);
    if (!ticket) throw new TaskNotFoundError(taskId);
    return ticket;
  }

  /**
   * The ticket once the run has ended, waiting for a run this process carries.
   * A run this process carries is waited for until its assessment is
   * recorded too, so the result carries it.
   */
  async function terminal(taskId: string, owner: TaskOwnerContext): Promise<RunTicket> {
    lookup(taskId, owner);
    await deps.runEnded(taskId)?.catch(() => {});
    return lookup(taskId, owner);
  }

  /** Why a call to start a task is refused before it reaches the run, or null. */
  function refusalOf(toolName: string, args: Record<string, unknown>): string | null {
    if (toolName !== "run") return `"${toolName}" does not run as a task`;
    const unattended = deps.unattendedRefusal();
    if (unattended) return unattended;
    // The same check the inline call gets at the in-process server.
    const validation = validateToolInput(args, TasksRunInput as Record<string, unknown>);
    return validation.valid ? null : `Invalid arguments for "run": ${validation.error}`;
  }

  /** Ask for the run (or find the one its idempotency key started), and its ticket. */
  function requestRun(args: Record<string, unknown>): RunTicket {
    const ctx = deps.toolContext();
    const prepared = prepareRun(args, ctx);
    if (prepared.kind === "existing") return prepared.ticket;
    // The scheduler finishes the run; nothing awaits it here.
    if (prepared.ticket.state !== "refused") prepared.ticket.run.catch(() => {});
    const ticket = ctx.readRunTicket?.(prepared.requested.runId);
    if (!ticket) throw new Error("the run's record could not be read back");
    return ticket;
  }

  return {
    name: SOURCE,

    taskSupport(toolName) {
      return toolName === "run" ? "optional" : undefined;
    },

    async startToolAsTask(toolName, args, _opts): Promise<IdentityTaskStart> {
      const refusal = refusalOf(toolName, args);
      if (refusal) return { result: errorResult(refusal) };
      try {
        return { task: taskOf(requestRun(args)) };
      } catch (err) {
        return { result: errorResult(err instanceof Error ? err.message : String(err)) };
      }
    },

    async getTaskStatus(taskId, { ownerContext }) {
      return taskOf(lookup(taskId, ownerContext));
    },

    async awaitToolTaskResult(taskId, { ownerContext }) {
      const ticket = await terminal(taskId, ownerContext);
      const { run } = ticket;
      const status = taskStatusOf(run);
      if (status === "working") throw new Error(`run ${taskId} has not ended`);
      if (status === "cancelled") throw new Error(run.error ?? "the run was cancelled");
      if (status === "failed") throw new Error(run.error ?? `the run ended ${run.status}`);
      const result = deps.readResult(
        ownerContext.workspaceId,
        ownerContext.identityId ?? "",
        ticket.taskId,
        taskId,
      );
      return {
        content: [{ type: "text", text: result?.output ?? run.resultPreview ?? "" }],
        structuredContent: {
          run: { ...run, execution: executionOf(run), label: labelOf(run) },
          result,
        },
      };
    },

    async cancelTask(taskId, { ownerContext }) {
      const ticket = lookup(taskId, ownerContext);
      if (!isOpenRun(ticket.run)) {
        throw new TaskAlreadyTerminalError(taskId, taskStatusOf(ticket.run));
      }
      const ended = deps.runEnded(taskId);
      deps.cancelRun(ownerContext.workspaceId, ownerContext.identityId ?? "", taskId);
      // A queued run is recorded cancelled before `cancelRun` returns; an
      // in-flight one records its end once the abort reaches it.
      if (ended) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          ended.catch(() => {}),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, CANCEL_SETTLE_MS);
          }),
        ]);
        if (timer !== undefined) clearTimeout(timer);
      }
      return taskOf(lookup(taskId, ownerContext));
    },
  };
}
