import { effectiveRunLimits } from "../../config/tasks.ts";
import { textContent } from "../../engine/content-helpers.ts";
import type { EventSink } from "../../engine/types.ts";
import type { NotificationEnvelope } from "../../notifications/types.ts";
import { log } from "../../observability/log.ts";
import { getRequestContext } from "../../runtime/request-context.ts";
import type { Runtime } from "../../runtime/runtime.ts";
import type { TaskRequest } from "../../runtime/types.ts";
import { coreSkillBody } from "../../skills/loader.ts";
import { isTaskForbiddenIdentityTool } from "../../tools/identity-sources.ts";
import { defineInProcessApp, type InProcessTool } from "../../tools/in-process-app.ts";
import type { McpSource } from "../../tools/mcp-source.ts";
import { unmatchedAllowedTools } from "../../tools/tool-pattern.ts";
import { ledgerCostByTaskRun } from "../../usage/aggregate.ts";
import { splitInnerToolName } from "../../util/tool-name.ts";
import type { TaskWarning } from "../schemas/tasks.ts";
import { BatchDriver, passRateOf } from "./batch.ts";
import { listBatches, readBatchKey } from "./batch-store.ts";
import { handleBatch, handleBatchControl, handleBatches, handleRunBatch } from "./batch-tools.ts";
import { TaskEventTrigger } from "./event-trigger.ts";
import { applyOutputSchema, createDirectExecutor, type ExecutorContext } from "./executor.ts";
import {
  assessRun,
  JUDGE_CALL_TIMEOUT_MS,
  JUDGE_RESULT_MAX_BYTES,
  type JudgePort,
  judgeWarnings,
} from "./judge.ts";
import { countsAsEventFire, isOpenRun, Scheduler } from "./scheduler.ts";
import { TOOL_SCHEMAS } from "./schemas.ts";
import {
  handleAssess,
  handleCancel,
  handleCreate,
  handleDelete,
  handleJudges,
  handleList,
  handleRun,
  handleRunResult,
  handleRuns,
  handleStats,
  handleStatus,
  handleUpcoming,
  handleUpdate,
  runOutputTaskId,
  type ToolContext,
  withWarnings,
} from "./server.ts";
import {
  deleteTaskDefinition,
  findRun,
  loadOwnerTasks,
  loadTask,
  readAllRuns,
  readIdempotencyKey,
  readRunResult,
  readRuns,
  readRunsPage,
  readRunTicket,
  saveTask,
  updateRun,
} from "./store.ts";
import { createTaskRunSource } from "./task-source.ts";
import type { Batch, RunTicket, Task, TaskRun } from "./types.ts";
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
 * How assessment reaches a workspace's judge server: the sources connected in
 * the run's workspace (with their bare tool names, for discovery), and one
 * call through the unattended dispatch door as the task's owner, which applies
 * the wall, the owner's tool policy, a timeout that cancels, and a result cap.
 */
function createJudgePort(runtime: Runtime): JudgePort {
  return {
    sources: async (wsId) => {
      const registry = await runtime.ensureWorkspaceRegistry(wsId);
      return Promise.all(
        registry.getSources().map(async (source) => {
          try {
            const tools = await source.tools();
            return {
              name: source.name,
              toolNames: tools.map((t) => splitInnerToolName(t.name).bareToolName),
            };
          } catch {
            // A source that cannot list its tools offers no judge right now.
            return { name: source.name, toolNames: [], unlisted: true };
          }
        }),
      );
    },
    call: ({ wsId, ownerId, tool, input, reason }) =>
      runtime.dispatchUnattended({
        principalId: ownerId,
        workspaceId: wsId,
        tool,
        input,
        reason,
        timeoutMs: JUDGE_CALL_TIMEOUT_MS,
        maxResultBytes: JUDGE_RESULT_MAX_BYTES,
      }),
  };
}

/**
 * The inbox item for a poor result (ADR-0008). The inbox is workspace-owned
 * with no owner partition, so every member who can read it sees the item,
 * while a task is private to its owner (ADR-0004). So the item is generic: it
 * names no task, no criterion or rule, and nothing of the deliverable, only
 * the run's id and its owner's id. The detail stays on the run, which only the
 * owner can open (`tasks__run_result`, the Tasks panel).
 */
export function poorResultEnvelope(task: Task, run: TaskRun): NotificationEnvelope {
  const body = [
    `The task's owner can read run ${run.id} in Tasks.`,
    run.retryOf ? `It retried run ${run.retryOf}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return {
    eventId: `poor-result:${run.id}`,
    name: "task.run.poor_result",
    timestamp: new Date().toISOString(),
    data: {
      runId: run.id,
      ownerId: task.ownerId ?? null,
      ...(run.retryOf ? { retryOf: run.retryOf } : {}),
    },
    _meta: {
      "ai.nimblebrain/notification": {
        level: "attention",
        title: "A task run had a poor result",
        body,
      },
    },
  };
}

/**
 * The inbox item for a batch that paused on its own: its budget ran out or its
 * stop rule fired. Generic for the same reason as a poor result (see
 * `poorResultEnvelope`): the batch id, its owner's id, why it paused, and its
 * counts, never the task's name, its criteria or stop rule, or any input or
 * deliverable.
 */
export function batchPausedEnvelope(batch: Batch): NotificationEnvelope {
  const reason = batch.pause?.reason ?? "manual";
  const { pass, fail, uncertain } = batch.counts;
  const done = batch.items - batch.counts.pending - batch.counts.queued - batch.counts.running;
  const why =
    reason === "pass_rate"
      ? "its pass rate fell below its stop rule"
      : reason === "budget"
        ? "its budget has too little left for another run"
        : "it was paused";
  return {
    eventId: `batch-paused:${batch.id}:${batch.pause?.at ?? batch.updatedAt}`,
    name: "task.batch.paused",
    timestamp: new Date().toISOString(),
    data: {
      batchId: batch.id,
      ownerId: batch.ownerId,
      reason,
      items: batch.items,
      done,
      pass,
      fail,
      uncertain,
      passRate: passRateOf(batch.counts),
    },
    _meta: {
      "ai.nimblebrain/notification": {
        level: "attention",
        title: "A task batch paused",
        body:
          `Batch ${batch.id} paused because ${why} (${done} of ${batch.items} done: ` +
          `${pass} pass, ${fail} fail, ${uncertain} uncertain). Its owner can resume or ` +
          "cancel it in Tasks.",
      },
    },
  };
}

/** Put a batch's pause in its workspace inbox. Best-effort, like a poor result. */
function notifyBatchPaused(runtime: Runtime, batch: Batch): void {
  try {
    runtime.getNotificationStore(batch.workspaceId).append("tasks", batchPausedEnvelope(batch));
  } catch (err) {
    log.warn("[tasks] could not write a batch notification", {
      batchId: batch.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Put a poor result in the task's workspace inbox, where the owner's views and
 * any route the workspace configured pick it up. Idempotent per run, and
 * best-effort: a refused write is logged and changes nothing about the run.
 */
function notifyPoorResult(runtime: Runtime, task: Task, run: TaskRun): void {
  const wsId = task.workspaceId;
  if (!wsId || !run.assessment) return;
  try {
    runtime.getNotificationStore(wsId).append("tasks", poorResultEnvelope(task, run));
  } catch (err) {
    log.warn("[tasks] could not write a poor-result notification", {
      taskId: task.id,
      runId: run.id,
      error: err instanceof Error ? err.message : String(err),
    });
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
  const judgePort = createJudgePort(runtime);
  const scheduler = new Scheduler(executor, {
    workDir,
    defaultTimezone,
    // The runtime's run admission: task runs share its slots and queue
    // with every other unattended run.
    admission: runtime.getRunAdmission(),
    onRunRecorded: (owner) => runtime.announceIdentitySourceChange("tasks", owner),
    assess: (task, run, result) => assessRun(task, run, result, { port: judgePort }),
    notifyPoorResult: (task, run) => notifyPoorResult(runtime, task, run),
  });
  scheduler.start();

  // Batches: one task run over many inputs, driven here and run through the
  // scheduler, so the door sees ordinary runs naming one more spend account.
  const batchDriver = new BatchDriver({
    workDir,
    scheduler,
    spend: runtime.getSpendBalances(),
    onChange: (owner) => runtime.announceIdentitySourceChange("tasks", owner),
    notifyPaused: (batch) => notifyBatchPaused(runtime, batch),
    // The usage ledger, read once at boot for runs lost in a crash, so what
    // they spent before they could be recorded still counts against the budget.
    ledgerCosts: (batch, runIds) =>
      ledgerCostByTaskRun(
        workDir,
        runIds,
        { from: batch.createdAt.slice(0, 10), to: new Date().toISOString().slice(0, 10) },
        batch.workspaceId,
      ),
  });
  // After the scheduler has loaded the tasks the batches run.
  batchDriver.start();

  // A workspace delete has to disarm what this scheduler and the batch driver
  // hold for that workspace before the subtree moves. The runtime cannot
  // import either, so they are handed over here.
  runtime.registerTaskQuiescer({
    dropWorkspace: (wsId) => {
      batchDriver.dropWorkspace(wsId);
      return scheduler.dropWorkspace(wsId);
    },
  });

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
      cancelRun: (runId) => scheduler.cancelRunById(wsId, owner, runId),
      isAssessing: (runId) => scheduler.isAssessing(runId),
      readRuns: (id, opts) => readRuns(workDir, wsId, owner, id, opts),
      readRunsPage: (id, opts) => readRunsPage(workDir, wsId, owner, id, opts),
      readAllRuns: (opts) => readAllRuns(workDir, wsId, owner, opts),
      readRunResult: (id, runId) => readRunResult(workDir, wsId, owner, id, runId),
      findRun: (id, runId) => findRun(workDir, wsId, owner, id, runId),
      updateRun: (id, runId, update) => {
        const updated = updateRun(workDir, wsId, owner, id, runId, update);
        if (updated) {
          batchDriver.syncRun(wsId, owner, updated);
          runtime.announceIdentitySourceChange("tasks", owner);
        }
        return updated;
      },
      reassessRun: async (task, run) => {
        // The output schema is checked again too, against the task's current
        // one: the record's validity is the schema the run ran under.
        const stored = readRunResult(workDir, wsId, owner, task.id, run.id);
        const checked: TaskRun = { ...run };
        delete checked.outputSchemaValid;
        delete checked.outputSchemaErrors;
        const result = stored ? { ...stored } : null;
        if (result) {
          delete result.structured;
          applyOutputSchema(task, checked, result);
        }
        const assessment = await assessRun(task, checked, result, { port: judgePort });
        const updated = scheduler.recordAssessment(task, run.id, assessment);
        if (updated) batchDriver.syncRun(wsId, owner, updated);
        return updated;
      },
      callerVia: () => (getRequestContext()?.shellCall ? "ui" : "remote"),
      defaultTimezone,
      runLimitsOf,
      defaultModel: runtime.getDefaultModel(),
      currentUserId: owner,
      currentWorkspaceId: wsId,
      batches: {
        create: (spec) => batchDriver.create({ ...spec, wsId, ownerId: owner, createdBy: owner }),
        get: (batchId) => batchDriver.get(wsId, owner, batchId),
        findByKey: (key) => {
          const batchId = readBatchKey(workDir, wsId, owner, key);
          return batchId ? (batchDriver.get(wsId, owner, batchId)?.batch ?? null) : null;
        },
        control: (batchId, action, budgetUsd) =>
          batchDriver.control(wsId, owner, batchId, action, budgetUsd),
        list: () => listBatches(workDir, wsId, owner),
        maxConcurrentRuns: runtime.getRunAdmission().limits.maxConcurrentRuns,
      },
      queueView: () => scheduler.queueView(wsId, owner),
      judgeSources: () => judgePort.sources(wsId),
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
      "task run. A task cannot create, modify, delete, trigger, or assess " +
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

  /** Warn using the same reachable tools and matcher that guard a run. */
  async function allowedToolWarnings(
    task: Task,
    about: "task" | "run" | "batch",
  ): Promise<TaskWarning[]> {
    if (!task.allowedTools?.length || !task.workspaceId || !task.ownerId) return [];
    let tools: Awaited<ReturnType<Runtime["listToolsForWorkspace"]>>;
    try {
      tools = await runtime.listToolsForWorkspace(task.workspaceId, task.ownerId);
    } catch {
      // Tool discovery is advisory here; a failure must not undo the write.
      return [];
    }
    return unmatchedAllowedTools(
      task.allowedTools,
      tools.map((tool) => tool.name),
    ).map((name) => ({
      code: "allowed_tool_unavailable",
      message:
        (about === "task" ? "Saved, but its" : `This ${about}'s`) +
        ` allowedTools entry "${name}" matches no tool currently available to its owner in this workspace. ` +
        "Runs fail until the tool is available or the entry is changed.",
    }));
  }

  /** An answer with warnings about its judge and declared tools. */
  async function withTaskWarnings<T extends { message?: string }>(
    out: T,
    task: Task | undefined,
    about: "task" | "run" | "batch" = "task",
  ): Promise<T> {
    if (!task) return out;
    const [judge, tools] = await Promise.all([
      judgeWarnings(task, judgePort, about),
      allowedToolWarnings(task, about),
    ]);
    return withWarnings(out, [...judge, ...tools]);
  }

  function warnAboutTask<T extends { task: Task; message: string }>(out: T): Promise<T> {
    return withTaskWarnings(out, out.task);
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
          return warnAboutTask(handleCreate(input, ctx));
        case "update":
          return warnAboutTask(handleUpdate(input, ctx));
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
        // Every run and batch is warned about, saved task or inline: a judge
        // disconnected since the task was written fails its runs the same way.
        case "run":
          return handleRun(input, ctx).then((out) =>
            withTaskWarnings(out, ctx.definitions().get(runOutputTaskId(out)), "run"),
          );
        case "run_batch": {
          const out = handleRunBatch(input, ctx);
          return withTaskWarnings(out, ctx.definitions().get(out.batch.taskId), "batch");
        }
        case "batch":
          return handleBatch(input, ctx);
        case "batch_control":
          return handleBatchControl(input, ctx);
        case "batches":
          return handleBatches(input, ctx);
        case "upcoming":
          return handleUpcoming(input, ctx);
        case "stats":
          return handleStats(input, ctx);
        case "judges":
          return handleJudges(input, ctx);
        case "cancel":
          return handleCancel(input, ctx);
        case "assess":
          return handleAssess(input, ctx);
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
      // The task-authoring skill, which chat loads by tool affinity, is what a
      // remote MCP client is told too: one guide, served both ways.
      instructions: coreSkillBody("task-authoring"),
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
      batchDriver.stop();
      scheduler.stop();
    } finally {
      await originalStop();
    }
  };

  return source;
}
