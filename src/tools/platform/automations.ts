import {
  createDirectExecutor,
  type ExecutorContext,
} from "../../bundles/automations/src/executor.ts";
import { type AutomationRunTrigger, Scheduler } from "../../bundles/automations/src/scheduler.ts";
import { TOOL_SCHEMAS } from "../../bundles/automations/src/schemas.ts";
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
} from "../../bundles/automations/src/server.ts";
import {
  deleteAutomationDefinition,
  loadOwnerAutomations,
  readAllRuns,
  readRunResult,
  readRuns,
  saveAutomation,
} from "../../bundles/automations/src/store.ts";
import type { Automation } from "../../bundles/automations/src/types.ts";
import { textContent } from "../../engine/content-helpers.ts";
import type { EventSink } from "../../engine/types.ts";
import { getRequestContext, type RequestContext } from "../../runtime/request-context.ts";
import type { Runtime } from "../../runtime/runtime.ts";
import type { TaskRequest } from "../../runtime/types.ts";
import { defineInProcessApp, type InProcessTool } from "../in-process-app.ts";
import type { McpSource } from "../mcp-source.ts";
import { AUTOMATIONS_PANEL_HTML } from "../platform-resources/automations/panel.ts";

/**
 * Resolve WHO an automation run acts as, from the run's trigger and the ambient
 * request context. Pure (no ALS read) so the isolation contract is unit-testable
 * without a live AsyncLocalStorage scope — `getExecutorContext` is the thin
 * wrapper that supplies `getRequestContext()`.
 *
 * - `manual`: the clicking user's request context wins (falling back to the
 *   automation's owner/provenance), because a test-button run is dispatched
 *   synchronously inside that user's genuine context.
 * - everything else (`scheduled`, and any future/unknown value): act as the
 *   automation's owner, focused on its provenance workspace, with the ambient
 *   context IGNORED — a scheduled run can inherit a stale timer context (see
 *   `getExecutorContext`) that would otherwise run one tenant's automation in
 *   another tenant's workspace.
 *
 * Reading ambient context is **fail-closed**: it requires an explicit `manual`
 * opt-in. Anything else — including `undefined` from an untyped/test caller, or
 * a trigger added later — falls through to the isolated owner/provenance path,
 * so a new dispatch path that forgets to opt in can never leak another tenant's
 * context.
 */
export function resolveExecutorContext(
  automation: Automation | undefined,
  trigger: AutomationRunTrigger,
  reqCtx: RequestContext | undefined,
): ExecutorContext {
  if (trigger === "manual") {
    return {
      workspaceId:
        (reqCtx?.scope.kind === "workspace" ? reqCtx.scope.workspaceId : undefined) ??
        automation?.workspaceId ??
        undefined,
      identity: reqCtx?.identity ?? (automation?.ownerId ? { id: automation.ownerId } : undefined),
    };
  }
  return {
    workspaceId: automation?.workspaceId ?? undefined,
    identity: automation?.ownerId ? { id: automation.ownerId } : undefined,
  };
}

/**
 * Create the "automations" platform source — an in-process MCP server.
 * Migrated from the former standalone MCP server at
 * src/bundles/automations/src/server.ts.
 *
 * Tools: create, update, delete, list, status, runs, run
 * Resources: ui://automations/panel (React SPA)
 * Placements: sidebar automations link at priority 3
 *
 * Delegates to the existing store, scheduler, and executor modules.
 * The scheduler is started on creation and stopped via source.stop().
 */
export async function createAutomationsSource(
  runtime: Runtime,
  eventSink: EventSink,
): Promise<McpSource> {
  const workDir = runtime.getWorkDir();
  const defaultTimezone = process.env.NB_TIMEZONE ?? "Pacific/Honolulu";

  // Direct executor: calls runtime.executeTask() in-process — the unattended
  // sibling of chat() that frames the agent as producing a deliverable, not a
  // conversation turn. `getExecutorContext` resolves WHO each run acts as; the
  // ALS read is isolated here so the decision logic stays pure and testable in
  // `resolveExecutorContext`. A `scheduled` run ignores the ambient context
  // because the timer can carry a stale one (see `resolveExecutorContext`).
  const getExecutorContext = (
    automation: Automation | undefined,
    trigger: AutomationRunTrigger,
  ): ExecutorContext => resolveExecutorContext(automation, trigger, getRequestContext());
  const executor = createDirectExecutor(
    (req) => runtime.executeTask(req as TaskRequest),
    getExecutorContext,
  );
  const scheduler = new Scheduler(executor, { workDir, defaultTimezone });
  scheduler.start();

  /**
   * The caller's owner id. Automations are workspace-owned with the owner as a
   * privacy sub-partition: the tool path carries the caller's identity in the
   * request context; internal callers (CLI, bundle lifecycle) resolve to the dev
   * identity in dev. Mirrors files' owner resolution so an automation's store and
   * its scheduled run agree.
   */
  function ownerId(): string {
    return runtime.resolveRequestUserId(runtime.getCurrentIdentity() ?? undefined);
  }

  /**
   * Build a workspace-scoped ToolContext for per-request use. Automations are
   * workspace-owned: the store lives at `workspaces/<wsId>/automations/<ownerId>/`,
   * so this needs both the owner (the authenticated identity) and the FOCUSED
   * workspace. The focused workspace rides `RequestContext.fileWorkspaceId` (set
   * on both doors), the same mechanism `files` uses — `scope.workspaceId` on the
   * identity door is the personal/session workspace, not the focus. No workspace
   * in scope (e.g. an external `/mcp` call with no header) ⇒ deny rather than
   * guess a workspace.
   */
  function getToolContext(): ToolContext {
    const owner = ownerId();
    const wsId = getRequestContext()?.fileWorkspaceId;
    if (!wsId) {
      throw new Error("automations: no workspace in scope (automations are workspace-owned)");
    }
    return {
      // The collection closures the domain + lifecycle depend on, backed by the
      // per-automation store. `definitions` reads every `*.json` in the owner
      // dir; `save` reconciles the map against disk (write each, delete removed).
      definitions: () => loadOwnerAutomations(workDir, wsId, owner),
      save: (map) => {
        const onDisk = loadOwnerAutomations(workDir, wsId, owner);
        for (const auto of map.values()) {
          // Stamp the binding so a scheduled run resolves the same workspace + owner.
          if (!auto.workspaceId) auto.workspaceId = wsId;
          if (!auto.ownerId) auto.ownerId = owner;
          saveAutomation(workDir, wsId, owner, auto);
        }
        for (const id of onDisk.keys()) {
          // Definition-only removal — a deleted automation's run history (audit
          // trail) is preserved (`deleteAutomation` is the hard-purge variant).
          if (!map.has(id)) deleteAutomationDefinition(workDir, wsId, owner, id);
        }
      },
      reloadScheduler: () => scheduler.reload(),
      runNow: (id) => scheduler.runNow(wsId, owner, id),
      cancelRun: (id) => scheduler.cancelRun(wsId, owner, id),
      readRuns: (id, opts) => readRuns(workDir, wsId, owner, id, opts),
      readAllRuns: (opts) => readAllRuns(workDir, wsId, owner, opts),
      readRunResult: (id, runId) => readRunResult(workDir, wsId, owner, id, runId),
      defaultTimezone,
      defaultModel: runtime.getDefaultModel(),
      currentUserId: owner,
      currentWorkspaceId: wsId,
    };
  }

  // Expose a workspace-scoped domain context to internal callers (CLI,
  // lifecycle). The ToolContext is a superset; we expose only the four
  // fields the domain needs. See src/tools/platform/CLAUDE.md § 1.4 for
  // why internal callers don't go through the LLM-facing tool.
  runtime.registerAutomationsContext(() => {
    const tc = getToolContext();
    return {
      definitions: tc.definitions,
      save: tc.save,
      reloadScheduler: tc.reloadScheduler,
      defaultTimezone: tc.defaultTimezone,
    };
  });

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
        process.stderr.write(`[automations] Tool error: ${message}\n`);
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

  const resources = new Map([["ui://automations/panel", AUTOMATIONS_PANEL_HTML]]);

  const source = defineInProcessApp(
    {
      name: "automations",
      version: "1.0.0",
      tools,
      resources,
      placements: [
        {
          slot: "sidebar",
          resourceUri: "ui://automations/panel",
          route: "@nimblebraininc/automations",
          label: "Automations",
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
      scheduler.stop();
    } finally {
      await originalStop();
    }
  };

  return source;
}
