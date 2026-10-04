import { effectiveRunLimits } from "../../config/tasks.ts";
import { textContent } from "../../engine/content-helpers.ts";
import type { EventSink } from "../../engine/types.ts";
import { log } from "../../observability/log.ts";
import { getRequestContext } from "../../runtime/request-context.ts";
import type { Runtime } from "../../runtime/runtime.ts";
import type { TaskRequest } from "../../runtime/types.ts";
import { isTaskForbiddenIdentityTool } from "../../tools/identity-sources.ts";
import { defineInProcessApp, type InProcessTool } from "../../tools/in-process-app.ts";
import type { McpSource } from "../../tools/mcp-source.ts";
import { TaskEventTrigger } from "./event-trigger.ts";
import { createDirectExecutor, type ExecutorContext } from "./executor.ts";
import { migrateTaskStorage } from "./migrate-storage.ts";
import { countsAsEventFire, isOpenRun, Scheduler } from "./scheduler.ts";
import { TOOL_SCHEMAS } from "./schemas.ts";
import {
  handleCancel,
  handleCreate,
  handleDelete,
  handleList,
  handleRun,
  handleRunResult,
  handleRuns,
  handleStatus,
  handleUpdate,
  type ToolContext,
} from "./server.ts";
import {
  deleteTaskDefinition,
  loadOwnerTasks,
  loadTask,
  readAllRuns,
  readIdempotencyKey,
  readRunResult,
  readRuns,
  readRunsPage,
  readRunTicket,
  saveTask,
} from "./store.ts";
import { createTaskRunSource } from "./task-source.ts";
import type { RunTicket, Task } from "./types.ts";
import { TASKS_PANEL_HTML } from "./ui-resource.ts";

/**
 * Resolve WHO a task run acts as: the task's owner, focused on the
 * workspace the task lives in, whatever woke the run.
 *
 * A manual run (Run now) is the scheduled run, run now: the same workspace, the
 * same owner, and the same authority. The identity is `{ id: ownerId }` and no
 * more, with no org role, so a test run gets the tools, and passes the
 * permission checks inside them, exactly as its scheduled run will. A test
 * that passed on an admin's permissions would fail on schedule.
 *
 * The ambient request context is never read. The scheduler arms its timer
 * detached (`runDetached`), and an event run starts from the notifications
 * poller's tick, so an inherited context would otherwise run one tenant's
 * task in another tenant's workspace.
 */
export function resolveExecutorContext(task: Task): ExecutorContext {
  return {
    workspaceId: task.workspaceId ?? undefined,
    identity: task.ownerId ? { id: task.ownerId } : undefined,
  };
}

/** The timezone a schedule or budget window uses when it names none. */
const FALLBACK_TIMEZONE = "Pacific/Honolulu";

/**
 * The instance default timezone, from `NB_TIMEZONE`, checked once here.
 *
 * An unknown name would make every budget-window and next-run computation
 * throw (`Intl` refuses it), and a throw while recording a run leaves the run
 * unrecorded and the task due, so it re-runs back to back. Checking at
 * the one place the value enters means neither path has to guard for it.
 */
export function resolveDefaultTimezone(raw: string | undefined): string {
  if (!raw) return FALLBACK_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: raw });
    return raw;
  } catch {
    log.warn("[tasks] NB_TIMEZONE is not a known timezone; using the fallback", {
      value: raw,
      fallback: FALLBACK_TIMEZONE,
    });
    return FALLBACK_TIMEZONE;
  }
}

/** Reconcile a task map against the owner's on-disk store: write each (stamping its workspace + owner binding) and drop definitions no longer in the map. */
function saveOwnerTasks(
  workDir: string,
  wsId: string,
  owner: string,
  map: Map<string, Task>,
): void {
  const onDisk = loadOwnerTasks(workDir, wsId, owner);
  for (const auto of map.values()) {
    // Stamp the binding so a scheduled run resolves the same workspace + owner.
    if (!auto.workspaceId) auto.workspaceId = wsId;
    if (!auto.ownerId) auto.ownerId = owner;
    saveTask(workDir, wsId, owner, auto);
  }
  for (const id of onDisk.keys()) {
    // Definition-only removal — a deleted task's run history (audit
    // trail) is preserved (`deleteTask` is the hard-purge variant).
    if (!map.has(id)) deleteTaskDefinition(workDir, wsId, owner, id);
  }
}

/**
 * Create the "tasks" platform source — an in-process MCP server.
 *
 * Tools: create, update, delete, list, status, runs, run
 * Resources: ui://tasks/panel (React SPA)
 * Placements: sidebar tasks link at priority 3
 *
 * Delegates to the existing store, scheduler, and executor modules.
 * The scheduler is started on creation and stopped via source.stop().
 */
export async function createTasksSource(
  runtime: Runtime,
  eventSink: EventSink,
): Promise<McpSource> {
  const workDir = runtime.getWorkDir();
  // Storage written under the old `automations/` folder moves to `tasks/`
  // before anything reads it, the scheduler included.
  migrateTaskStorage(workDir);
  const defaultTimezone = resolveDefaultTimezone(process.env.NB_TIMEZONE);
  const tasksConfig = runtime.getTasksConfig();
  // The chat default is read per run: an admin can change it at runtime.
  const runLimitsOf = (task: Task) =>
    effectiveRunLimits(task, tasksConfig, runtime.getMaxIterations());

  // Direct executor: calls runtime.executeTask() in-process — the unattended
  // sibling of chat() that frames the agent as producing a deliverable, not a
  // conversation turn. `resolveExecutorContext` resolves WHO each run acts as.
  const executor = createDirectExecutor(
    (req) => runtime.executeTask(req as TaskRequest),
    resolveExecutorContext,
    runLimitsOf,
  );
  const scheduler = new Scheduler(executor, {
    workDir,
    defaultTimezone,
    // The runtime's run admission: task runs share its slots and queue
    // with every other unattended run.
    admission: runtime.getRunAdmission(),
    onRunRecorded: (owner) => runtime.announceIdentitySourceChange("tasks", owner),
  });
  scheduler.start();

  // A workspace delete has to disarm what this scheduler holds for that
  // workspace before the subtree moves. The runtime cannot import the
  // scheduler, so it is handed over here.
  runtime.registerTaskQuiescer(scheduler);

  // The event trigger: the tasks end of the path from a routed
  // notification to an agent run. It reads and writes through the same store
  // and scheduler the tools do — there is no second copy of a task's
  // state anywhere in it — and the runtime holds the reference so the
  // notifications source can reach it without either source importing the
  // other.
  const eventTrigger = new TaskEventTrigger({
    task: (wsId, owner, id) => loadTask(workDir, wsId, owner, id) ?? undefined,
    eventRunsSince: (wsId, owner, id, since) =>
      readRuns(workDir, wsId, owner, id, { since: new Date(since).toISOString() }).filter(
        countsAsEventFire,
      ).length,
    run: (wsId, owner, id, input) => scheduler.runFromEvent(wsId, owner, id, input),
    disable: (wsId, owner, id, reason) => {
      const auto = loadTask(workDir, wsId, owner, id);
      if (!auto) return;
      auto.enabled = false;
      auto.disabledAt = new Date().toISOString();
      auto.disabledReason = reason;
      auto.updatedAt = auto.disabledAt;
      saveTask(workDir, wsId, owner, auto);
      runtime.announceIdentitySourceChange("tasks", owner);
      scheduler.reload();
    },
  });
  runtime.registerTaskEventTrigger(eventTrigger);

  /**
   * A requested run's ticket. One that says the run is open while this
   * process carries no such run was left by a process that stopped before the
   * run ended, so it is settled (recorded as not finished) on the way out:
   * every reader sees the run's real outcome, and a task handle never polls a
   * run nothing will finish.
   */
  function currentTicket(wsId: string, owner: string, runId: string): RunTicket | null {
    const ticket = readRunTicket(workDir, wsId, owner, runId);
    if (!ticket || !isOpenRun(ticket.run) || scheduler.isRunOpen(runId)) return ticket;
    return scheduler.settleLostRun(wsId, owner, ticket);
  }

  /**
   * The caller's owner id. Tasks are workspace-owned with the owner as a
   * privacy sub-partition: the tool path carries the caller's identity in the
   * request context; internal callers (CLI, connector lifecycle) resolve to the dev
   * identity in dev. Mirrors files' owner resolution so a task's store and
   * its scheduled run agree.
   */
  function ownerId(): string {
    return runtime.resolveRequestUserId(runtime.getCurrentIdentity() ?? undefined);
  }

  /**
   * Build a workspace-scoped ToolContext for per-request use. Tasks are
   * workspace-owned: the store lives at `workspaces/<wsId>/tasks/<ownerId>/`,
   * so this needs both the owner (the authenticated identity) and the
   * workspace, which rides `RequestContext.workspaceId` — the same mechanism
   * `files` uses. No workspace in scope ⇒ deny rather than guess a workspace.
   */
  function getToolContext(): ToolContext {
    const owner = ownerId();
    const wsId = getRequestContext()?.workspaceId;
    if (!wsId) {
      throw new Error("tasks: no workspace in scope (tasks are workspace-owned)");
    }
    return {
      // The collection closures the domain + lifecycle depend on, backed by the
      // per-task store. `definitions` reads every `*.json` in the owner
      // dir; `save` reconciles the map against disk (write each, delete removed).
      definitions: () => loadOwnerTasks(workDir, wsId, owner),
      save: (map) => {
        saveOwnerTasks(workDir, wsId, owner, map);
        runtime.announceIdentitySourceChange("tasks", owner);
      },
      reloadScheduler: () => scheduler.reload(),
      runNow: (id, requested) => scheduler.requestRunNow(wsId, owner, id, requested),
      readRunTicket: (runId) => currentTicket(wsId, owner, runId),
      findRunByKey: (id, key) => {
        const runId = readIdempotencyKey(workDir, wsId, owner, id, key);
        return runId ? currentTicket(wsId, owner, runId) : null;
      },
      queuePosition: (id) => {
        const index = scheduler.getQueuedRunIds().indexOf(`${wsId}/${owner}/${id}`);
        return index >= 0 ? index + 1 : null;
      },
      cancelRun: (id) => scheduler.cancelRun(wsId, owner, id),
      readRuns: (id, opts) => readRuns(workDir, wsId, owner, id, opts),
      readRunsPage: (id, opts) => readRunsPage(workDir, wsId, owner, id, opts),
      readAllRuns: (opts) => readAllRuns(workDir, wsId, owner, opts),
      readRunResult: (id, runId) => readRunResult(workDir, wsId, owner, id, runId),
      defaultTimezone,
      runLimitsOf,
      defaultModel: runtime.getDefaultModel(),
      currentUserId: owner,
      currentWorkspaceId: wsId,
    };
  }

  // Expose a workspace-scoped domain context to internal callers (CLI,
  // lifecycle). The ToolContext is a superset; we expose only the four
  // fields the domain needs. See src/platform/AGENTS.md § 1.4 for
  // why internal callers don't go through the LLM-facing tool.
  runtime.registerTasksContext(() => {
    const tc = getToolContext();
    return {
      definitions: tc.definitions,
      save: tc.save,
      reloadScheduler: tc.reloadScheduler,
      defaultTimezone: tc.defaultTimezone,
    };
  });

  /** Why a tasks tool is refused inside an unattended run, or null when it is not. */
  function unattendedRefusal(name: string): string | null {
    if (!getRequestContext()?.unattended || !isTaskForbiddenIdentityTool(`tasks__${name}`)) {
      return null;
    }
    return (
      `Tool "tasks__${name}" is not available inside an unattended ` +
      "task run. A task cannot create, modify, delete, or trigger " +
      "tasks from within its own run. Manage tasks from an interactive session."
    );
  }

  // The task surface `/mcp` drives for `tasks__run` on the 2026-07-28
  // leg (the tasks extension). It reads and writes through the same store and
  // scheduler the tools do.
  runtime.registerIdentityTaskSource(
    createTaskRunSource({
      toolContext: getToolContext,
      readTicket: currentTicket,
      readResult: (wsId, owner, id, runId) => readRunResult(workDir, wsId, owner, id, runId),
      runEnded: (runId) => scheduler.runEnded(runId),
      cancelRun: (wsId, owner, runId) => scheduler.cancelRunById(wsId, owner, runId),
      unattendedRefusal: () => unattendedRefusal("run"),
    }),
  );

  /** Shared error handler — catches, formats, returns isError result. */
  function withErrorHandling(
    fn: (input: Record<string, unknown>) => Promise<object> | object,
  ): (
    input: Record<string, unknown>,
  ) => Promise<{ content: ReturnType<typeof textContent>; isError: boolean }> {
    return async (input) => {
      try {
        const result = await fn(input);
        return {
          content: textContent(JSON.stringify(result, null, 2)),
          isError: false,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[tasks] Tool error: ${message}\n`);
        return {
          content: textContent(JSON.stringify({ error: message })),
          isError: true,
        };
      }
    };
  }

  const tools: InProcessTool[] = TOOL_SCHEMAS.map((schema) => ({
    ...schema,
    handler: withErrorHandling((input) => {
      // Unattended-run wall. A task must not reach the
      // task-authoring surface (create/update/delete/run, and any authoring
      // tool added later — the allowlist in `isTaskForbiddenIdentityTool` fails
      // closed). Enforced HERE, at the source, because it is the single dispatch
      // point every caller funnels through. `unattended` rides the ambient
      // request context (set by `executeTask`, preserved across the per-call
      // restamp), so this does not depend on which router dispatched the call,
      // or on the tool having been surfaced to the model.
      const refusal = unattendedRefusal(schema.name);
      if (refusal) throw new Error(refusal);
      const ctx = getToolContext();
      switch (schema.name) {
        case "create":
          return handleCreate(input, ctx);
        case "update":
          return handleUpdate(input, ctx);
        case "delete":
          return handleDelete(input, ctx);
        case "list":
          return handleList(input, ctx);
        case "status":
          return handleStatus(input, ctx);
        case "runs":
          return handleRuns(input, ctx);
        case "run_result":
          return handleRunResult(input, ctx);
        case "run":
          return handleRun(input, ctx);
        case "cancel":
          return handleCancel(input, ctx);
        default:
          throw new Error(`Unknown tool: ${schema.name}`);
      }
    }),
  }));

  const resources = new Map([["ui://tasks/panel", TASKS_PANEL_HTML]]);

  const source = defineInProcessApp(
    {
      name: "tasks",
      version: "1.0.0",
      tools,
      resources,
      placements: [
        {
          slot: "sidebar",
          resourceUri: "ui://tasks/panel",
          route: "@nimblebraininc/tasks",
          label: "Tasks",
          icon: "clock",
          priority: 3,
        },
      ],
    },
    eventSink,
  );

  // The scheduler is owned by this factory, not the MCP server. Wrap stop()
  // so workspace teardown — and `Runtime.shutdown()` — also stops the timer
  // loop. (McpSource never crashes for in-process sources, but explicit
  // teardown is still required for clean process exit in tests.)
  //
  // try/finally so the in-process MCP transport always closes, even if
  // `scheduler.stop()` ever grows a code path that throws. Today scheduler
  // stop is just a `clearInterval` and is benign; the asymmetry between
  // "scheduler error" and "leaked transport" is the reason for the guard.
  const originalStop = source.stop.bind(source);
  source.stop = async () => {
    try {
      eventTrigger.stop();
      scheduler.stop();
    } finally {
      await originalStop();
    }
  };

  return source;
}
