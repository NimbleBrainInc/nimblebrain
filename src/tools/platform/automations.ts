import { join } from "node:path";
import {
  createDirectExecutor,
  type ExecutorContext,
} from "../../bundles/automations/src/executor.ts";
import { Scheduler } from "../../bundles/automations/src/scheduler.ts";
import { TOOL_SCHEMAS } from "../../bundles/automations/src/schemas.ts";
import {
  handleCancel,
  handleCreate,
  handleDelete,
  handleList,
  handleRun,
  handleRuns,
  handleStatus,
  handleUpdate,
  type ToolContext,
} from "../../bundles/automations/src/server.ts";
import {
  detectOrphans,
  loadDefinitions,
  saveDefinitions,
} from "../../bundles/automations/src/store.ts";
import { textContent } from "../../engine/content-helpers.ts";
import type { EventSink } from "../../engine/types.ts";
import { getRequestContext } from "../../runtime/request-context.ts";
import type { Runtime } from "../../runtime/runtime.ts";
import { defineInProcessApp, type InProcessTool } from "../in-process-app.ts";
import type { McpSource } from "../mcp-source.ts";
import { AUTOMATIONS_PANEL_HTML } from "../platform-resources/automations/panel.ts";

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
  const initialWorkDir = runtime.getWorkDir();
  const initialStoreDir = join(initialWorkDir, "automations");
  const defaultTimezone = process.env.NB_TIMEZONE ?? "Pacific/Honolulu";

  // Detect and fix orphaned runs from previous crashes (uses initial dir for startup)
  const orphanCount = detectOrphans(initialStoreDir);
  if (orphanCount > 0) {
    process.stderr.write(`[automations] Fixed ${orphanCount} orphaned run(s)\n`);
  }

  // Create a direct executor that calls runtime.chat() in-process.
  // No HTTP round-trip, no auth token needed — the executor runs in the same
  // process as the runtime. The standalone MCP server (server.ts) uses the
  // HTTP executor instead.
  //
  // getContext is called per-execution to resolve the workspace/identity.
  // For user-triggered runs (test run button), it reads from the current
  // request context (AsyncLocalStorage). For scheduled runs (timer), there's
  // no request context, so it falls back to the runtime's current workspace.
  function getExecutorContext(
    automation?: import("../../bundles/automations/src/types.ts").Automation,
  ): ExecutorContext {
    const reqCtx = getRequestContext();
    return {
      workspaceId:
        reqCtx?.workspaceId ??
        automation?.workspaceId ??
        runtime.getCurrentWorkspaceId() ??
        undefined,
      identity: reqCtx?.identity ?? (automation?.ownerId ? { id: automation.ownerId } : undefined),
    };
  }
  const executor = createDirectExecutor(
    (req) => runtime.chat(req as import("../../runtime/types.ts").ChatRequest),
    getExecutorContext,
  );
  const scheduler = new Scheduler(executor, {
    storeDir: initialStoreDir,
    defaultTimezone,
  });
  scheduler.start();

  /** Resolve workspace-scoped store directory per-request. */
  function getStoreDir(): string {
    return join(runtime.getWorkspaceScopedDir(), "automations");
  }

  /** Build a workspace-scoped ToolContext for per-request use. */
  function getToolContext(): ToolContext {
    const storeDir = getStoreDir();
    const reqCtx = getRequestContext();
    return {
      definitions: () => loadDefinitions(storeDir),
      save: (d) => saveDefinitions(d, storeDir),
      reloadScheduler: () => scheduler.reload(storeDir),
      runNow: (id) => scheduler.runNow(id),
      cancelRun: (id) => scheduler.cancelRun(id),
      storeDir,
      defaultTimezone,
      defaultModel: runtime.getDefaultModel(),
      currentUserId: reqCtx?.identity?.id,
      currentWorkspaceId: reqCtx?.workspaceId ?? undefined,
    };
  }

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
  const originalStop = source.stop.bind(source);
  source.stop = async () => {
    scheduler.stop();
    await originalStop();
  };

  return source;
}
