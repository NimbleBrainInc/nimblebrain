/**
 * The Scheduled page demo's seed (`scripts/lib/scheduled-demo/`): seeded twice
 * into one workdir, then booted, the panel's own reads (`tasks__list`,
 * `tasks__stats`, `tasks__batches`, `tasks__batch`) through the web shell's
 * tool-call route give every task the board word its fixture names, and fill
 * the Runs tab with the one-offs and batches, with nothing duplicated.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  BATCHES,
  DEMO_WORKSPACE,
  ONEOFFS,
  TASKS,
} from "../../scripts/lib/scheduled-demo/fixtures.ts";
import { type SeedSummary, seedScheduledDemo } from "../../scripts/lib/scheduled-demo/seed.ts";
import type { ToolCallResponse } from "../../src/api/schemas/responses.ts";
import { type ServerHandle, startServer } from "../../src/api/server.ts";
import type {
  TasksBatchesOutput,
  TasksBatchOutput,
  TasksListOutput,
  TasksStatsOutput,
} from "../../src/platform/schemas/tasks.ts";
import { healthOf } from "../../src/platform/tasks/ui/src/lib/attention.ts";
import type { TaskRun as PanelRun } from "../../src/platform/tasks/ui/src/types.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { WorkspaceStore } from "../../src/workspace/workspace-store.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { readJson } from "../helpers/http.ts";
import { makeTestWorkDir } from "../helpers/test-workdir.ts";

const { workDir, cleanup } = makeTestWorkDir("scheduled-demo-seed");

let runtime: Runtime | undefined;
let handle: ServerHandle | undefined;
let summary: SeedSummary;

const SETUP_TIMEOUT_MS = 30_000;

beforeAll(async () => {
  await seedScheduledDemo({ workDir });
  summary = await seedScheduledDemo({ workDir });
  runtime = await Runtime.start({
    identityProvider: devProvider,
    languageModel: createEchoModel(),
    logging: { disabled: true },
    workDir,
  });
  handle = startServer({ runtime, port: 0 });
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  handle?.stop(true);
  await runtime?.shutdown();
  cleanup();
});

/** A tasks tool, called the way the web shell calls it. */
async function callTasks<T>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(
    `http://localhost:${handle?.port}/v1/workspaces/${summary.workspaceId}/tools/call`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server: "tasks", tool, arguments: args }),
    },
  );
  const body = await readJson<ToolCallResponse>(res);
  if (body.isError) throw new Error(`tasks__${tool}: ${JSON.stringify(body.content)}`);
  return body.structuredContent as T;
}

/** A task's newest runs as the board's strip reads them from `tasks__stats`. */
function recentOf(stats: TasksStatsOutput["tasks"][number]): PanelRun[] {
  return (stats.recent ?? []).map((r) => ({
    id: r.id,
    taskId: stats.taskId,
    status: r.label === "Failed" ? "failure" : "success",
    label: r.label,
    startedAt: r.startedAt,
    ...(r.error ? { error: r.error } : {}),
  }));
}

describe("the scheduled demo seed", () => {
  it("creates the workspace once, and the dev user belongs to no other", async () => {
    const all = await new WorkspaceStore(workDir).list();
    expect(all.map((w) => w.name)).toEqual([DEMO_WORKSPACE.name]);
    expect(all[0]?.members.map((m) => m.userId)).toEqual(["usr_default"]);
  });

  it("lists every saved task once", async () => {
    const { tasks } = await callTasks<TasksListOutput>("list");
    expect(tasks.map((t) => t.id).sort()).toEqual(TASKS.map((t) => t.id).sort());
  });

  it("gives each task the board word its fixture names", async () => {
    const { tasks } = await callTasks<TasksListOutput>("list");
    const stats = await callTasks<TasksStatsOutput>("stats");
    const byId = new Map(stats.tasks.map((s) => [s.taskId, s]));
    const words = Object.fromEntries(
      tasks.map((task) => {
        const s = byId.get(task.id);
        return [task.id, healthOf(task, s, undefined, s ? recentOf(s) : []).word];
      }),
    );
    expect(words).toEqual(Object.fromEntries(TASKS.map((t) => [t.id, t.board])));
  });

  it("records each task's runs, with the outcomes that classify it", async () => {
    const stats = await callTasks<TasksStatsOutput>("stats");
    const labels = (id: string) =>
      (stats.tasks.find((s) => s.taskId === id)?.recent ?? []).map((r) => r.label).reverse();
    expect(labels("slack-channel-recap").filter((l) => l === "Failed")).toHaveLength(3);
    expect(labels("invoice-reconciliation").slice(-3)).toEqual(["Failed", "Failed", "Failed"]);
    expect(labels("lead-enrichment").at(-1)).toBe("Poor result");
    expect(labels("draft-call-follow-ups").at(-1)).toBe("Needs review");
    for (const fixture of TASKS) {
      expect({ id: fixture.id, runs: labels(fixture.id).length }).toEqual({
        id: fixture.id,
        runs: fixture.outcomes.length,
      });
    }
  });

  it("lists the one-offs and batches the Runs tab draws", async () => {
    const { tasks } = await callTasks<TasksListOutput>("list", { kind: "oneoff", limit: 100 });
    expect(tasks).toHaveLength(ONEOFFS.length + BATCHES.length);
    const { batches } = await callTasks<TasksBatchesOutput>("batches");
    expect(batches.map((b) => b.idempotencyKey).sort()).toEqual(BATCHES.map((b) => b.key).sort());
    for (const fixture of BATCHES) {
      const batch = batches.find((b) => b.idempotencyKey === fixture.key);
      expect(batch?.state).toBe(fixture.pending ? "paused" : "completed");
      expect(batch?.counts.pass).toBe(fixture.pass);
      expect(batch?.counts.fail).toBe(fixture.fail);
      expect(batch?.counts.pending).toBe(fixture.pending ?? 0);
    }
  });

  it("reads a batch's results through its runs", async () => {
    const { batches } = await callTasks<TasksBatchesOutput>("batches");
    const first = batches.find((b) => b.idempotencyKey === BATCHES[0]?.key);
    const page = await callTasks<TasksBatchOutput>("batch", {
      batchId: first?.id,
      results: true,
      limit: 5,
    });
    expect(page.results).toHaveLength(5);
    expect(page.results?.[0]?.label).toBe("Succeeded");
    expect(page.results?.[0]?.output).toMatchObject({ company: "Company 1", fit: "strong" });
  });
});
