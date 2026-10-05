import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { effectiveRunLimits, resolveTasksConfig } from "../../../../src/config/tasks.ts";
import type { RunNowTicket } from "../../../../src/platform/tasks/scheduler.ts";
import {
  estimateRunsPerDay,
  formatRelativeTime,
  formatSchedule,
  handleCancel,
  handleCreate,
  handleDelete,
  handleList,
  handleRun,
  handleRuns,
  handleStatus,
  handleUpdate,
  type ToolContext,
  toKebabCase,
  validateTaskFields,
} from "../../../../src/platform/tasks/server.ts";
import {
  appendRun,
  deleteTaskDefinition,
  loadOwnerTasks,
  readAllRuns,
  readRunResult,
  readRuns,
  readRunsPage,
  saveTask,
} from "../../../../src/platform/tasks/store.ts";
import type { Task, TaskRun } from "../../../../src/platform/tasks/types.ts";
import { seedWorkspaceRoot } from "../../../helpers/test-workspace.ts";

const WS = "ws_0076759dbbe19fcc";
const OWNER = "usr_test";

/** Load this test's single workspace+owner tasks. */
function loadDefs(): Map<string, Task> {
  return loadOwnerTasks(TMP_DIR, WS, OWNER);
}

/** Reconcile a definitions map to the per-task store (write each, delete removed). */
function saveDefs(map: Map<string, Task>): void {
  const onDisk = loadOwnerTasks(TMP_DIR, WS, OWNER);
  for (const auto of map.values()) {
    if (!auto.workspaceId) auto.workspaceId = WS;
    if (!auto.ownerId) auto.ownerId = OWNER;
    saveTask(TMP_DIR, WS, OWNER, auto);
  }
  for (const id of onDisk.keys()) {
    if (!map.has(id)) deleteTaskDefinition(TMP_DIR, WS, OWNER, id);
  }
}

/** Append a run summary for this test's workspace+owner. */
function seedRun(taskId: string, run: TaskRun): void {
  appendRun(TMP_DIR, WS, OWNER, taskId, run);
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build the new {manifest, body} shape for handleCreate without ceremony. */
function createArgs(
  name: string,
  prompt: string,
  schedule: { type: string; [k: string]: unknown },
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { manifest: { name, schedule, ...extra }, body: prompt };
}

/** Build the {name, manifest?, body?} shape for handleUpdate. */
function updateArgs(name: string, patch: Record<string, unknown> = {}): Record<string, unknown> {
  const { body, ...manifest } = patch as { body?: string } & Record<string, unknown>;
  const out: Record<string, unknown> = { name };
  if (Object.keys(manifest).length > 0) out.manifest = manifest;
  if (body !== undefined) out.body = body;
  return out;
}

const TMP_DIR = join(import.meta.dir, ".tmp-task-server");

let schedulerReloaded: boolean;

function makeCtx(overrides?: Partial<ToolContext>): ToolContext {
  schedulerReloaded = false;

  return {
    definitions: () => loadDefs(),
    save: (defs) => {
      saveDefs(defs);
    },
    reloadScheduler: () => {
      schedulerReloaded = true;
    },
    runNow: (taskId: string): RunNowTicket | null => {
      const auto = loadDefs().get(taskId);
      if (!auto) return null;
      const run: TaskRun = {
        id: `run_test${Date.now()}`,
        taskId,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        status: "success",
        inputTokens: 100,
        outputTokens: 50,
        toolCalls: 2,
        iterations: 1,
        resultPreview: "Test run completed",
      };
      seedRun(taskId, run);
      return { state: "started", run: Promise.resolve(run) };
    },
    cancelRun: (_taskId: string) => false,
    readRuns: (id, opts) => readRuns(TMP_DIR, WS, OWNER, id, opts),
    readRunsPage: (id, opts) => readRunsPage(TMP_DIR, WS, OWNER, id, opts),
    readAllRuns: (opts) => readAllRuns(TMP_DIR, WS, OWNER, opts),
    readRunResult: (id, runId) => readRunResult(TMP_DIR, WS, OWNER, id, runId),
    defaultTimezone: "Pacific/Honolulu",
    ...overrides,
  };
}

function makeRun(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: `run_${Math.random().toString(36).slice(2, 8)}`,
    taskId: "daily-report",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    status: "success",
    inputTokens: 100,
    outputTokens: 50,
    toolCalls: 2,
    iterations: 1,
    ...overrides,
  };
}

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true });
  seedWorkspaceRoot(TMP_DIR, WS);
});

afterEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// formatSchedule
// ---------------------------------------------------------------------------

describe("formatSchedule", () => {
  test("interval in minutes", () => {
    expect(formatSchedule({ type: "interval", intervalMs: 1_800_000 })).toBe("Every 30 minutes");
  });

  test("interval in hours", () => {
    expect(formatSchedule({ type: "interval", intervalMs: 7_200_000 })).toBe("Every 2 hours");
  });

  test("daily cron", () => {
    expect(
      formatSchedule({
        type: "cron",
        expression: "0 8 * * *",
        timezone: "Pacific/Honolulu",
      }),
    ).toBe("Daily at 8:00 AM HST");
  });

  test("weekly cron (Monday)", () => {
    expect(
      formatSchedule({
        type: "cron",
        expression: "0 9 * * 1",
        timezone: "Pacific/Honolulu",
      }),
    ).toBe("Mondays at 9:00 AM HST");
  });

  test("every N minutes cron", () => {
    expect(formatSchedule({ type: "cron", expression: "*/30 * * * *" })).toBe("Every 30 minutes");
  });

  test("single minute interval", () => {
    expect(formatSchedule({ type: "interval", intervalMs: 60_000 })).toBe("Every 1 minute");
  });
});

// ---------------------------------------------------------------------------
// formatRelativeTime
// ---------------------------------------------------------------------------

describe("formatRelativeTime", () => {
  const now = new Date("2025-06-15T12:00:00.000Z").getTime();

  test("past hours", () => {
    const twoHoursAgo = new Date(now - 2 * 3_600_000).toISOString();
    expect(formatRelativeTime(twoHoursAgo, now)).toBe("2h ago");
  });

  test("future hours", () => {
    const inTwentyTwoHours = new Date(now + 22 * 3_600_000).toISOString();
    expect(formatRelativeTime(inTwentyTwoHours, now)).toBe("in 22h");
  });

  test("past days", () => {
    const threeDaysAgo = new Date(now - 3 * 86_400_000).toISOString();
    expect(formatRelativeTime(threeDaysAgo, now)).toBe("3d ago");
  });

  test("past minutes", () => {
    const fiveMinAgo = new Date(now - 5 * 60_000).toISOString();
    expect(formatRelativeTime(fiveMinAgo, now)).toBe("5m ago");
  });

  test("future minutes", () => {
    const inTenMin = new Date(now + 10 * 60_000).toISOString();
    expect(formatRelativeTime(inTenMin, now)).toBe("in 10m");
  });
});

// ---------------------------------------------------------------------------
// toKebabCase
// ---------------------------------------------------------------------------

describe("toKebabCase", () => {
  test("converts spaces", () => {
    expect(toKebabCase("Daily Report")).toBe("daily-report");
  });

  test("strips special chars", () => {
    expect(toKebabCase("My Task!@#$%")).toBe("my-task");
  });

  test("handles multiple spaces", () => {
    expect(toKebabCase("  hello   world  ")).toBe("hello-world");
  });
});

// ---------------------------------------------------------------------------
// create tool
// ---------------------------------------------------------------------------

describe("handleCreate", () => {
  test("creates task with defaults", () => {
    const ctx = makeCtx();
    const result = handleCreate(
      {
        manifest: {
          name: "Daily Report",
          schedule: { type: "cron", expression: "0 8 * * *", timezone: "Pacific/Honolulu" },
        },
        body: "Generate daily report",
      },
      ctx,
    );

    expect(result.created).toBe(true);
    expect(result.task.id).toBe("daily-report");
    expect(result.task.name).toBe("Daily Report");
    expect(result.task.enabled).toBe(true);
    expect(result.task.source).toBe("agent");
    expect(result.task.runCount).toBe(0);
    expect(result.task.consecutiveErrors).toBe(0);
    expect(result.task.createdAt).toBeDefined();
    expect(result.task.updatedAt).toBeDefined();
    expect(schedulerReloaded).toBe(true);
  });

  test("idempotent — returns existing for duplicate name", () => {
    const ctx = makeCtx();
    const first = handleCreate(
      {
        manifest: {
          name: "Daily Report",
          schedule: { type: "interval", intervalMs: 60_000 },
        },
        body: "Generate daily report",
      },
      ctx,
    );

    expect(first.created).toBe(true);

    const second = handleCreate(
      {
        manifest: {
          name: "Daily Report",
          schedule: { type: "interval", intervalMs: 120_000 },
        },
        body: "Different prompt",
      },
      ctx,
    );

    expect(second.created).toBe(false);
    expect(second.task.id).toBe(first.task.id);
    expect(second.task.prompt).toBe("Generate daily report"); // original prompt
  });
});

// ---------------------------------------------------------------------------
// create → list integration
// ---------------------------------------------------------------------------

describe("create → list", () => {
  test("created task appears in list", () => {
    const ctx = makeCtx();
    handleCreate(
      {
        manifest: {
          name: "Daily Report",
          schedule: { type: "interval", intervalMs: 1_800_000 },
        },
        body: "Generate daily report",
      },
      ctx,
    );

    const result = handleList({}, ctx) as {
      tasks: Array<{ id: string; name: string; schedule: string }>;
      total: number;
    };

    expect(result.total).toBe(1);
    expect(result.tasks[0]!.name).toBe("Daily Report");
    expect(result.tasks[0]!.schedule).toBe("Every 30 minutes");
  });
});

// ---------------------------------------------------------------------------
// list paging
// ---------------------------------------------------------------------------

describe("handleList paging", () => {
  type ListResult = {
    tasks: Array<{ id: string; name: string }>;
    total: number;
    returned: number;
    nextCursor: string | null;
    hasMore: boolean;
    truncated?: string;
  };

  /**
   * Seed n tasks as one map through a single save. Paging needs only
   * records on disk; the create path has its own tests. Seeding through
   * `handleCreate` costs O(n²) disk work, because each create reads every
   * definition and `save` rewrites every one, so 105 records take ~2s.
   * Names are `Seeded NNN` and ids their kebab form, as create would produce.
   */
  function seed(ctx: ToolContext, n: number): void {
    const now = new Date().toISOString();
    const map = new Map<string, Task>();
    for (let i = 0; i < n; i++) {
      const name = `Seeded ${String(i).padStart(3, "0")}`;
      const id = toKebabCase(name);
      map.set(id, {
        id,
        name,
        prompt: "noop",
        schedule: { type: "interval", intervalMs: 1_800_000 },
        enabled: true,
        source: "agent",
        createdAt: now,
        updatedAt: now,
        runCount: 0,
        consecutiveErrors: 0,
        cumulativeInputTokens: 0,
        cumulativeOutputTokens: 0,
        ownerId: OWNER,
        workspaceId: WS,
      });
    }
    ctx.save(map);
  }

  test("caps at the default limit and reports the unpaged total", () => {
    const ctx = makeCtx();
    seed(ctx, 105);

    const r = handleList({}, ctx) as ListResult;
    // `total` must describe every match, not the page — a caller that reads
    // `total` as "what I received" is exactly the bug this guards.
    expect(r.total).toBe(105);
    expect(r.returned).toBe(100);
    expect(r.tasks).toHaveLength(100);
    expect(r.hasMore).toBe(true);
  });

  test("orders pages deterministically", () => {
    // Definitions are built from a directory read with no ordering, so
    // without an explicit sort the page boundary is undefined and a record
    // can land on both pages or neither.
    const ctx = makeCtx();
    seed(ctx, 12);

    const ids = (handleList({ limit: 12 }, ctx) as ListResult).tasks.map((a) => a.id);
    expect(ids).toEqual([...ids].sort());
    // Stable across calls, not merely sorted once.
    const again = (handleList({ limit: 12 }, ctx) as ListResult).tasks.map((a) => a.id);
    expect(again).toEqual(ids);
  });

  test("says so in prose when the page hid matches, and names what remains", () => {
    const ctx = makeCtx();
    seed(ctx, 105);

    const r = handleList({}, ctx) as ListResult;
    // A silent cap is worse than an error here: the caller concludes "not
    // found" from a set it never saw. The remainder must be in the text.
    expect(r.truncated).toBeDefined();
    expect(r.truncated).toContain("105");
    expect(r.truncated).toContain("5 more remain");
    expect(r.truncated).toContain(r.nextCursor as string);
  });

  test("the remainder count is exact at a mid-sequence cursor", () => {
    const ctx = makeCtx();
    seed(ctx, 105);

    const first = handleList({ limit: 50 }, ctx) as ListResult;
    const second = handleList({ limit: 25, cursor: first.nextCursor as string }, ctx) as ListResult;
    // 105 total, 50 + 25 read, so 30 are genuinely left — not a figure
    // derived from a caller history the handler cannot see.
    expect(second.truncated).toContain("30 more remain");
  });

  test("cursor walks the remainder and clears the flag on the last page", () => {
    const ctx = makeCtx();
    seed(ctx, 105);

    const first = handleList({}, ctx) as ListResult;
    const last = handleList({ cursor: first.nextCursor as string }, ctx) as ListResult;
    expect(last.returned).toBe(5);
    expect(last.total).toBe(105);
    expect(last.hasMore).toBe(false);
    expect(last.nextCursor).toBeNull();
    expect(last.truncated).toBeUndefined();
  });

  test("a delete behind the cursor does not skip the records ahead of it", () => {
    // The failure a numeric offset has: removing an entry from an earlier
    // page shifts everything back, and the next slice steps over whatever
    // crossed the boundary.
    const ctx = makeCtx();
    seed(ctx, 30);

    const first = handleList({ limit: 10 }, ctx) as ListResult;
    handleDelete({ name: first.tasks[0]!.name }, ctx);
    const second = handleList({ limit: 10, cursor: first.nextCursor as string }, ctx) as ListResult;

    const seen = new Set([...first.tasks, ...second.tasks].map((a) => a.id));
    const wanted = (handleList({ limit: 500 }, ctx) as ListResult).tasks
      .map((a) => a.id)
      .slice(0, 19);
    for (const id of wanted) expect(seen.has(id)).toBe(true);
  });

  test("an unknown cursor re-serves the first page rather than skipping", () => {
    const ctx = makeCtx();
    seed(ctx, 5);

    const r = handleList({ cursor: "no-such-task" }, ctx) as ListResult;
    expect(r.returned).toBe(5);
    expect(r.total).toBe(5);
  });

  test("honors an explicit limit and its floor", () => {
    const ctx = makeCtx();
    seed(ctx, 12);

    expect((handleList({ limit: 3 }, ctx) as ListResult).returned).toBe(3);
    // Below the floor clamps up rather than returning an empty page.
    expect((handleList({ limit: 0 }, ctx) as ListResult).returned).toBe(1);
  });

  test("clamps a limit above the ceiling to 500", () => {
    // Needs more than 500 records or the assertion holds with or without the
    // clamp.
    const ctx = makeCtx();
    seed(ctx, 501);

    const r = handleList({ limit: 10_000 }, ctx) as ListResult;
    expect(r.total).toBe(501);
    expect(r.returned).toBe(500);
    expect(r.hasMore).toBe(true);
    expect(r.nextCursor).not.toBeNull();
  });

  test("no truncation notice when everything fits", () => {
    const ctx = makeCtx();
    seed(ctx, 3);

    const r = handleList({}, ctx) as ListResult;
    expect(r.total).toBe(3);
    expect(r.returned).toBe(3);
    expect(r.hasMore).toBe(false);
    expect(r.nextCursor).toBeNull();
    expect(r.truncated).toBeUndefined();
  });

  test("total counts filter matches, not the whole store", () => {
    const ctx = makeCtx();
    seed(ctx, 4);
    handleUpdate({ name: "Seeded 000", manifest: { enabled: false } }, ctx);

    const r = handleList({ enabled: false }, ctx) as ListResult;
    expect(r.total).toBe(1);
    expect(r.returned).toBe(1);
    expect(r.hasMore).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// update tool
// ---------------------------------------------------------------------------

describe("handleUpdate", () => {
  test("updates enabled status", () => {
    const ctx = makeCtx();
    handleCreate(
      createArgs("Daily Report", "Generate report", { type: "interval", intervalMs: 60_000 }),
      ctx,
    );

    const result = handleUpdate(updateArgs("Daily Report", { enabled: false }), ctx);

    expect(result.updated).toBe(true);
    expect(result.task.enabled).toBe(false);

    // Verify reflected in list
    const listResult = handleList({}, ctx) as {
      tasks: Array<{ enabled: boolean }>;
    };
    expect(listResult.tasks[0]!.enabled).toBe(false);
  });

  test("updates schedule and reloads scheduler", () => {
    const ctx = makeCtx();
    handleCreate(createArgs("My Task", "Do it", { type: "interval", intervalMs: 60_000 }), ctx);

    schedulerReloaded = false;
    handleUpdate(
      updateArgs("My Task", {
        schedule: { type: "cron", expression: "0 9 * * 1", timezone: "Pacific/Honolulu" },
      }),
      ctx,
    );

    expect(schedulerReloaded).toBe(true);
  });

  test("throws for nonexistent task", () => {
    const ctx = makeCtx();
    expect(() => handleUpdate(updateArgs("Nonexistent"), ctx)).toThrow("Task not found");
  });
  test("sets allowedTools", () => {
    const ctx = makeCtx();
    handleCreate(createArgs("Scoped", "Do it", { type: "interval", intervalMs: 60_000 }), ctx);

    const result = handleUpdate(updateArgs("Scoped", { allowedTools: ["crm__*"] }), ctx);

    expect(result.task.allowedTools).toEqual(["crm__*"]);
  });

  test("refuses allowedTools that name a task-authoring tool", () => {
    const ctx = makeCtx();
    handleCreate(createArgs("Scoped", "Do it", { type: "interval", intervalMs: 60_000 }), ctx);

    expect(() =>
      handleUpdate(updateArgs("Scoped", { allowedTools: ["tasks__update"] }), ctx),
    ).toThrow(/allowedTools may not include "tasks__update"/);
  });
});

describe("handleCreate — allowedTools", () => {
  test("stores the list on the task", () => {
    const ctx = makeCtx();
    const result = handleCreate(
      createArgs(
        "Scoped",
        "Do it",
        { type: "interval", intervalMs: 60_000 },
        {
          allowedTools: ["crm__*", "files__read"],
        },
      ),
      ctx,
    );

    expect(result.task.allowedTools).toEqual(["crm__*", "files__read"]);
  });

  test("refuses a list that names tasks__create", () => {
    const ctx = makeCtx();
    expect(() =>
      handleCreate(
        createArgs(
          "Loop",
          "Do it",
          { type: "interval", intervalMs: 60_000 },
          {
            allowedTools: ["files__*", "tasks__create"],
          },
        ),
        ctx,
      ),
    ).toThrow(/allowedTools may not include/);
  });
});

// ---------------------------------------------------------------------------
// delete tool
// ---------------------------------------------------------------------------

describe("handleDelete", () => {
  test("removes task from list", () => {
    const ctx = makeCtx();
    handleCreate(createArgs("Temp", "Temporary", { type: "interval", intervalMs: 60_000 }), ctx);

    const delResult = handleDelete({ name: "Temp" }, ctx);
    expect(delResult.deleted).toBe(true);

    const listResult = handleList({}, ctx) as { total: number };
    expect(listResult.total).toBe(0);
  });

  test("throws for nonexistent task", () => {
    const ctx = makeCtx();
    expect(() => handleDelete({ name: "Nope" }, ctx)).toThrow("Task not found");
  });
});

// ---------------------------------------------------------------------------
// list with filters
// ---------------------------------------------------------------------------

describe("handleList filters", () => {
  // `source` is set by the runtime, not by the tool input — the LLM-facing
  // schema doesn't accept it. To exercise filter-by-source, seed the store
  // directly with tasks whose `source` is set as an operator would.
  function seedTasks(ctx: ToolContext): void {
    handleCreate(createArgs("Active Operator", "p", { type: "interval", intervalMs: 60_000 }), ctx);
    handleCreate(
      createArgs(
        "Disabled User",
        "p",
        { type: "interval", intervalMs: 60_000 },
        { enabled: false },
      ),
      ctx,
    );
    handleCreate(createArgs("Active Agent", "p", { type: "interval", intervalMs: 60_000 }), ctx);
    // Stamp non-default sources directly — bypasses the tool input contract,
    // which is the right shape for this test (filtering, not authoring).
    const defs = ctx.definitions();
    defs.get("active-operator")!.source = "user";
    ctx.save(defs);
  }

  test("filter enabled: true", () => {
    const ctx = makeCtx();
    seedTasks(ctx);

    const result = handleList({ enabled: true }, ctx) as {
      tasks: Array<{ enabled: boolean }>;
      total: number;
    };
    expect(result.total).toBe(2);
    expect(result.tasks.every((a) => a.enabled)).toBe(true);
  });

  // A definition written before a source value left the union still loads: the
  // store parses without validating and the projection passes the string
  // through. The CHANGELOG promises this, so it is pinned here rather than
  // resting on the absence of a validation pass nobody has added yet.
  test("a definition whose source is outside the union still lists", () => {
    const ctx = makeCtx();
    seedTasks(ctx);
    const defs = ctx.definitions();
    defs.get("active-agent")!.source = "retired-source" as never;
    ctx.save(defs);

    const result = handleList({}, ctx) as {
      tasks: Array<{ id: string; source: string }>;
      total: number;
    };
    expect(result.total).toBe(3);
    expect(result.tasks.find((a) => a.id === "active-agent")?.source).toBe("retired-source");
  });

  test("filter source: user", () => {
    const ctx = makeCtx();
    seedTasks(ctx);

    const result = handleList({ source: "user" }, ctx) as {
      tasks: Array<{ source: string }>;
      total: number;
    };
    expect(result.total).toBe(1);
    expect(result.tasks[0]!.source).toBe("user");
  });

  test("filter enabled: false", () => {
    const ctx = makeCtx();
    seedTasks(ctx);

    const result = handleList({ enabled: false }, ctx) as {
      tasks: Array<{ enabled: boolean }>;
      total: number;
    };
    expect(result.total).toBe(1);
    expect(result.tasks[0]!.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// status tool
// ---------------------------------------------------------------------------

describe("handleStatus", () => {
  test("returns task with recent runs (newest first)", () => {
    const ctx = makeCtx();
    handleCreate(createArgs("Status Test", "p", { type: "interval", intervalMs: 60_000 }), ctx);

    // Seed some runs
    const runs = [
      makeRun({
        taskId: "status-test",
        startedAt: "2025-06-15T10:00:00.000Z",
        status: "success",
      }),
      makeRun({
        taskId: "status-test",
        startedAt: "2025-06-15T11:00:00.000Z",
        status: "failure",
        error: "something broke",
      }),
      makeRun({
        taskId: "status-test",
        startedAt: "2025-06-15T12:00:00.000Z",
        status: "success",
      }),
    ];
    for (const run of runs) {
      seedRun("status-test", run);
    }

    const result = handleStatus({ name: "Status Test", limit: 5 }, ctx) as {
      task: Task & { scheduleHuman: string };
      recentRuns: TaskRun[];
    };

    expect(result.task.id).toBe("status-test");
    expect(result.task.scheduleHuman).toBe("Every 1 minute");
    expect(result.recentRuns.length).toBe(3);
    // Newest first
    expect(result.recentRuns[0]!.startedAt).toBe("2025-06-15T12:00:00.000Z");
    expect(result.recentRuns[2]!.startedAt).toBe("2025-06-15T10:00:00.000Z");
  });

  test("throws for nonexistent task", () => {
    const ctx = makeCtx();
    expect(() => handleStatus({ name: "Nope" }, ctx)).toThrow("Task not found");
  });
});

// ---------------------------------------------------------------------------
// runs tool
// ---------------------------------------------------------------------------

describe("handleRuns", () => {
  test("filters by status", () => {
    const ctx = makeCtx();
    handleCreate(createArgs("Run Filter Test", "p", { type: "interval", intervalMs: 60_000 }), ctx);

    seedRun(
      "run-filter-test",
      makeRun({
        taskId: "run-filter-test",
        status: "success",
        startedAt: "2025-06-15T10:00:00.000Z",
      }),
    );
    seedRun(
      "run-filter-test",
      makeRun({
        taskId: "run-filter-test",
        status: "failure",
        error: "oops",
        startedAt: "2025-06-15T11:00:00.000Z",
      }),
    );
    seedRun(
      "run-filter-test",
      makeRun({
        taskId: "run-filter-test",
        status: "success",
        startedAt: "2025-06-15T12:00:00.000Z",
      }),
    );

    const result = handleRuns({ taskId: "run-filter-test", status: "failure" }, ctx) as {
      runs: TaskRun[];
      total: number;
    };

    expect(result.total).toBe(1);
    expect(result.runs[0]!.status).toBe("failure");
  });

  test("queries across all tasks", () => {
    const ctx = makeCtx();
    handleCreate(createArgs("A", "p", { type: "interval", intervalMs: 60_000 }), ctx);
    handleCreate(createArgs("B", "p", { type: "interval", intervalMs: 60_000 }), ctx);

    seedRun("a", makeRun({ taskId: "a", startedAt: "2025-06-15T10:00:00.000Z" }));
    seedRun("b", makeRun({ taskId: "b", startedAt: "2025-06-15T11:00:00.000Z" }));

    const result = handleRuns({}, ctx) as { runs: TaskRun[]; total: number };
    expect(result.total).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// run tool
// ---------------------------------------------------------------------------

describe("handleRun", () => {
  test("triggers immediate execution and returns result", async () => {
    const ctx = makeCtx();
    handleCreate(createArgs("Immediate", "Run now", { type: "interval", intervalMs: 60_000 }), ctx);

    const result = await handleRun({ taskId: "Immediate" }, ctx);

    // Narrow the discriminated union explicitly. `as { run }` is the
    // anti-pattern that masked the dispatched-envelope branch — see
    // `TasksRunOutput` in src/platform/schemas/tasks.ts.
    if (!("run" in result)) {
      throw new Error(`expected sync run shape, got ${JSON.stringify(result)}`);
    }
    expect(result.run.taskId).toBe("immediate");
    expect(result.run.status).toBe("success");
  });

  test("runs a disabled task and says it is disabled", async () => {
    const ctx = makeCtx();
    handleCreate(
      createArgs("Paused", "Run now", { type: "interval", intervalMs: 60_000 }, { enabled: false }),
      ctx,
    );

    const result = await handleRun({ taskId: "Paused" }, ctx);

    if (!("run" in result)) {
      throw new Error(`expected sync run shape, got ${JSON.stringify(result)}`);
    }
    expect(result.run.status).toBe("success");
    expect(result.enabled).toBe(false);
    expect(result.message).toContain("is disabled");
  });

  test("an enabled task's run carries no disabled message", async () => {
    const ctx = makeCtx();
    handleCreate(createArgs("Live", "Run now", { type: "interval", intervalMs: 60_000 }), ctx);

    const result = await handleRun({ taskId: "Live" }, ctx);

    if (!("run" in result)) {
      throw new Error(`expected sync run shape, got ${JSON.stringify(result)}`);
    }
    expect(result.enabled).toBe(true);
    expect(result.message).toBeUndefined();
  });

  test("reports enabled as it stands after the run, when the run disabled it", async () => {
    // A run that trips the failure auto-disable or the token budget leaves
    // the task disabled; the response must say so.
    const base = makeCtx();
    const ctx = makeCtx({
      runNow: (id) => {
        const ticket = base.runNow(id);
        const defs = loadDefs();
        defs.get(id)!.enabled = false;
        saveDefs(defs);
        return ticket;
      },
    });
    handleCreate(createArgs("Trips", "p", { type: "interval", intervalMs: 60_000 }), ctx);

    const result = await handleRun({ taskId: "Trips" }, ctx);

    if (!("run" in result)) {
      throw new Error(`expected sync run shape, got ${JSON.stringify(result)}`);
    }
    expect(result.enabled).toBe(false);
    expect(result.message).toContain("is disabled");
  });

  test("a disabled task's dispatched envelope says it is disabled", async () => {
    let resolveRun: ((value: TaskRun) => void) | undefined;
    const runPromise = new Promise<TaskRun>((resolve) => {
      resolveRun = resolve;
    });
    const slowCtx = makeCtx({
      handleRunSyncWaitMs: 20,
      runNow: () => ({ state: "started", run: runPromise }),
    });
    handleCreate(
      createArgs("Slow paused", "p", { type: "interval", intervalMs: 60_000 }, { enabled: false }),
      slowCtx,
    );

    try {
      const result = await handleRun({ taskId: "Slow paused" }, slowCtx);
      if (!("status" in result)) {
        throw new Error(`expected dispatched envelope, got ${JSON.stringify(result)}`);
      }
      expect(result.enabled).toBe(false);
      expect(result.message).toContain("still running");
      expect(result.message).toContain("is disabled");
    } finally {
      resolveRun?.(makeRun());
    }
  });

  test("throws for nonexistent task", async () => {
    const ctx = makeCtx();
    await expect(handleRun({ taskId: "Nope" }, ctx)).rejects.toThrow("Task not found");
  });

  test("returns 'dispatched' envelope when run outlasts the sync-wait window", async () => {
    // Regression for the production failure where `tasks__run` on a
    // multi-minute task collided with the SDK's 60s MCP request
    // timeout and surfaced to the agent as a false -32001 failure. With
    // the bounded sync-wait, long-running calls return a dispatched
    // envelope instead of hanging the request.
    //
    // The runNow mock returns a promise we control explicitly so the
    // test cleans up its own timer instead of leaving a long setTimeout
    // pending past the assertion. Pattern matters — copy-pasted tests
    // with leaked timers add up.
    let resolveRun: ((value: TaskRun) => void) | undefined;
    const runPromise = new Promise<TaskRun>((resolve) => {
      resolveRun = resolve;
    });
    const slowCtx = makeCtx({
      handleRunSyncWaitMs: 20,
      runNow: () => ({ state: "started", run: runPromise }),
    });
    handleCreate(
      createArgs("Slow", "Takes forever", { type: "interval", intervalMs: 60_000 }),
      slowCtx,
    );

    try {
      const result = await handleRun({ taskId: "Slow" }, slowCtx);

      // Narrow to the "dispatched" branch of the union — if the
      // handler ever stops emitting this branch (regression to a
      // blocking handleRun), this test fails to compile.
      if (!("status" in result) || result.status !== "dispatched") {
        throw new Error(`expected dispatched envelope, got ${JSON.stringify(result)}`);
      }
      expect(result.taskId).toBe("slow");
      expect(result.enabled).toBe(true);
      expect(Number.isNaN(Date.parse(result.startedAt))).toBe(false);
      // Says the run is still going, and where its result will appear.
      expect(result.message).toContain("still running");
      expect(result.message).toContain("has not failed");
      expect(result.message).toContain("tasks__runs");
      expect(result.message).toContain(result.startedAt);
      expect(result.message).toContain("tasks__run_result");
      expect(result.message).not.toContain("disabled");
    } finally {
      // Drain the pending runNow promise so it doesn't sit live past
      // the test (handleRun no longer awaits it after the sync-wait
      // times out, and Bun's runner doesn't pin the suite on it, but
      // hygiene matters when the file grows).
      resolveRun?.(makeRun());
    }
  });

  test("a run that waits for a slot returns the queued envelope at once", async () => {
    let resolveRun: ((value: TaskRun) => void) | undefined;
    const run = new Promise<TaskRun>((resolve) => {
      resolveRun = resolve;
    });
    const ctx = makeCtx({ runNow: () => ({ state: "queued", position: 3, run }) });
    handleCreate(createArgs("Waits", "p", { type: "interval", intervalMs: 60_000 }), ctx);

    try {
      const result = await handleRun({ taskId: "Waits" }, ctx);
      if (!("status" in result) || result.status !== "queued") {
        throw new Error(`expected queued envelope, got ${JSON.stringify(result)}`);
      }
      expect(result.position).toBe(3);
      expect(result.taskId).toBe("waits");
      expect(result.message).toContain("queued at position 3");
      expect(result.message).toContain("tasks__cancel");
      expect(result.message).toContain(result.queuedAt);
    } finally {
      resolveRun?.(makeRun());
    }
  });

  test("a refused run returns its skipped record and says why", async () => {
    const skipped = makeRun({
      taskId: "refused",
      status: "skipped",
      error: "Already queued (runNow)",
    });
    const ctx = makeCtx({ runNow: () => ({ state: "refused", run: skipped }) });
    handleCreate(createArgs("Refused", "p", { type: "interval", intervalMs: 60_000 }), ctx);

    const result = await handleRun({ taskId: "Refused" }, ctx);
    if (!("run" in result)) throw new Error(`expected run shape, got ${JSON.stringify(result)}`);
    expect(result.run.status).toBe("skipped");
    expect(result.message).toContain("did not run");
    expect(result.message).toContain("Already queued");
  });
});

// ---------------------------------------------------------------------------
// Effective per-run limits reported at write time
// ---------------------------------------------------------------------------

describe("create and update report effective run limits", () => {
  const ceilings = resolveTasksConfig({
    maxRunIterations: 10,
    maxRunInputTokens: 50_000,
    maxRunDurationMs: 60_000,
  });
  const runLimitsOf = (auto: Task) => effectiveRunLimits(auto, ceilings, 25);

  test("create reports caps above the ceiling as clamped", () => {
    const ctx = makeCtx({ runLimitsOf });
    const result = handleCreate(
      createArgs(
        "Greedy",
        "p",
        { type: "interval", intervalMs: 60_000 },
        { maxIterations: 40, maxInputTokens: 900_000, maxRunDurationMs: 300_000 },
      ),
      ctx,
    );
    expect(result.effectiveLimits).toEqual({
      maxIterations: 10,
      maxInputTokens: 50_000,
      maxRunDurationMs: 60_000,
    });
    expect(result.message).toContain("maxIterations 40 is above");
    expect(result.message).toContain("maxInputTokens 900000 is above");
    expect(result.message).toContain("maxRunDurationMs 300000 is above");
    // The definition keeps what the caller asked for; the ceiling applies at run time.
    expect(result.task.maxIterations).toBe(40);
  });

  test("create reports the defaults a task runs under when it sets no caps", () => {
    const result = handleCreate(
      createArgs("Plain", "p", { type: "interval", intervalMs: 60_000 }),
      makeCtx(),
    );
    // No input ceiling is configured, so a run with no cap of its own has none.
    expect(result.effectiveLimits).toEqual({ maxIterations: 25, maxRunDurationMs: 120_000 });
    expect(result.effectiveLimits.maxInputTokens).toBeUndefined();
    expect(result.message).not.toContain("is above");
  });

  test("create reports a configured input ceiling for a task that sets no cap", () => {
    const result = handleCreate(
      createArgs("Bounded", "p", { type: "interval", intervalMs: 60_000 }),
      makeCtx({ runLimitsOf }),
    );
    expect(result.effectiveLimits.maxInputTokens).toBe(50_000);
    expect(result.message).not.toContain("is above");
  });

  test("update reports the clamped value of a patched cap", () => {
    const ctx = makeCtx({ runLimitsOf });
    handleCreate(createArgs("Patched", "p", { type: "interval", intervalMs: 60_000 }), ctx);
    const result = handleUpdate(updateArgs("Patched", { maxIterations: 30 }), ctx);
    expect(result.effectiveLimits.maxIterations).toBe(10);
    expect(result.message).toContain("maxIterations 30 is above");
  });
});

// ---------------------------------------------------------------------------
// Delete preserves run history
// ---------------------------------------------------------------------------

describe("delete preserves run history", () => {
  test("runs still accessible after deletion", () => {
    const ctx = makeCtx();
    handleCreate(createArgs("Deletable", "p", { type: "interval", intervalMs: 60_000 }), ctx);

    seedRun("deletable", makeRun({ taskId: "deletable", status: "success" }));

    handleDelete({ name: "Deletable" }, ctx);

    // Runs still accessible via runs tool
    const result = handleRuns({ taskId: "deletable" }, ctx) as {
      runs: TaskRun[];
      total: number;
    };
    expect(result.total).toBe(1);
    expect(result.runs[0]!.status).toBe("success");
  });
});

// ---------------------------------------------------------------------------
// handleCreate — new fields
// ---------------------------------------------------------------------------

describe("handleCreate — new fields", () => {
  test("stores maxRunDurationMs and tokenBudget", () => {
    const ctx = makeCtx();
    const result = handleCreate(
      createArgs(
        "Budget Test",
        "test",
        { type: "interval", intervalMs: 60_000 },
        {
          maxRunDurationMs: 60_000,
          tokenBudget: { maxInputTokens: 10000, period: "daily" },
        },
      ),
      ctx,
    );

    const auto = result.task as Task;
    expect(auto.maxRunDurationMs).toBe(60_000);
    expect(auto.tokenBudget).toEqual({ maxInputTokens: 10000, period: "daily" });
    expect(auto.cumulativeInputTokens).toBe(0);
    expect(auto.cumulativeOutputTokens).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// handleUpdate — re-enable clears disable state
// ---------------------------------------------------------------------------

describe("handleUpdate — re-enable clears disable state", () => {
  test("enabled=true clears disabledAt, disabledReason, and consecutiveErrors", () => {
    const ctx = makeCtx();
    // Create a task first
    handleCreate(
      createArgs("Disabled Test", "test", { type: "interval", intervalMs: 60_000 }),
      ctx,
    );

    // Simulate auto-disable by writing directly
    const defs = loadDefs();
    const auto = defs.get("disabled-test")!;
    auto.enabled = false;
    auto.disabledAt = new Date().toISOString();
    auto.disabledReason = "Auto-disabled after 10 consecutive failures";
    auto.consecutiveErrors = 10;
    saveDefs(defs);

    // Re-enable
    const result = handleUpdate(updateArgs("Disabled Test", { enabled: true }), ctx);
    const updated = result.task as Task;
    expect(updated.enabled).toBe(true);
    expect(updated.consecutiveErrors).toBe(0);
    expect(updated.disabledAt).toBeUndefined();
    expect(updated.disabledReason).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// handleCancel
// ---------------------------------------------------------------------------

describe("handleCancel", () => {
  test("calls cancelRun and returns result", () => {
    let cancelledId: string | null = null;
    const ctx = makeCtx({
      cancelRun: (id) => {
        cancelledId = id;
        return true;
      },
    });
    handleCreate(
      createArgs("Cancel Target", "test", { type: "interval", intervalMs: 60_000 }),
      ctx,
    );

    const result = handleCancel({ name: "Cancel Target" }, ctx);
    expect(result.cancelled).toBe(true);
    expect(cancelledId).toBe("cancel-target");
  });

  test("throws for non-existent task", () => {
    const ctx = makeCtx();
    expect(() => handleCancel({ name: "Nonexistent" }, ctx)).toThrow("not found");
  });
});

// ---------------------------------------------------------------------------
// handleList — includes disable info
// ---------------------------------------------------------------------------

describe("handleList — disable info", () => {
  test("includes disabledReason when auto-disabled", () => {
    const ctx = makeCtx();
    handleCreate(
      createArgs("List Disabled", "test", { type: "interval", intervalMs: 60_000 }),
      ctx,
    );

    // Simulate auto-disable
    const defs = loadDefs();
    const auto = defs.get("list-disabled")!;
    auto.enabled = false;
    auto.disabledAt = new Date().toISOString();
    auto.disabledReason = "Token budget exceeded";
    saveDefs(defs);

    const result = handleList({}, ctx);
    const tasks = result.tasks;
    const entry = tasks.find((a) => a.id === "list-disabled")!;
    expect(entry.disabledReason).toBe("Token budget exceeded");
  });
});

// ---------------------------------------------------------------------------
// validateTaskFields
// ---------------------------------------------------------------------------

describe("validateTaskFields", () => {
  test("rejects intervalMs below 60000", () => {
    expect(() =>
      validateTaskFields({
        schedule: { type: "interval", intervalMs: 30_000 },
      }),
    ).toThrow("at least 1 minute");
  });

  test("accepts intervalMs at 60000", () => {
    expect(() =>
      validateTaskFields({
        schedule: { type: "interval", intervalMs: 60_000 },
      }),
    ).not.toThrow();
  });

  test("rejects interval type without intervalMs", () => {
    expect(() =>
      validateTaskFields({
        schedule: { type: "interval" },
      }),
    ).toThrow("intervalMs is required");
  });

  test("rejects cron type without expression", () => {
    expect(() =>
      validateTaskFields({
        schedule: { type: "cron" },
      }),
    ).toThrow("expression is required");
  });

  test("rejects invalid cron expression", () => {
    expect(() =>
      validateTaskFields({
        schedule: { type: "cron", expression: "not a cron" },
      }),
    ).toThrow("Invalid cron expression");
  });

  test("accepts valid cron expression", () => {
    expect(() =>
      validateTaskFields({
        schedule: { type: "cron", expression: "0 8 * * *" },
      }),
    ).not.toThrow();
  });

  test("rejects maxIterations below 1", () => {
    expect(() => validateTaskFields({ maxIterations: 0 })).toThrow("between 1 and 50");
  });

  test("rejects maxIterations above 50", () => {
    expect(() => validateTaskFields({ maxIterations: 51 })).toThrow("between 1 and 50");
  });

  test("accepts maxIterations at the 50 cap", () => {
    expect(() => validateTaskFields({ maxIterations: 50 })).not.toThrow();
  });

  test("accepts maxIterations at 25", () => {
    expect(() => validateTaskFields({ maxIterations: 25 })).not.toThrow();
  });

  test("rejects maxInputTokens below 1000", () => {
    expect(() => validateTaskFields({ maxInputTokens: 500 })).toThrow(
      "between 1,000 and 1,000,000",
    );
  });

  test("accepts maxInputTokens at 200000", () => {
    expect(() => validateTaskFields({ maxInputTokens: 200_000 })).not.toThrow();
  });

  test("rejects maxRunDurationMs below 10000", () => {
    expect(() => validateTaskFields({ maxRunDurationMs: 5_000 })).toThrow(
      "between 10 seconds and 10 minutes",
    );
  });

  test("accepts maxRunDurationMs at 120000", () => {
    expect(() => validateTaskFields({ maxRunDurationMs: 120_000 })).not.toThrow();
  });

  test("passes with no validation-relevant fields", () => {
    expect(() => validateTaskFields({})).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// handleCreate — validation integration
// ---------------------------------------------------------------------------

describe("handleCreate — validation", () => {
  test("rejects creation with invalid intervalMs", () => {
    const ctx = makeCtx();
    expect(() =>
      handleCreate(
        createArgs("Bad Interval", "test", { type: "interval", intervalMs: 10_000 }),
        ctx,
      ),
    ).toThrow("at least 1 minute");
  });

  test("rejects creation with invalid cron", () => {
    const ctx = makeCtx();
    expect(() =>
      handleCreate(createArgs("Bad Cron", "test", { type: "cron", expression: "nope" }), ctx),
    ).toThrow("Invalid cron");
  });

  test("rejects creation with a cron that matches no date", () => {
    const ctx = makeCtx();
    expect(() =>
      handleCreate(
        createArgs("February 31", "test", { type: "cron", expression: "0 9 31 2 *" }),
        ctx,
      ),
    ).toThrow("matches no future date");
  });

  test("rejects creation with a cron whose year has passed", () => {
    const ctx = makeCtx();
    expect(() =>
      handleCreate(
        createArgs("Past Year", "test", { type: "cron", expression: "0 0 9 1 1 * 2020" }),
        ctx,
      ),
    ).toThrow("matches no future date");
  });

  test("rejects creation with an unknown timezone", () => {
    const ctx = makeCtx();
    expect(() =>
      handleCreate(
        createArgs("Bad Zone", "test", {
          type: "cron",
          expression: "0 9 * * *",
          timezone: "Bogus/Zone",
        }),
        ctx,
      ),
    ).toThrow("Invalid cron expression");
  });
});

// ---------------------------------------------------------------------------
// handleUpdate — validation integration
// ---------------------------------------------------------------------------

describe("handleUpdate — validation", () => {
  test("rejects update with invalid intervalMs", () => {
    const ctx = makeCtx();
    handleCreate(
      createArgs("Update Target", "test", { type: "interval", intervalMs: 60_000 }),
      ctx,
    );

    expect(() =>
      handleUpdate(
        updateArgs("Update Target", {
          schedule: { type: "interval", intervalMs: 5_000 },
        }),
        ctx,
      ),
    ).toThrow("at least 1 minute");
  });

  test("rejects update to a cron that matches no date", () => {
    const ctx = makeCtx();
    handleCreate(
      createArgs("Update To Feb 31", "test", { type: "cron", expression: "0 9 * * *" }),
      ctx,
    );

    expect(() =>
      handleUpdate(
        updateArgs("Update To Feb 31", {
          schedule: { type: "cron", expression: "0 9 31 2 *" },
        }),
        ctx,
      ),
    ).toThrow("matches no future date");
  });

  test("accepts valid schedule update", () => {
    const ctx = makeCtx();
    handleCreate(
      createArgs("Update Target Valid", "test", { type: "interval", intervalMs: 60_000 }),
      ctx,
    );

    const result = handleUpdate(
      updateArgs("Update Target Valid", {
        schedule: { type: "cron", expression: "0 9 * * 1" },
      }),
      ctx,
    );
    expect(result.updated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Task ownership (ownerId / workspaceId)
// ---------------------------------------------------------------------------

describe("task ownership", () => {
  test("handleCreate sets ownerId from context", () => {
    const ctx = makeCtx({ currentUserId: "usr_alice" });
    const result = handleCreate(
      createArgs("Owned Task", "do something", {
        type: "interval",
        intervalMs: 60_000,
      }),
      ctx,
    );

    expect(result.created).toBe(true);
    expect(result.task.ownerId).toBe("usr_alice");
  });

  test("handleCreate sets workspaceId from context", () => {
    const ctx = makeCtx({ currentWorkspaceId: "ws_0030a37f450693bf" });
    const result = handleCreate(
      createArgs("Workspace Task", "do something", {
        type: "interval",
        intervalMs: 60_000,
      }),
      ctx,
    );

    expect(result.created).toBe(true);
    expect(result.task.workspaceId).toBe("ws_0030a37f450693bf");
  });

  test("handleCreate sets both ownerId and workspaceId", () => {
    const ctx = makeCtx({
      currentUserId: "usr_bob",
      currentWorkspaceId: "ws_0055880db5dd7ef1",
    });
    const result = handleCreate(
      createArgs("Full Context Task", "do something", {
        type: "cron",
        expression: "0 9 * * *",
      }),
      ctx,
    );

    expect(result.created).toBe(true);
    expect(result.task.ownerId).toBe("usr_bob");
    expect(result.task.workspaceId).toBe("ws_0055880db5dd7ef1");
  });

  test("create without an explicit context still binds owner+workspace from the store path", () => {
    // Tasks are workspace-owned: even when the create context carries no
    // currentUserId/currentWorkspaceId, the save path stamps the binding from
    // the dir the task is written to (the path is the wall).
    const ctx = makeCtx(); // no currentUserId or currentWorkspaceId
    const result = handleCreate(
      createArgs("Legacy Task", "do something", {
        type: "interval",
        intervalMs: 120_000,
      }),
      ctx,
    );

    expect(result.created).toBe(true);
    expect(result.task.ownerId).toBe(OWNER);
    expect(result.task.workspaceId).toBe(WS);
  });
});

// ---------------------------------------------------------------------------
// event schedules
// ---------------------------------------------------------------------------

describe("event schedules", () => {
  const match = { source: "precision-outbound", name: "reply.*" };

  test("format as the notifications they wait for", () => {
    expect(formatSchedule({ type: "event", match })).toBe(
      "On notifications from precision-outbound, matching reply.*",
    );
    expect(formatSchedule({ type: "event", match: { level: "urgent" } })).toBe(
      "On notifications at urgent or above",
    );
    expect(formatSchedule({ type: "event", match: {} })).toBe("On any routed notification");
  });

  // How often it fires is a property of the connector, not of the definition,
  // so a per-day cost figure would be a number nothing supports.
  test("estimate no runs per day", () => {
    expect(estimateRunsPerDay({ type: "event", match })).toBe(0);
  });

  test("require a match", () => {
    expect(() => validateTaskFields({ schedule: { type: "event" } })).toThrow(/match is required/);
    expect(() => validateTaskFields({ schedule: { type: "event", match } })).not.toThrow();
  });

  test("bound the debounce window on both sides", () => {
    expect(() =>
      validateTaskFields({ schedule: { type: "event", match, debounceMs: 500 } }),
    ).toThrow(/debounceMs/);
    expect(() =>
      validateTaskFields({ schedule: { type: "event", match, debounceMs: 900_001 } }),
    ).toThrow(/debounceMs/);
    expect(() =>
      validateTaskFields({ schedule: { type: "event", match, debounceMs: 60_000 } }),
    ).not.toThrow();
  });

  test("bound the fire ceiling on both sides, and require a whole number", () => {
    for (const maxFiresPerHour of [0, 61, 2.5]) {
      expect(() =>
        validateTaskFields({ schedule: { type: "event", match, maxFiresPerHour } }),
      ).toThrow(/maxFiresPerHour/);
    }
    expect(() =>
      validateTaskFields({ schedule: { type: "event", match, maxFiresPerHour: 6 } }),
    ).not.toThrow();
  });

  test("are created and read back through the tool surface", async () => {
    const ctx = makeCtx();
    const created = await handleCreate(
      {
        manifest: {
          name: "Reply triage",
          schedule: { type: "event", match, debounceMs: 60_000, maxFiresPerHour: 6 },
        },
        body: "Triage the replies in the event block.",
      },
      ctx,
    );
    expect(created.created).toBe(true);

    const status = await handleStatus({ name: "Reply triage" }, ctx);
    expect(status.task.schedule).toEqual({
      type: "event",
      match,
      debounceMs: 60_000,
      maxFiresPerHour: 6,
    });
    expect(status.task.scheduleHuman).toBe(
      "On notifications from precision-outbound, matching reply.*",
    );
    expect(status.task.nextRunAt).toBeUndefined();
    expect(status.task.estimatedCostPerDay).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// handleRun — inline one-offs, input, idempotency (the call without a task)
// ---------------------------------------------------------------------------

describe("handleRun — inline one-offs, input, idempotency", () => {
  test("hands the scheduler a minted run id with the input and key", async () => {
    const seen: Array<{ id: string; requested: unknown }> = [];
    const base = makeCtx();
    const ctx = makeCtx({
      runNow: (id, requested) => {
        seen.push({ id, requested });
        return base.runNow(id);
      },
    });
    handleCreate(createArgs("Typed", "p", { type: "interval", intervalMs: 60_000 }), ctx);

    await handleRun({ taskId: "Typed", input: { n: 1 }, idempotencyKey: "k-1" }, ctx);

    const requested = seen[0]?.requested as {
      runId: string;
      input: unknown;
      idempotencyKey: string;
    };
    expect(requested.runId).toMatch(/^run_[0-9a-f]{12}$/);
    expect(requested.input).toEqual({ n: 1 });
    expect(requested.idempotencyKey).toBe("k-1");
  });

  test("an inline definition creates a oneoff task with no schedule", async () => {
    const ctx = makeCtx({ currentUserId: OWNER, currentWorkspaceId: WS });
    const result = await handleRun({ prompt: "Summarize the input.", input: "text" }, ctx);
    if (!("run" in result)) throw new Error(`expected a run, got ${JSON.stringify(result)}`);

    const oneoff = loadDefs().get(result.run.taskId);
    expect(oneoff?.kind).toBe("oneoff");
    expect(oneoff?.schedule).toBeUndefined();
    expect(oneoff?.prompt).toBe("Summarize the input.");
    // Left out of the default list, which holds saved tasks.
    expect(handleList({}, ctx).tasks).toHaveLength(0);
  });

  test("refuses both a name and an inline definition", async () => {
    const ctx = makeCtx();
    handleCreate(createArgs("Saved", "p", { type: "interval", intervalMs: 60_000 }), ctx);
    await expect(handleRun({ taskId: "Saved", prompt: "other" }, ctx)).rejects.toThrow("not both");
  });

  test("refuses a call with neither a name nor a prompt or skill", async () => {
    await expect(handleRun({ input: { a: 1 } }, makeCtx())).rejects.toThrow("needs `taskId`");
  });

  test("refuses an inline outputSchema that is not a JSON Schema", async () => {
    await expect(
      handleRun({ prompt: "p", outputSchema: { type: "no-such-type" } }, makeCtx()),
    ).rejects.toThrow("outputSchema is not a valid JSON Schema");
  });

  test("refuses an input over the size limit", async () => {
    const ctx = makeCtx();
    handleCreate(createArgs("Big", "p", { type: "interval", intervalMs: 60_000 }), ctx);
    await expect(handleRun({ taskId: "Big", input: "x".repeat(70 * 1024) }, ctx)).rejects.toThrow(
      "at most",
    );
  });

  test("a task with an inputSchema refuses a run with no input", async () => {
    const ctx = makeCtx();
    handleCreate(
      createArgs(
        "Needs input",
        "p",
        { type: "interval", intervalMs: 60_000 },
        {
          inputSchema: { type: "object", required: ["url"] },
        },
      ),
      ctx,
    );
    await expect(handleRun({ taskId: "Needs input" }, ctx)).rejects.toThrow("none was given");
  });

  test("a repeated idempotency key returns the earlier run without asking for another", async () => {
    let asked = 0;
    const existing = makeRun({ taskId: "keyed", status: "success", idempotencyKey: "k" });
    const ctx = makeCtx({
      runNow: () => {
        asked++;
        return null;
      },
      findRunByKey: (id, key) =>
        id === "keyed" && key === "k"
          ? {
              runId: existing.id,
              taskId: "keyed",
              requestedAt: existing.startedAt,
              run: existing,
            }
          : null,
    });
    handleCreate(createArgs("Keyed", "p", { type: "interval", intervalMs: 60_000 }), ctx);

    const result = await handleRun({ taskId: "Keyed", idempotencyKey: "k" }, ctx);
    if (!("run" in result)) throw new Error(`expected a run, got ${JSON.stringify(result)}`);
    expect(result.run.id).toBe(existing.id);
    expect(result.message).toContain("idempotencyKey");
    expect(asked).toBe(0);
  });
});

describe("create and update — input and output schemas", () => {
  test("create keeps both schemas on the task", () => {
    const ctx = makeCtx();
    const inputSchema = { type: "object", properties: { url: { type: "string" } } };
    const outputSchema = { type: "array", items: { type: "string" } };
    const { task } = handleCreate(
      createArgs(
        "Schemas",
        "p",
        { type: "interval", intervalMs: 60_000 },
        {
          inputSchema,
          outputSchema,
        },
      ),
      ctx,
    );
    expect(task.inputSchema).toEqual(inputSchema);
    expect(task.outputSchema).toEqual(outputSchema);
  });

  test("create refuses a schema that does not compile", () => {
    expect(() =>
      handleCreate(
        createArgs(
          "Bad schema",
          "p",
          { type: "interval", intervalMs: 60_000 },
          {
            inputSchema: { type: 12 },
          },
        ),
        makeCtx(),
      ),
    ).toThrow("inputSchema is not a valid JSON Schema");
  });

  test("update with null removes a schema", () => {
    const ctx = makeCtx();
    handleCreate(
      createArgs(
        "Clearable",
        "p",
        { type: "interval", intervalMs: 60_000 },
        {
          outputSchema: { type: "object" },
        },
      ),
      ctx,
    );
    const { task } = handleUpdate(updateArgs("Clearable", { outputSchema: null }), ctx);
    expect(task.outputSchema).toBeUndefined();
    expect("outputSchema" in (loadDefs().get("clearable") ?? {})).toBe(false);
  });
});
