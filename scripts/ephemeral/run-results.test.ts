import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { taskRunResultPath } from "../../src/platform/tasks/paths.ts";
import { readRunResult, saveRunResult } from "../../src/platform/tasks/store.ts";
import type { TaskRun } from "../../src/platform/tasks/types.ts";
import { createOnly, liveRuntime, migrate, resultOfLine } from "./run-results.ts";

const WS = "ws_0076759dbbe19fcc";
const OWNER = "usr_test";
const TASK = "digest";

let workDir: string;
const runsDir = () => join(workDir, "workspaces", WS, "tasks", OWNER, "runs", TASK);

function line(id: string, extra: Partial<TaskRun> = {}): TaskRun {
  return {
    id,
    taskId: TASK,
    startedAt: "2026-06-01T00:00:00.000Z",
    completedAt: "2026-06-01T00:01:00.000Z",
    status: "success",
    inputTokens: 10,
    outputTokens: 5,
    toolCalls: 1,
    iterations: 2,
    ...extra,
  };
}

function writeIndex(dir: string, runs: (TaskRun | string)[]): void {
  mkdirSync(dir, { recursive: true });
  const text = runs.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n");
  writeFileSync(join(dir, "index.jsonl"), `${text}\n`);
}

/** Every file under the work dir with its mtime and contents, to show nothing was rewritten. */
function snapshot(dir: string, out = new Map<string, string>()): Map<string, string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) snapshot(p, out);
    else out.set(p, `${statSync(p).mtimeMs}:${readFileSync(p, "utf-8")}`);
  }
  return out;
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "run-results-"));
  mkdirSync(join(workDir, "workspaces", WS), { recursive: true });
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("run-results migration", () => {
  function seed(): void {
    writeIndex(runsDir(), [
      line("run_hot_preview", { resultPreview: "Three prospects found." }),
      line("run_hot_failed", { status: "failure", error: "boom", stopReason: "error" }),
      line("run_1_skip", {
        status: "skipped",
        error: "Previous run still active",
        inputTokens: 0,
        outputTokens: 0,
        iterations: 0,
      }),
      line("run_has_result", { resultPreview: "kept" }),
      line("run_hot_preview"),
      "{not json",
      line("../escape"),
    ]);
    writeIndex(join(runsDir(), "archive", "2026-05"), [
      line("run_archived", { status: "timeout", error: "timed out", resultPreview: "partial" }),
    ]);
    saveRunResult(workDir, WS, OWNER, TASK, {
      ...resultOfLine(TASK, line("run_has_result")),
      output: "the real deliverable",
    });
  }

  test("dry run counts and writes nothing", () => {
    seed();
    const before = snapshot(workDir);
    const counts = migrate(workDir, false);
    expect(counts).toEqual({
      lines: 8,
      unreadable: 1,
      invalidId: 1,
      duplicate: 1,
      hasResult: 1,
      missing: { success: 1, failure: 1, skipped: 1, timeout: 1 },
      withPreview: 2,
      written: 0,
    });
    expect(snapshot(workDir)).toEqual(before);
  });

  test("apply writes each missing result beside its line, in the scheduler's shape", () => {
    seed();
    const counts = migrate(workDir, true);
    expect(counts.written).toBe(4);

    expect(readRunResult(workDir, WS, OWNER, TASK, "run_hot_preview")).toEqual({
      runId: "run_hot_preview",
      taskId: TASK,
      completedAt: "2026-06-01T00:01:00.000Z",
      output: "Three prospects found.",
      activityLog: [],
      outputFiles: [],
      usage: { inputTokens: 10, outputTokens: 5, iterations: 2 },
    });
    expect(readRunResult(workDir, WS, OWNER, TASK, "run_hot_failed")).toMatchObject({
      output: "",
      error: "boom",
      stopReason: "error",
    });
    expect(readRunResult(workDir, WS, OWNER, TASK, "run_1_skip")?.error).toBe(
      "Previous run still active",
    );
    // An archived line's result goes in its month, where the reader looks.
    const archived = join(runsDir(), "archive", "2026-05", "run_archived.result.json");
    expect(JSON.parse(readFileSync(archived, "utf-8")).output).toBe("partial");
    expect(readRunResult(workDir, WS, OWNER, TASK, "run_archived")?.error).toBe("timed out");
    // No temp files left behind.
    expect(readdirSync(runsDir()).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });

  test("never rewrites an existing file, and a re-run writes nothing", () => {
    seed();
    migrate(workDir, true);
    const after = snapshot(workDir);
    expect(readRunResult(workDir, WS, OWNER, TASK, "run_has_result")?.output).toBe(
      "the real deliverable",
    );

    const again = migrate(workDir, true);
    expect(again.written).toBe(0);
    expect(again.missing).toEqual({});
    expect(again.hasResult).toBe(5);
    expect(snapshot(workDir)).toEqual(after);
  });

  test("creating a result never replaces a file already at its path", () => {
    mkdirSync(runsDir(), { recursive: true });
    const target = taskRunResultPath(workDir, WS, OWNER, TASK, "run_race");
    writeFileSync(target, '{"output":"newer"}\n');
    expect(createOnly(target, "{}\n")).toBe(false);
    expect(readFileSync(target, "utf-8")).toBe('{"output":"newer"}\n');
    expect(readdirSync(runsDir())).toEqual(["run_race.result.json"]);
  });

  test("a migrated run reads the same output the preview fallback showed", () => {
    seed();
    const runs = [line("run_hot_preview", { resultPreview: "Three prospects found." })];
    const fallback = (r: TaskRun) =>
      readRunResult(workDir, WS, OWNER, TASK, r.id)?.output ?? r.resultPreview ?? "";
    const before = runs.map(fallback);
    expect(readRunResult(workDir, WS, OWNER, TASK, "run_hot_preview")).toBeNull();

    migrate(workDir, true);
    const reader = (r: TaskRun) => readRunResult(workDir, WS, OWNER, TASK, r.id)?.output;
    expect(runs.map(reader)).toEqual(before);
  });

  test("apply is refused while a runtime answers its health URL", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    try {
      expect(await liveRuntime([`http://127.0.0.1:${server.port}/v1/health`])).toContain(
        "a runtime answers",
      );
    } finally {
      server.stop(true);
    }
    expect(await liveRuntime(["http://127.0.0.1:1/v1/health"])).toBeNull();
  });
});
