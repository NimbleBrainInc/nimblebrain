import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  taskArchivedRunResultPath,
  taskFilePath,
  taskRunIndexPath,
  taskRunResultPath,
  taskRunSegmentPath,
  taskRunsDir,
  workspaceTasksDir,
} from "../../../../src/platform/tasks/paths.ts";
import {
  appendRun,
  deleteTask,
  deleteTaskDefinition,
  listRunSegmentMonths,
  loadAllTasks,
  loadOwnerTasks,
  loadTask,
  MAX_RUN_LINES,
  readAllRuns,
  readRunResult,
  readRuns,
  readRunsPage,
  saveRunResult,
  saveTask,
} from "../../../../src/platform/tasks/store.ts";
import type { Task, TaskRun, TaskRunResult } from "../../../../src/platform/tasks/types.ts";
import { seedWorkspaceRoot } from "../../../helpers/test-workspace.ts";

const TMP_DIR = join(import.meta.dir, ".tmp-task-store");
const WS = "ws_0076759dbbe19fcc";
const OWNER = "usr_test";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "test-auto",
    name: "Test Task",
    prompt: "Do something",
    schedule: { type: "interval", intervalMs: 60_000 },
    enabled: true,
    source: "user",
    workspaceId: WS,
    ownerId: OWNER,
    createdAt: "2025-06-01T00:00:00.000Z",
    updatedAt: "2025-06-01T00:00:00.000Z",
    runCount: 0,
    consecutiveErrors: 0,
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    ...overrides,
  };
}

function makeRun(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: `run_${Math.random().toString(36).slice(2, 14)}`,
    taskId: "test-auto",
    startedAt: new Date().toISOString(),
    status: "success",
    inputTokens: 100,
    outputTokens: 50,
    toolCalls: 2,
    iterations: 1,
    ...overrides,
  };
}

function makeResult(overrides: Partial<TaskRunResult> = {}): TaskRunResult {
  return {
    runId: "run_abcdef012345",
    taskId: "test-auto",
    completedAt: new Date().toISOString(),
    output: "The full deliverable.",
    activityLog: [{ id: "t1", name: "files__create", input: {}, output: "{}", ok: true, ms: 12 }],
    outputFiles: [],
    usage: { inputTokens: 100, outputTokens: 50, iterations: 1 },
    stopReason: "complete",
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
// Definitions: per-task save + load round-trip
// ---------------------------------------------------------------------------

describe("definitions", () => {
  test("loadOwnerTasks returns empty map when dir is missing", () => {
    const map = loadOwnerTasks(TMP_DIR, WS, OWNER);
    expect(map.size).toBe(0);
  });

  test("save then load round-trips per task", () => {
    const auto1 = makeTask({ id: "a1", name: "First" });
    const auto2 = makeTask({ id: "a2", name: "Second" });

    saveTask(TMP_DIR, WS, OWNER, auto1);
    saveTask(TMP_DIR, WS, OWNER, auto2);

    const loaded = loadOwnerTasks(TMP_DIR, WS, OWNER);
    expect(loaded.size).toBe(2);
    expect(loaded.get("a1")!.name).toBe("First");
    expect(loaded.get("a2")!.name).toBe("Second");
    expect(loaded.get("a1")!.prompt).toBe("Do something");
  });

  test("each task lives in its own <id>.json file", () => {
    saveTask(TMP_DIR, WS, OWNER, makeTask({ id: "a1" }));
    expect(existsSync(taskFilePath(TMP_DIR, WS, OWNER, "a1"))).toBe(true);
  });

  test("loadTask reads a single task, null when missing", () => {
    saveTask(TMP_DIR, WS, OWNER, makeTask({ id: "a1", name: "Solo" }));
    expect(loadTask(TMP_DIR, WS, OWNER, "a1")!.name).toBe("Solo");
    expect(loadTask(TMP_DIR, WS, OWNER, "missing")).toBeNull();
  });

  test("atomic write uses temp+rename (no leftover .tmp files)", () => {
    saveTask(TMP_DIR, WS, OWNER, makeTask({ id: "a1" }));
    const dir = workspaceTasksDir(TMP_DIR, WS, OWNER);
    const tmpFiles = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    expect(tmpFiles.length).toBe(0);
  });

  test("deleteTask removes the file and its runs dir", () => {
    saveTask(TMP_DIR, WS, OWNER, makeTask({ id: "a1" }));
    appendRun(TMP_DIR, WS, OWNER, "a1", makeRun({ taskId: "a1" }));
    expect(existsSync(taskFilePath(TMP_DIR, WS, OWNER, "a1"))).toBe(true);
    expect(existsSync(taskRunsDir(TMP_DIR, WS, OWNER, "a1"))).toBe(true);

    deleteTask(TMP_DIR, WS, OWNER, "a1");
    expect(existsSync(taskFilePath(TMP_DIR, WS, OWNER, "a1"))).toBe(false);
    expect(existsSync(taskRunsDir(TMP_DIR, WS, OWNER, "a1"))).toBe(false);
  });

  test("deleteTaskDefinition removes the file but preserves run history", () => {
    saveTask(TMP_DIR, WS, OWNER, makeTask({ id: "a1" }));
    appendRun(TMP_DIR, WS, OWNER, "a1", makeRun({ taskId: "a1" }));

    deleteTaskDefinition(TMP_DIR, WS, OWNER, "a1");
    expect(existsSync(taskFilePath(TMP_DIR, WS, OWNER, "a1"))).toBe(false);
    // Run history (audit trail) outlives the definition.
    expect(readRuns(TMP_DIR, WS, OWNER, "a1").length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// loadAllTasks: cross-workspace scan + backfill from path
// ---------------------------------------------------------------------------

describe("loadAllTasks", () => {
  test("loads tasks across workspaces and owners", () => {
    seedWorkspaceRoot(TMP_DIR, "ws_00079598e311c160");
    seedWorkspaceRoot(TMP_DIR, "ws_001c32f121060ff3");
    saveTask(
      TMP_DIR,
      "ws_00079598e311c160",
      "usr_1",
      makeTask({ id: "x", workspaceId: "ws_00079598e311c160", ownerId: "usr_1" }),
    );
    saveTask(
      TMP_DIR,
      "ws_00079598e311c160",
      "usr_2",
      makeTask({ id: "y", workspaceId: "ws_00079598e311c160", ownerId: "usr_2" }),
    );
    saveTask(
      TMP_DIR,
      "ws_001c32f121060ff3",
      "usr_1",
      makeTask({ id: "z", workspaceId: "ws_001c32f121060ff3", ownerId: "usr_1" }),
    );

    const all = loadAllTasks(TMP_DIR);
    expect(all.length).toBe(3);
    expect(all.map((a) => a.id).sort()).toEqual(["x", "y", "z"]);
  });

  test("backfills workspaceId/ownerId from the path when missing on the record", () => {
    // Persist a record that lacks the binding fields; the dir is authoritative.
    seedWorkspaceRoot(TMP_DIR, "ws_005d531fe273e796");
    const bare = makeTask({ id: "bare" });
    bare.workspaceId = undefined;
    bare.ownerId = undefined;
    saveTask(TMP_DIR, "ws_005d531fe273e796", "usr_path", bare);

    const all = loadAllTasks(TMP_DIR);
    const recovered = all.find((a) => a.id === "bare")!;
    expect(recovered.workspaceId).toBe("ws_005d531fe273e796");
    expect(recovered.ownerId).toBe("usr_path");
  });

  test("returns empty when workspaces root is missing", () => {
    const empty = join(TMP_DIR, "no-workspaces");
    mkdirSync(empty, { recursive: true });
    expect(loadAllTasks(empty)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Runs: append + read
// ---------------------------------------------------------------------------

describe("runs", () => {
  test("append run then read runs returns it", () => {
    appendRun(TMP_DIR, WS, OWNER, "test-auto", makeRun({ id: "run_001", taskId: "test-auto" }));
    const runs = readRuns(TMP_DIR, WS, OWNER, "test-auto");
    expect(runs.length).toBe(1);
    expect(runs[0]!.id).toBe("run_001");
  });

  test("readRuns returns newest first", () => {
    appendRun(
      TMP_DIR,
      WS,
      OWNER,
      "test-auto",
      makeRun({ id: "run_001", startedAt: "2025-06-01T00:00:00.000Z" }),
    );
    appendRun(
      TMP_DIR,
      WS,
      OWNER,
      "test-auto",
      makeRun({ id: "run_002", startedAt: "2025-06-01T01:00:00.000Z" }),
    );

    const runs = readRuns(TMP_DIR, WS, OWNER, "test-auto");
    expect(runs.length).toBe(2);
    expect(runs[0]!.id).toBe("run_002");
    expect(runs[1]!.id).toBe("run_001");
  });

  test("readRuns with missing index returns empty array", () => {
    expect(readRuns(TMP_DIR, WS, OWNER, "nonexistent")).toEqual([]);
  });

  test("missing runs directory is created on first write", () => {
    appendRun(TMP_DIR, WS, OWNER, "test-auto", makeRun({ taskId: "test-auto" }));
    expect(existsSync(taskRunIndexPath(TMP_DIR, WS, OWNER, "test-auto"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Run results (the deliverable sidecar)
// ---------------------------------------------------------------------------

describe("run results", () => {
  test("save then read round-trips the full result", () => {
    const result = makeResult({ runId: "run_abc123def456", taskId: "test-auto" });
    saveRunResult(TMP_DIR, WS, OWNER, "test-auto", result);

    const loaded = readRunResult(TMP_DIR, WS, OWNER, "test-auto", "run_abc123def456");
    expect(loaded).not.toBeNull();
    expect(loaded!.output).toBe("The full deliverable.");
    expect(loaded!.activityLog.length).toBe(1);
    expect(loaded!.usage.iterations).toBe(1);
  });

  test("readRunResult returns null for an unknown runId", () => {
    expect(readRunResult(TMP_DIR, WS, OWNER, "test-auto", "run_missing00000")).toBeNull();
  });

  test("readRunResult returns null for an invalid runId (no throw)", () => {
    expect(readRunResult(TMP_DIR, WS, OWNER, "test-auto", "../../etc/passwd")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Rollover
// ---------------------------------------------------------------------------

describe("rollover — history is kept", () => {
  const ID = "roll-test";
  const JAN = Date.parse("2025-01-01T00:00:00Z");

  /** Seed a full hot index: MAX_RUN_LINES runs one second apart from Jan 1. */
  function seedFullIndex(): void {
    mkdirSync(taskRunsDir(TMP_DIR, WS, OWNER, ID), { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < MAX_RUN_LINES; i++) {
      lines.push(
        JSON.stringify(
          makeRun({
            id: `run_${String(i).padStart(4, "0")}`,
            taskId: ID,
            startedAt: new Date(JAN + i * 1000).toISOString(),
          }),
        ),
      );
    }
    writeFileSync(taskRunIndexPath(TMP_DIR, WS, OWNER, ID), `${lines.join("\n")}\n`);
  }

  function append(id: string, startedAt: string): void {
    appendRun(TMP_DIR, WS, OWNER, ID, makeRun({ id, taskId: ID, startedAt }));
  }

  test("moves lines past the hot window into the month segment instead of deleting them", () => {
    seedFullIndex();
    append("run_1000", "2025-02-01T00:00:00.000Z");

    const hot = readFileSync(taskRunIndexPath(TMP_DIR, WS, OWNER, ID), "utf-8")
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l) as TaskRun);
    expect(hot.length).toBe(MAX_RUN_LINES);
    expect(hot.find((r) => r.id === "run_0000")).toBeUndefined();
    expect(hot.find((r) => r.id === "run_1000")).toBeDefined();

    const segment = readFileSync(taskRunSegmentPath(TMP_DIR, WS, OWNER, ID, "2025-01"), "utf-8")
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l) as TaskRun);
    expect(segment.map((r) => r.id)).toEqual(["run_0000"]);
    expect(listRunSegmentMonths(TMP_DIR, WS, OWNER, ID)).toEqual(["2025-01"]);
  });

  test("groups rolled lines by the month each run started in", () => {
    mkdirSync(taskRunsDir(TMP_DIR, WS, OWNER, ID), { recursive: true });
    const lines = [
      makeRun({ id: "run_dec", taskId: ID, startedAt: "2024-12-31T23:59:00.000Z" }),
      makeRun({ id: "run_jan", taskId: ID, startedAt: "2025-01-01T00:01:00.000Z" }),
    ].map((r) => JSON.stringify(r));
    for (let i = 0; i < MAX_RUN_LINES - 1; i++) {
      lines.push(
        JSON.stringify(
          makeRun({ id: `run_f${i}`, taskId: ID, startedAt: "2025-02-02T00:00:00.000Z" }),
        ),
      );
    }
    writeFileSync(taskRunIndexPath(TMP_DIR, WS, OWNER, ID), `${lines.join("\n")}\n`);
    append("run_new", "2025-02-03T00:00:00.000Z");

    expect(listRunSegmentMonths(TMP_DIR, WS, OWNER, ID)).toEqual(["2025-01", "2024-12"]);
    expect(readFileSync(taskRunSegmentPath(TMP_DIR, WS, OWNER, ID, "2024-12"), "utf-8")).toContain(
      "run_dec",
    );
    expect(readFileSync(taskRunSegmentPath(TMP_DIR, WS, OWNER, ID, "2025-01"), "utf-8")).toContain(
      "run_jan",
    );
  });

  test("moves a rolled run's result sidecar into its archive month, and still finds it", () => {
    seedFullIndex();
    saveRunResult(TMP_DIR, WS, OWNER, ID, makeResult({ runId: "run_0000", taskId: ID }));
    saveRunResult(TMP_DIR, WS, OWNER, ID, makeResult({ runId: "run_0999", taskId: ID }));
    append("run_1000", "2025-02-01T00:00:00.000Z");

    expect(existsSync(taskRunResultPath(TMP_DIR, WS, OWNER, ID, "run_0000"))).toBe(false);
    expect(
      existsSync(taskArchivedRunResultPath(TMP_DIR, WS, OWNER, ID, "2025-01", "run_0000")),
    ).toBe(true);
    // A run still in the hot window keeps its sidecar in the hot dir.
    expect(existsSync(taskRunResultPath(TMP_DIR, WS, OWNER, ID, "run_0999"))).toBe(true);
    // run_result reads either place.
    expect(readRunResult(TMP_DIR, WS, OWNER, ID, "run_0000")?.output).toBe("The full deliverable.");
    expect(readRunResult(TMP_DIR, WS, OWNER, ID, "run_0999")?.output).toBe("The full deliverable.");
    expect(readRunResult(TMP_DIR, WS, OWNER, ID, "run_nope")).toBeNull();
  });

  test("the hot runs dir holds only the hot window's sidecars, the index, and archive/", () => {
    seedFullIndex();
    for (let i = 0; i < 20; i++) {
      const runId = `run_${String(i).padStart(4, "0")}`;
      saveRunResult(TMP_DIR, WS, OWNER, ID, makeResult({ runId, taskId: ID }));
    }
    for (let i = 0; i < 20; i++) {
      const runId = `run_y${i}`;
      append(runId, `2025-03-0${(i % 9) + 1}T00:00:00.000Z`);
      saveRunResult(TMP_DIR, WS, OWNER, ID, makeResult({ runId, taskId: ID }));
    }

    const hotIds = new Set(readRuns(TMP_DIR, WS, OWNER, ID).map((r) => r.id));
    const entries = readdirSync(taskRunsDir(TMP_DIR, WS, OWNER, ID));
    for (const name of entries) {
      if (name === "index.jsonl" || name === "archive") continue;
      expect(name.endsWith(".result.json")).toBe(true);
      expect(hotIds.has(name.replace(/\.result\.json$/, ""))).toBe(true);
    }
    expect(entries).toContain("archive");
    expect(readdirSync(join(taskRunsDir(TMP_DIR, WS, OWNER, ID), "archive"))).toEqual(["2025-01"]);
  });

  test("the default read stays on the hot window", () => {
    seedFullIndex();
    for (let i = 0; i < 5; i++) append(`run_x${i}`, `2025-02-0${i + 1}T00:00:00.000Z`);

    const runs = readRuns(TMP_DIR, WS, OWNER, ID);
    expect(runs.length).toBe(MAX_RUN_LINES);
    expect(runs.find((r) => r.id === "run_0000")).toBeUndefined();
    // readAllRuns is bounded the same way.
    expect(readAllRuns(TMP_DIR, WS, OWNER).length).toBe(MAX_RUN_LINES);
  });

  test("a paged read walks back into the segments, a page at a time", () => {
    seedFullIndex();
    for (let i = 0; i < 3; i++) append(`run_x${i}`, `2025-02-0${i + 1}T00:00:00.000Z`);

    // First page: hot only, with a cursor because older runs exist.
    const first = readRunsPage(TMP_DIR, WS, OWNER, ID, { limit: 2 });
    expect(first.runs.map((r) => r.id)).toEqual(["run_x2", "run_x1"]);
    expect(first.nextBefore).toBe("2025-02-02T00:00:00.000Z");

    // Walk every page; every run ever appended comes back exactly once.
    const seen: string[] = [...first.runs.map((r) => r.id)];
    let before = first.nextBefore;
    let pages = 1;
    while (before) {
      const page = readRunsPage(TMP_DIR, WS, OWNER, ID, { limit: 250, before });
      seen.push(...page.runs.map((r) => r.id));
      before = page.nextBefore;
      pages++;
    }
    expect(pages).toBeGreaterThan(2);
    expect(new Set(seen).size).toBe(MAX_RUN_LINES + 3);
    expect(seen).toContain("run_0000");
    expect(seen.at(-1)).toBe("run_0000");
  });

  test("readRuns with `before` reaches a run that is only in a segment", () => {
    seedFullIndex();
    append("run_1000", "2025-02-01T00:00:00.000Z");
    const page = readRuns(TMP_DIR, WS, OWNER, ID, {
      before: new Date(JAN + 1000).toISOString(),
      limit: 5,
    });
    expect(page.map((r) => r.id)).toEqual(["run_0000"]);
  });

  test("a page of newer runs does not read an older segment", () => {
    seedFullIndex();
    for (let i = 0; i < 3; i++) append(`run_x${i}`, `2025-02-0${i + 1}T00:00:00.000Z`);
    // Plant a marker in the January segment that a read would surface at the
    // top of the page. The hot window fills the page with runs newer than
    // anything January can hold, so the walk must stop before reading it.
    writeFileSync(
      taskRunSegmentPath(TMP_DIR, WS, OWNER, ID, "2025-01"),
      `${JSON.stringify(makeRun({ id: "run_planted", startedAt: "2025-02-15T00:00:00.000Z" }))}\n`,
    );
    const page = readRunsPage(TMP_DIR, WS, OWNER, ID, {
      limit: 3,
      before: "2025-03-01T00:00:00.000Z",
    });
    expect(page.runs.map((r) => r.id)).toEqual(["run_x2", "run_x1", "run_x0"]);
    expect(page.nextBefore).toBe(page.runs[2]!.startedAt);
  });
});

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

describe("filters", () => {
  test("limit returns at most N runs", () => {
    for (let i = 0; i < 10; i++) {
      appendRun(
        TMP_DIR,
        WS,
        OWNER,
        "test-auto",
        makeRun({ id: `run_${i}`, startedAt: new Date(Date.now() + i * 1000).toISOString() }),
      );
    }
    expect(readRuns(TMP_DIR, WS, OWNER, "test-auto", { limit: 5 }).length).toBe(5);
  });

  test("status filter returns only matching runs", () => {
    appendRun(TMP_DIR, WS, OWNER, "test-auto", makeRun({ id: "r1", status: "success" }));
    appendRun(TMP_DIR, WS, OWNER, "test-auto", makeRun({ id: "r2", status: "failure" }));
    appendRun(TMP_DIR, WS, OWNER, "test-auto", makeRun({ id: "r3", status: "success" }));
    appendRun(TMP_DIR, WS, OWNER, "test-auto", makeRun({ id: "r4", status: "failure" }));

    const failures = readRuns(TMP_DIR, WS, OWNER, "test-auto", { status: "failure" });
    expect(failures.length).toBe(2);
    expect(failures.every((r) => r.status === "failure")).toBe(true);
  });

  test("since filter returns only runs after timestamp", () => {
    appendRun(
      TMP_DIR,
      WS,
      OWNER,
      "test-auto",
      makeRun({ id: "old", startedAt: "2025-01-01T00:00:00.000Z" }),
    );
    appendRun(
      TMP_DIR,
      WS,
      OWNER,
      "test-auto",
      makeRun({ id: "new", startedAt: "2025-06-01T00:00:00.000Z" }),
    );

    const runs = readRuns(TMP_DIR, WS, OWNER, "test-auto", { since: "2025-03-01T00:00:00.000Z" });
    expect(runs.length).toBe(1);
    expect(runs[0]!.id).toBe("new");
  });
});

// ---------------------------------------------------------------------------
// readAllRuns (across one owner's tasks)
// ---------------------------------------------------------------------------

describe("readAllRuns", () => {
  test("aggregates runs across multiple tasks", () => {
    appendRun(
      TMP_DIR,
      WS,
      OWNER,
      "auto-a",
      makeRun({ id: "ra1", taskId: "auto-a", startedAt: "2025-06-01T00:00:00.000Z" }),
    );
    appendRun(
      TMP_DIR,
      WS,
      OWNER,
      "auto-b",
      makeRun({ id: "rb1", taskId: "auto-b", startedAt: "2025-06-01T01:00:00.000Z" }),
    );
    appendRun(
      TMP_DIR,
      WS,
      OWNER,
      "auto-a",
      makeRun({ id: "ra2", taskId: "auto-a", startedAt: "2025-06-01T02:00:00.000Z" }),
    );

    const all = readAllRuns(TMP_DIR, WS, OWNER);
    expect(all.length).toBe(3);
    expect(all[0]!.id).toBe("ra2");
    expect(all[1]!.id).toBe("rb1");
    expect(all[2]!.id).toBe("ra1");
  });

  test("applies filters across all tasks", () => {
    appendRun(
      TMP_DIR,
      WS,
      OWNER,
      "auto-a",
      makeRun({ id: "ra1", taskId: "auto-a", status: "failure" }),
    );
    appendRun(
      TMP_DIR,
      WS,
      OWNER,
      "auto-b",
      makeRun({ id: "rb1", taskId: "auto-b", status: "success" }),
    );

    const failures = readAllRuns(TMP_DIR, WS, OWNER, { status: "failure" });
    expect(failures.length).toBe(1);
    expect(failures[0]!.id).toBe("ra1");
  });

  test("returns empty when runs directory does not exist", () => {
    expect(readAllRuns(TMP_DIR, WS, "usr_norows")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Task ID validation (path traversal prevention)
// ---------------------------------------------------------------------------

describe("task id validation", () => {
  test("rejects path traversal IDs", () => {
    expect(() => appendRun(TMP_DIR, WS, OWNER, "../../etc/passwd", makeRun())).toThrow(
      /Invalid task id/i,
    );
  });

  test("rejects empty string", () => {
    expect(() => appendRun(TMP_DIR, WS, OWNER, "", makeRun())).toThrow(/Invalid task id/i);
  });

  test("rejects IDs with slashes", () => {
    expect(() => appendRun(TMP_DIR, WS, OWNER, "foo/bar", makeRun())).toThrow(/Invalid task id/i);
  });

  test("rejects IDs with uppercase letters", () => {
    expect(() => appendRun(TMP_DIR, WS, OWNER, "My-Auto", makeRun())).toThrow(/Invalid task id/i);
  });

  test("accepts valid kebab-case task IDs", () => {
    appendRun(TMP_DIR, WS, OWNER, "daily-report", makeRun({ taskId: "daily-report" }));
    expect(readRuns(TMP_DIR, WS, OWNER, "daily-report").length).toBe(1);
  });

  test("accepts task IDs with numbers", () => {
    appendRun(TMP_DIR, WS, OWNER, "report-2025", makeRun({ taskId: "report-2025" }));
    expect(readRuns(TMP_DIR, WS, OWNER, "report-2025").length).toBe(1);
  });

  test("validation applies to readRuns", () => {
    expect(() => readRuns(TMP_DIR, WS, OWNER, "../../etc/passwd")).toThrow(/Invalid task id/i);
  });
});
