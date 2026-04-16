/**
 * MCP server entry point for @nimblebraininc/automations bundle.
 *
 * Manages scheduled automation definitions and run history.
 * Exposes 7 tools: create, update, delete, list, status, runs, run.
 * Uses stdio transport — stdout is JSON-RPC only, logging goes to stderr.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Cron } from "croner";
import { executeHttp } from "./executor.ts";
import { computeNextRunAt, Scheduler } from "./scheduler.ts";
import { TOOL_SCHEMAS } from "./schemas.ts";
import { detectOrphans, loadDefinitions, readAllRuns, readRuns, saveDefinitions } from "./store.ts";
import type { Automation, AutomationRun, ScheduleSpec } from "./types.ts";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const WORK_DIR = process.env.NB_WORK_DIR ?? join(homedir(), ".nimblebrain");
const STORE_DIR = join(WORK_DIR, "automations");
const DEFAULT_TIMEZONE = process.env.NB_TIMEZONE ?? "Pacific/Honolulu";

// UI: load the built React SPA from ui/dist/index.html
const UI_DIR = resolve(import.meta.dirname ?? __dirname, "../ui/dist");
const FALLBACK_HTML =
  "<html><body><p>UI not built. Run: cd src/bundles/automations/ui && npm install && npm run build</p></body></html>";

function loadUi(): string {
  const built = join(UI_DIR, "index.html");
  if (existsSync(built)) {
    return readFileSync(built, "utf-8");
  }
  return FALLBACK_HTML;
}

function log(msg: string): void {
  process.stderr.write(`[automations] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Human-readable formatting helpers (exported for testing)
// ---------------------------------------------------------------------------

/** Convert a ScheduleSpec into a human-readable string. */
export function formatSchedule(schedule: ScheduleSpec): string {
  if (schedule.type === "interval" && schedule.intervalMs) {
    const mins = Math.round(schedule.intervalMs / 60_000);
    if (mins < 60) return `Every ${mins} minute${mins === 1 ? "" : "s"}`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `Every ${hrs} hour${hrs === 1 ? "" : "s"}`;
    const days = Math.round(hrs / 24);
    return `Every ${days} day${days === 1 ? "" : "s"}`;
  }

  if (schedule.type === "cron" && schedule.expression) {
    return formatCronExpression(schedule.expression, schedule.timezone);
  }

  return "Unknown schedule";
}

function formatCronExpression(expr: string, timezone?: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;

  const [minute, hour, _dayOfMonth, _month, dayOfWeek] = parts;
  const tz = timezone ?? DEFAULT_TIMEZONE;
  const tzAbbr = formatTimezoneAbbr(tz);

  // "0 8 * * *" → "Daily at 8:00 AM HST"
  if (
    _dayOfMonth === "*" &&
    _month === "*" &&
    dayOfWeek === "*" &&
    hour !== "*" &&
    minute !== "*"
  ) {
    const timeStr = formatTime(Number(hour), Number(minute));
    return `Daily at ${timeStr} ${tzAbbr}`;
  }

  // "0 9 * * 1" → "Mondays at 9:00 AM HST"
  if (
    _dayOfMonth === "*" &&
    _month === "*" &&
    dayOfWeek !== "*" &&
    hour !== "*" &&
    minute !== "*"
  ) {
    const dayName = cronDayName(dayOfWeek!);
    const timeStr = formatTime(Number(hour), Number(minute));
    return `${dayName} at ${timeStr} ${tzAbbr}`;
  }

  // "*/30 * * * *" → "Every 30 minutes"
  if (
    minute?.startsWith("*/") &&
    hour === "*" &&
    _dayOfMonth === "*" &&
    _month === "*" &&
    dayOfWeek === "*"
  ) {
    const interval = Number(minute.slice(2));
    return `Every ${interval} minute${interval === 1 ? "" : "s"}`;
  }

  return expr;
}

function formatTime(hour: number, minute: number): string {
  const period = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;
  const displayMinute = minute.toString().padStart(2, "0");
  return `${displayHour}:${displayMinute} ${period}`;
}

function formatTimezoneAbbr(tz: string): string {
  if (tz === "Pacific/Honolulu") return "HST";
  if (tz === "America/New_York") return "EST";
  if (tz === "America/Chicago") return "CST";
  if (tz === "America/Denver") return "MST";
  if (tz === "America/Los_Angeles") return "PST";
  if (tz === "UTC" || tz === "Etc/UTC") return "UTC";
  return tz;
}

function cronDayName(dayOfWeek: string): string {
  const days: Record<string, string> = {
    "0": "Sundays",
    "1": "Mondays",
    "2": "Tuesdays",
    "3": "Wednesdays",
    "4": "Thursdays",
    "5": "Fridays",
    "6": "Saturdays",
    "7": "Sundays",
  };
  return days[dayOfWeek] ?? `Day ${dayOfWeek}`;
}

/** Format an ISO timestamp as a relative time string. */
export function formatRelativeTime(isoTimestamp: string, now?: number): string {
  const targetMs = new Date(isoTimestamp).getTime();
  const nowMs = now ?? Date.now();
  const diffMs = targetMs - nowMs;
  const absDiffMs = Math.abs(diffMs);

  if (absDiffMs < 60_000) return diffMs >= 0 ? "in <1m" : "<1m ago";

  const minutes = Math.floor(absDiffMs / 60_000);
  if (minutes < 60) {
    return diffMs >= 0 ? `in ${minutes}m` : `${minutes}m ago`;
  }

  const hours = Math.floor(absDiffMs / 3_600_000);
  if (hours < 24) {
    return diffMs >= 0 ? `in ${hours}h` : `${hours}h ago`;
  }

  const days = Math.floor(absDiffMs / 86_400_000);
  return diffMs >= 0 ? `in ${days}d` : `${days}d ago`;
}

// ---------------------------------------------------------------------------
// Cost estimation helpers (exported for testing)
// ---------------------------------------------------------------------------

/** Approximate cost rates per 1M tokens (USD) for known model families. */
const MODEL_RATES: Record<string, { input: number; output: number }> = {
  "claude-sonnet": { input: 3, output: 15 },
  "claude-haiku": { input: 0.8, output: 4 },
  "claude-opus": { input: 15, output: 75 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10 },
};

export function getModelRates(model: string | null | undefined): { input: number; output: number } {
  if (!model) return MODEL_RATES["claude-sonnet"]!; // default
  const lower = model.toLowerCase();
  for (const [key, rates] of Object.entries(MODEL_RATES)) {
    if (lower.includes(key)) return rates;
  }
  return MODEL_RATES["claude-sonnet"]!; // fallback
}

export function estimateRunsPerDay(schedule: ScheduleSpec): number {
  if (schedule.type === "interval" && schedule.intervalMs) {
    return 86_400_000 / schedule.intervalMs;
  }
  if (schedule.type === "cron" && schedule.expression) {
    const parts = schedule.expression.trim().split(/\s+/);
    if (parts.length !== 5) return 1;
    const [minute, hour, , , dow] = parts;
    if (minute?.startsWith("*/")) return (24 * 60) / Number(minute.slice(2));
    if (hour === "*") return 24;
    if (dow !== "*") return 1 / 7; // weekly
    return 1; // daily
  }
  return 1;
}

export interface CostEstimate {
  perRunUsd: number;
  perDayUsd: number;
  perMonthUsd: number;
}

export function estimateCost(automation: Automation, workspaceDefaultModel?: string): CostEstimate {
  const rates = getModelRates(automation.model ?? workspaceDefaultModel);
  // Use actual average if available, otherwise a realistic per-run estimate.
  // maxInputTokens is a ceiling (200K default), NOT an estimate — actual runs
  // typically use 15-25K input tokens. Using the ceiling produces wildly inflated costs.
  const hasHistory = automation.runCount > 0 && automation.cumulativeInputTokens > 0;
  const inputTokens = hasHistory ? automation.cumulativeInputTokens / automation.runCount : 20_000; // realistic per-run estimate
  const outputTokens = hasHistory ? automation.cumulativeOutputTokens / automation.runCount : 500;
  const perRunUsd = (inputTokens * rates.input + outputTokens * rates.output) / 1_000_000;
  const runsPerDay = estimateRunsPerDay(automation.schedule);
  return {
    perRunUsd,
    perDayUsd: perRunUsd * runsPerDay,
    perMonthUsd: perRunUsd * runsPerDay * 30,
  };
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

/** Generate a kebab-case id from a name. */
export function toKebabCase(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ---------------------------------------------------------------------------
// Recursive prevention
// ---------------------------------------------------------------------------

const RECURSIVE_TOOL_PATTERNS = ["automations__create", "automations__update"];

function containsRecursiveTool(allowedTools?: string[]): boolean {
  if (!allowedTools) return false;
  return allowedTools.some((tool) =>
    RECURSIVE_TOOL_PATTERNS.some((pattern) => tool === pattern || tool.includes(pattern)),
  );
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = TOOL_SCHEMAS;

// ---------------------------------------------------------------------------
// Tool handler implementations (exported for direct testing)
// ---------------------------------------------------------------------------

export interface ToolContext {
  definitions: () => Map<string, Automation>;
  save: (defs: Map<string, Automation>) => void;
  reloadScheduler: () => void;
  runNow: (automationId: string) => Promise<AutomationRun | null>;
  cancelRun: (automationId: string) => boolean;
  storeDir: string;
  defaultTimezone: string;
  /** Workspace default model (for cost estimation when automation.model is null). */
  defaultModel?: string;
  /** Current user ID (for setting automation ownership at creation time). */
  currentUserId?: string;
  /** Current workspace ID (for setting automation workspace scope at creation time). */
  currentWorkspaceId?: string;
}

/** Validate schedule, iteration, and token fields. Throws on invalid input. */
export function validateAutomationFields(args: Record<string, unknown>): void {
  // Schedule validation
  const schedule = args.schedule as ScheduleSpec | undefined;
  if (schedule) {
    if (schedule.type === "interval") {
      if (schedule.intervalMs == null) {
        throw new Error("intervalMs is required for interval schedules");
      }
      if (schedule.intervalMs < 60_000) {
        throw new Error("Interval must be at least 1 minute (60000ms)");
      }
    }
    if (schedule.type === "cron") {
      if (!schedule.expression) {
        throw new Error("expression is required for cron schedules");
      }
      // Validate cron expression via Croner
      try {
        new Cron(schedule.expression);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Invalid cron expression: ${msg}`);
      }
    }
  }

  // maxIterations validation
  const maxIterations = args.maxIterations as number | undefined;
  if (maxIterations != null && (maxIterations < 1 || maxIterations > 15)) {
    throw new Error("maxIterations must be between 1 and 15");
  }

  // maxInputTokens validation
  const maxInputTokens = args.maxInputTokens as number | undefined;
  if (maxInputTokens != null && (maxInputTokens < 1_000 || maxInputTokens > 1_000_000)) {
    throw new Error("maxInputTokens must be between 1,000 and 1,000,000");
  }

  // maxRunDurationMs validation
  const maxRunDurationMs = args.maxRunDurationMs as number | undefined;
  if (maxRunDurationMs != null && (maxRunDurationMs < 10_000 || maxRunDurationMs > 600_000)) {
    throw new Error("maxRunDurationMs must be between 10 seconds and 10 minutes");
  }
}

export function handleCreate(args: Record<string, unknown>, ctx: ToolContext): object {
  const name = args.name as string;
  const prompt = args.prompt as string;
  const schedule = args.schedule as ScheduleSpec;

  if (!name || !prompt || !schedule) {
    throw new Error("Missing required fields: name, prompt, schedule");
  }

  validateAutomationFields(args);

  // Recursive prevention
  const allowedTools = args.allowedTools as string[] | undefined;
  if (containsRecursiveTool(allowedTools)) {
    throw new Error(
      "Recursive prevention: allowedTools must not contain automations__create or automations__update",
    );
  }

  const id = toKebabCase(name);
  const defs = ctx.definitions();

  // Idempotent: return existing if same id
  const existing = defs.get(id);
  if (existing) {
    return {
      automation: existing,
      created: false,
      message: `Automation "${name}" already exists (id: ${id}). Returning existing.`,
    };
  }

  const now = new Date().toISOString();
  const automation: Automation = {
    id,
    name,
    ownerId: ctx.currentUserId,
    workspaceId: ctx.currentWorkspaceId,
    prompt,
    schedule,
    description: args.description as string | undefined,
    skill: args.skill as string | undefined,
    allowedTools,
    maxIterations: args.maxIterations as number | undefined,
    maxInputTokens: args.maxInputTokens as number | undefined,
    maxRunDurationMs: args.maxRunDurationMs as number | undefined,
    model: (args.model as string | undefined) ?? undefined,
    tokenBudget: args.tokenBudget as Automation["tokenBudget"],
    enabled: (args.enabled as boolean | undefined) ?? true,
    source: (args.source as Automation["source"] | undefined) ?? "agent",
    bundleName: args.bundleName as string | undefined,
    createdAt: now,
    updatedAt: now,
    runCount: 0,
    consecutiveErrors: 0,
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
  };

  // Compute initial nextRunAt
  const nextRun = computeNextRunAt(automation, Date.now(), ctx.defaultTimezone);
  if (nextRun !== null) {
    automation.nextRunAt = new Date(nextRun).toISOString();
  }

  defs.set(id, automation);
  ctx.save(defs);
  ctx.reloadScheduler();

  return {
    automation,
    created: true,
    message: `Automation "${name}" created (id: ${id}).`,
  };
}

export function handleUpdate(args: Record<string, unknown>, ctx: ToolContext): object {
  const name = args.name as string;
  if (!name) throw new Error("Missing required field: name");

  const defs = ctx.definitions();
  const automation = findByName(defs, name);
  if (!automation) {
    throw new Error(`Automation not found: "${name}"`);
  }

  validateAutomationFields(args);

  const updatableFields = [
    "description",
    "prompt",
    "schedule",
    "skill",
    "allowedTools",
    "maxIterations",
    "maxInputTokens",
    "model",
    "maxRunDurationMs",
    "tokenBudget",
    "enabled",
  ] as const;

  let changed = false;
  for (const field of updatableFields) {
    if (field in args && args[field] !== undefined) {
      (automation as unknown as Record<string, unknown>)[field] = args[field];
      changed = true;
    }
  }

  // Clear disable state when re-enabling
  if (args.enabled === true) {
    automation.consecutiveErrors = 0;
    automation.disabledAt = undefined;
    automation.disabledReason = undefined;
  }

  if (changed) {
    automation.updatedAt = new Date().toISOString();

    // Recompute nextRunAt if schedule changed
    if ("schedule" in args) {
      const nextRun = computeNextRunAt(automation, Date.now(), ctx.defaultTimezone);
      if (nextRun !== null) {
        automation.nextRunAt = new Date(nextRun).toISOString();
      }
    }

    defs.set(automation.id, automation);
    ctx.save(defs);
    ctx.reloadScheduler();
  }

  return {
    automation,
    updated: changed,
    message: changed ? `Automation "${name}" updated.` : `No changes applied to "${name}".`,
  };
}

export function handleDelete(args: Record<string, unknown>, ctx: ToolContext): object {
  const name = args.name as string;
  if (!name) throw new Error("Missing required field: name");

  const defs = ctx.definitions();
  const automation = findByName(defs, name);
  if (!automation) {
    throw new Error(`Automation not found: "${name}"`);
  }

  defs.delete(automation.id);
  ctx.save(defs);
  ctx.reloadScheduler();

  return {
    deleted: true,
    id: automation.id,
    message: `Automation "${name}" deleted. Run history preserved.`,
  };
}

export function handleList(args: Record<string, unknown>, ctx: ToolContext): object {
  const defs = ctx.definitions();
  const now = Date.now();

  let automations = Array.from(defs.values());

  // Apply filters
  if (args.enabled !== undefined) {
    automations = automations.filter((a) => a.enabled === args.enabled);
  }
  if (args.source !== undefined) {
    automations = automations.filter((a) => a.source === args.source);
  }

  const summaries = automations.map((a) => ({
    id: a.id,
    name: a.name,
    description: a.description,
    schedule: formatSchedule(a.schedule),
    enabled: a.enabled,
    source: a.source,
    runCount: a.runCount,
    lastRunStatus: a.lastRunStatus ?? null,
    lastRunAt: a.lastRunAt ? formatRelativeTime(a.lastRunAt, now) : null,
    nextRunAt: a.nextRunAt ? formatRelativeTime(a.nextRunAt, now) : null,
    disabledAt: a.disabledAt ?? null,
    disabledReason: a.disabledReason ?? null,
    estimatedCostPerDay: estimateCost(a, ctx.defaultModel).perDayUsd,
  }));

  return {
    automations: summaries,
    total: summaries.length,
  };
}

export function handleStatus(args: Record<string, unknown>, ctx: ToolContext): object {
  const name = args.name as string;
  if (!name) throw new Error("Missing required field: name");

  const defs = ctx.definitions();
  const automation = findByName(defs, name);
  if (!automation) {
    throw new Error(`Automation not found: "${name}"`);
  }

  const limit = (args.limit as number) ?? 5;
  const now = Date.now();

  const runs = readRuns(automation.id, { limit }, ctx.storeDir);

  const cost = estimateCost(automation, ctx.defaultModel);

  const rates = getModelRates(automation.model ?? ctx.defaultModel);
  const actualCostUsd =
    automation.cumulativeInputTokens > 0
      ? (automation.cumulativeInputTokens * rates.input +
          automation.cumulativeOutputTokens * rates.output) /
        1_000_000
      : 0;

  return {
    automation: {
      ...automation,
      scheduleHuman: formatSchedule(automation.schedule),
      lastRunAtHuman: automation.lastRunAt ? formatRelativeTime(automation.lastRunAt, now) : null,
      nextRunAtHuman: automation.nextRunAt ? formatRelativeTime(automation.nextRunAt, now) : null,
      cumulativeInputTokens: automation.cumulativeInputTokens,
      cumulativeOutputTokens: automation.cumulativeOutputTokens,
      tokenBudget: automation.tokenBudget ?? null,
      budgetResetAt: automation.budgetResetAt ?? null,
      actualCostUsd,
      estimatedCostPerRun: cost.perRunUsd,
      estimatedCostPerDay: cost.perDayUsd,
      estimatedCostPerMonth: cost.perMonthUsd,
    },
    recentRuns: runs,
  };
}

export function handleRuns(args: Record<string, unknown>, ctx: ToolContext): object {
  const automationId = args.automationId as string | undefined;
  const status = args.status as AutomationRun["status"] | undefined;
  const since = args.since as string | undefined;
  const limit = (args.limit as number) ?? 20;

  let runs: AutomationRun[];

  if (automationId) {
    runs = readRuns(automationId, { limit, status, since }, ctx.storeDir);
  } else {
    runs = readAllRuns({ limit, status, since }, ctx.storeDir);
  }

  return { runs, total: runs.length };
}

export async function handleRun(args: Record<string, unknown>, ctx: ToolContext): Promise<object> {
  const name = args.name as string;
  if (!name) throw new Error("Missing required field: name");

  // Ensure scheduler has fresh definitions (e.g., automation just created)
  ctx.reloadScheduler();

  const defs = ctx.definitions();
  const automation = findByName(defs, name);
  if (!automation) {
    throw new Error(`Automation not found: "${name}"`);
  }

  log(`handleRun: found "${name}" (id=${automation.id}), dispatching via runNow...`);

  const run = await ctx.runNow(automation.id);
  if (!run) {
    // Debug: dump scheduler state to understand why runNow returned null
    const schedulerDefs = ctx.definitions();
    const ids = Array.from(schedulerDefs.keys());
    log(
      `handleRun: runNow returned null for "${automation.id}". Scheduler has ${ids.length} definitions: [${ids.join(", ")}]`,
    );
    throw new Error(
      `Failed to trigger run for "${name}" (id=${automation.id}). The scheduler could not find this automation. Try reloading.`,
    );
  }

  return { run };
}

export function handleCancel(args: Record<string, unknown>, ctx: ToolContext): object {
  const name = args.name as string;
  if (!name) throw new Error("Missing required field: name");

  // Ensure scheduler has fresh definitions
  ctx.reloadScheduler();

  const defs = ctx.definitions();
  const automation = findByName(defs, name);
  if (!automation) {
    throw new Error(`Automation not found: "${name}"`);
  }

  const cancelled = ctx.cancelRun(automation.id);
  return {
    cancelled,
    id: automation.id,
    message: cancelled
      ? `Automation "${name}" run cancelled.`
      : `Automation "${name}" has no active run to cancel.`,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findByName(defs: Map<string, Automation>, name: string): Automation | undefined {
  // First try direct id lookup (kebab-case of name)
  const byId = defs.get(toKebabCase(name));
  if (byId) return byId;

  // Fall back to name match
  for (const auto of defs.values()) {
    if (auto.name === name) return auto;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Tool routing
// ---------------------------------------------------------------------------

type ToolArgs = Record<string, unknown>;

async function routeToolCall(name: string, args: ToolArgs, ctx: ToolContext): Promise<object> {
  switch (name) {
    case "create":
      return handleCreate(args, ctx);
    case "update":
      return handleUpdate(args, ctx);
    case "delete":
      return handleDelete(args, ctx);
    case "list":
      return handleList(args, ctx);
    case "status":
      return handleStatus(args, ctx);
    case "runs":
      return handleRuns(args, ctx);
    case "run":
      return handleRun(args, ctx);
    case "cancel":
      return handleCancel(args, ctx);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log(`Starting with store dir: ${STORE_DIR}`);

  // Step 1: Initialize store
  const defs = loadDefinitions(STORE_DIR);
  log(`Loaded ${defs.size} automation definitions`);

  // Step 2: Detect orphans
  const orphanCount = detectOrphans(STORE_DIR);
  if (orphanCount > 0) {
    log(`Fixed ${orphanCount} orphaned run(s)`);
  }

  // Step 3: Start scheduler
  const scheduler = new Scheduler(executeHttp, {
    storeDir: STORE_DIR,
    defaultTimezone: DEFAULT_TIMEZONE,
  });
  scheduler.start();
  log("Scheduler started");

  // Build the tool context
  const ctx: ToolContext = {
    definitions: () => loadDefinitions(STORE_DIR),
    save: (d) => saveDefinitions(d, STORE_DIR),
    reloadScheduler: () => scheduler.reload(),
    runNow: (id) => scheduler.runNow(id),
    cancelRun: (id) => scheduler.cancelRun(id),
    storeDir: STORE_DIR,
    defaultTimezone: DEFAULT_TIMEZONE,
  };

  // Create MCP server
  const server = new Server(
    {
      name: "@nimblebraininc/automations",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    },
  );

  // Register tool listing handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  // Register tool call handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const result = await routeToolCall(name, args ?? {}, ctx);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`Tool error (${name}): ${message}`);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: message }),
          },
        ],
        isError: true,
      };
    }
  });

  // Register resource listing handler
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: "ui://automations/panel",
        name: "Automations Panel",
        mimeType: "text/html",
      },
    ],
  }));

  // Register resource read handler
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri === "ui://automations/panel") {
      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: "text/html",
            text: loadUi(),
          },
        ],
      };
    }
    throw new Error(`Resource not found: ${request.params.uri}`);
  });

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  log("Server connected via stdio");

  // Graceful shutdown
  const shutdown = async () => {
    log("Shutting down...");
    scheduler.stop();
    await server.close();
    process.exit(0);
  };

  // Exit when the MCP transport closes (parent died / bun --watch restart).
  // Without this, orphaned processes keep the old scheduler running
  // with a stale internal token, causing perpetual 401 errors.
  server.onclose = () => {
    log("MCP transport closed — parent process gone, exiting.");
    scheduler.stop();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  log(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
