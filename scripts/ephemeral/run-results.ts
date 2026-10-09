/**
 * One-off: give every recorded task run a result.
 *
 * Every run index line (hot `runs/<taskId>/index.jsonl` and each
 * `archive/<YYYY-MM>/index.jsonl`) whose run has no `<runId>.result.json`
 * gets one beside its line, in the shape the scheduler writes for a run that
 * left none of its own: the line's `resultPreview` as output (empty when it
 * has none), an empty activity log and file list, the line's usage, and its
 * error or skip reason.
 *
 * Dry run by default; `--apply` writes. It only creates files: each result is
 * written to a temp file and hard-linked into place, which fails rather than
 * replace a file that exists, so no existing file is ever rewritten and a
 * re-run writes nothing. `--apply` is refused while a runtime answers a health
 * URL or a `serve` process runs on this machine.
 *
 *   bun run-results.js [--work-dir /data] [--apply] [--health-url <url>]...
 *
 * Prints counts only.
 */

import {
  existsSync,
  linkSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  isRunArchiveMonth,
  taskArchivedRunResultPath,
  taskRunResultPath,
  validateRunId,
} from "../../src/platform/tasks/paths.ts";
import type { TaskRun, TaskRunResult } from "../../src/platform/tasks/types.ts";

export interface Counts {
  /** Index lines read. */
  lines: number;
  /** Lines that are not JSON or carry no id. */
  unreadable: number;
  /** Lines whose run id the reader would refuse. */
  invalidId: number;
  /** Lines repeating a run id already seen in the same task. */
  duplicate: number;
  /** Runs that already have a result. */
  hasResult: number;
  /** Runs with no result, by status. */
  missing: Record<string, number>;
  /** Of those, runs whose result carries the line's preview. */
  withPreview: number;
  /** Results written (apply only). */
  written: number;
}

/** The result a run index line with no result gets: the shape the scheduler writes for such a run. */
export function resultOfLine(taskId: string, run: TaskRun): TaskRunResult {
  return {
    runId: run.id,
    taskId,
    completedAt: run.completedAt ?? run.startedAt,
    output: run.resultPreview ?? "",
    activityLog: [],
    outputFiles: [],
    usage: {
      inputTokens: run.inputTokens ?? 0,
      outputTokens: run.outputTokens ?? 0,
      iterations: run.iterations ?? 0,
    },
    ...(run.stopReason !== undefined ? { stopReason: run.stopReason } : {}),
    ...(run.error !== undefined ? { error: run.error } : {}),
  };
}

const dirs = (path: string): string[] => {
  try {
    return readdirSync(path).filter((name) => statSync(join(path, name)).isDirectory());
  } catch {
    return [];
  }
};

/** Create `path` with `contents`, never replacing a file there. False when one exists. */
export function createOnly(path: string, contents: string): boolean {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, contents, { flag: "wx" });
  try {
    linkSync(tmp, path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  } finally {
    unlinkSync(tmp);
  }
}

export function migrate(workDir: string, apply: boolean): Counts {
  const counts: Counts = {
    lines: 0,
    unreadable: 0,
    invalidId: 0,
    duplicate: 0,
    hasResult: 0,
    missing: {},
    withPreview: 0,
    written: 0,
  };
  const workspaces = join(workDir, "workspaces");
  for (const wsId of dirs(workspaces)) {
    const tasksRoot = join(workspaces, wsId, "tasks");
    for (const ownerId of dirs(tasksRoot)) {
      const runsRoot = join(tasksRoot, ownerId, "runs");
      for (const taskId of dirs(runsRoot)) {
        const months = dirs(join(runsRoot, taskId, "archive")).filter(isRunArchiveMonth);
        // Where the reader looks for a run's result: the hot dir, then each month.
        const resultPaths = (runId: string) => [
          taskRunResultPath(workDir, wsId, ownerId, taskId, runId),
          ...months.map((m) => taskArchivedRunResultPath(workDir, wsId, ownerId, taskId, m, runId)),
        ];
        const segments: { index: string; target: (runId: string) => string }[] = [
          {
            index: join(runsRoot, taskId, "index.jsonl"),
            target: (runId) => taskRunResultPath(workDir, wsId, ownerId, taskId, runId),
          },
          ...months.map((m) => ({
            index: join(runsRoot, taskId, "archive", m, "index.jsonl"),
            target: (runId: string) =>
              taskArchivedRunResultPath(workDir, wsId, ownerId, taskId, m, runId),
          })),
        ];
        const seen = new Set<string>();
        for (const { index, target } of segments) {
          let text: string;
          try {
            text = readFileSync(index, "utf-8");
          } catch {
            continue;
          }
          for (const line of text.split("\n")) {
            if (!line.trim()) continue;
            counts.lines++;
            let run: TaskRun;
            try {
              run = JSON.parse(line) as TaskRun;
            } catch {
              counts.unreadable++;
              continue;
            }
            if (!run || typeof run.id !== "string") {
              counts.unreadable++;
              continue;
            }
            try {
              validateRunId(run.id);
            } catch {
              counts.invalidId++;
              continue;
            }
            if (seen.has(run.id)) {
              counts.duplicate++;
              continue;
            }
            seen.add(run.id);
            if (resultPaths(run.id).some((p) => existsSync(p))) {
              counts.hasResult++;
              continue;
            }
            const status = String(run.status);
            counts.missing[status] = (counts.missing[status] ?? 0) + 1;
            if (run.resultPreview) counts.withPreview++;
            if (!apply) continue;
            const result = resultOfLine(taskId, run);
            if (createOnly(target(run.id), `${JSON.stringify(result, null, 2)}\n`)) {
              counts.written++;
            }
          }
        }
      }
    }
  }
  return counts;
}

/** Why `--apply` must not run here, or null: a runtime answering, or a `serve` process. */
export async function liveRuntime(healthUrls: string[]): Promise<string | null> {
  for (const url of healthUrls) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(1500) });
      return `a runtime answers ${url}`;
    } catch {
      // nothing answering
    }
  }
  for (const pid of dirs("/proc").filter((p) => /^\d+$/.test(p))) {
    if (Number(pid) === process.pid) continue;
    let cmd = "";
    try {
      cmd = readFileSync(`/proc/${pid}/cmdline`, "utf-8").split("\0").join(" ");
    } catch {
      continue;
    }
    if (/\bserve\b/.test(cmd) && /cli\/index|nimblebrain/.test(cmd)) {
      return `process ${pid} is a runtime: ${cmd.trim()}`;
    }
  }
  return null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const at = args.indexOf("--work-dir");
  const workDir = at >= 0 ? args[at + 1] : (process.env.NB_WORK_DIR ?? "/data");
  if (!workDir) throw new Error("--work-dir needs a path");
  const port = process.env.NB_API_PORT ?? "27247";
  const healthUrls = [`http://127.0.0.1:${port}/v1/health`];
  args.forEach((a, i) => {
    if (a === "--health-url" && args[i + 1]) healthUrls.push(args[i + 1] as string);
  });
  if (apply) {
    const live = await liveRuntime(healthUrls);
    if (live) {
      console.error(`refusing --apply: ${live}. Stop the runtime first.`);
      process.exit(2);
    }
  }
  const counts = migrate(workDir, apply);
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", ...counts }));
}

if (import.meta.main) await main();
