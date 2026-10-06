/**
 * Batches through the real runtime: `tasks__run_batch` feeds its items into
 * runs at the run-start door, each run records its batch, the batch budget is
 * a spend account the door enforces, and inside a run only the batch read
 * tools are reachable.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResult } from "../../src/engine/types.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import type {
  TasksBatchControlOutput,
  TasksBatchesOutput,
  TasksBatchOutput,
  TasksRunBatchOutput,
  TasksRunsOutput,
} from "../../src/platform/schemas/tasks.ts";
import { runWithRequestContext } from "../../src/runtime/request-context.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import type { ToolSource } from "../../src/tools/types.ts";
import { ledgerCostByTaskRun } from "../../src/usage/aggregate.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

let workDir: string;
let runtime: Runtime;
let tasks: ToolSource;

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "task-batches-"));
  runtime = await Runtime.start({
    identityProvider: devProvider,
    languageModel: createEchoModel(),
    logging: { disabled: true },
    telemetry: { enabled: false },
    workDir,
  });
  await provisionTestWorkspace(runtime);
  const source = runtime.getIdentitySource("tasks");
  if (!source) throw new Error("tasks source missing");
  tasks = source;
});

afterAll(async () => {
  await runtime.shutdown();
  rmSync(workDir, { recursive: true, force: true });
});

async function call<T>(
  tool: string,
  args: Record<string, unknown>,
  extra: { unattended?: boolean } = {},
): Promise<{ data: T; isError: boolean; text: string }> {
  const result: ToolResult = await runWithRequestContext(
    { identity: DEV_IDENTITY, workspaceId: TEST_WORKSPACE_ID, ...extra },
    () => tasks.execute(tool, args),
  );
  const block = result.content?.[0];
  const text = block && block.type === "text" ? block.text : "";
  return { data: JSON.parse(text) as T, isError: result.isError === true, text };
}

async function until(
  batchId: string,
  done: (out: TasksBatchOutput) => boolean,
): Promise<TasksBatchOutput> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const out = await call<TasksBatchOutput>("batch", { batchId });
    if (out.isError) throw new Error(out.text);
    if (done(out.data)) return out.data;
    if (Date.now() > deadline) throw new Error(`batch never settled: ${out.text}`);
    await Bun.sleep(25);
  }
}

describe("batches through the runtime", () => {
  it("runs every item of an inline batch, each run recording its batch", async () => {
    const started = await call<TasksRunBatchOutput>("run_batch", {
      definition: {
        body: "Summarize the company in the input.",
        manifest: { inputSchema: { type: "object", required: ["company"] } },
      },
      items: [{ company: "a" }, { company: "b" }, { company: "c" }],
      concurrency: 2,
    });
    if (started.isError) throw new Error(started.text);
    const { id, taskId } = started.data.batch;
    expect(id).toMatch(/^batch_[a-f0-9]{12}$/);

    const settled = await until(id, (b) => b.batch.state === "completed");
    expect(settled.batch.done).toBe(3);
    expect(settled.batch.counts.not_assessed).toBe(3);

    const page = await call<TasksBatchOutput>("batch", { batchId: id, results: true });
    expect(page.data.results?.map((r) => r.label)).toEqual(["Succeeded", "Succeeded", "Succeeded"]);
    const runs = await call<TasksRunsOutput>("runs", { taskId });
    expect(runs.data.runs.map((r) => r.batchId)).toEqual([id, id, id]);
    expect(runs.data.runs.map((r) => r.batchIndex).sort()).toEqual([0, 1, 2]);
    // The usage ledger names each model call's task run by the batch run's id,
    // which is what a batch budget is seeded from.
    const today = new Date().toISOString().slice(0, 10);
    const ledger = ledgerCostByTaskRun(
      workDir,
      new Set(runs.data.runs.map((r) => r.id)),
      { from: today, to: today },
      TEST_WORKSPACE_ID,
    );
    expect(ledger.size).toBe(3);
    expect([...ledger.values()].every((cost) => cost > 0)).toBe(true);
    const without = await call<TasksRunsOutput>("runs", { taskId, excludeBatchRuns: true });
    expect(without.data.runs).toHaveLength(0);

    const listed = await call<TasksBatchesOutput>("batches", {});
    expect(listed.data.batches.map((b) => b.id)).toContain(id);
  });

  it("refuses a batch with a bad item and creates nothing", async () => {
    const before = await call<TasksBatchesOutput>("batches", {});
    const refused = await call<{ error: string }>("run_batch", {
      definition: {
        body: "Do it.",
        manifest: { inputSchema: { type: "object", required: ["company"] } },
      },
      items: [{ company: "a" }, { nope: true }],
    });
    expect(refused.isError).toBe(true);
    expect(refused.data.error).toContain("item 1:");
    const after = await call<TasksBatchesOutput>("batches", {});
    expect(after.data.batches).toHaveLength(before.data.batches.length);
  });

  it("enforces the batch budget at the door: a budget too small for one call pauses the batch", async () => {
    const started = await call<TasksRunBatchOutput>("run_batch", {
      definition: { body: "Summarize the input." },
      items: [1, 2, 3],
      concurrency: 1,
      budgetUsd: 0.000001,
    });
    if (started.isError) throw new Error(started.text);
    const { id } = started.data.batch;
    const paused = await until(
      id,
      (b) => b.batch.state === "paused" && b.batch.counts.running === 0,
    );
    expect(paused.batch.pause?.reason).toBe("budget");
    // Stopped before its first call, the item waits to run under a raised budget.
    expect(paused.batch.counts.pending).toBe(3);
    expect(paused.batch.costUsd).toBe(0);
    const inbox = runtime.getNotificationStore(TEST_WORKSPACE_ID).list({ source: "tasks" });
    expect(inbox.some((n) => n.envelope.name === "task.batch.paused")).toBe(true);

    const cancelled = await call<TasksBatchControlOutput>("batch_control", {
      batchId: id,
      action: "cancel",
    });
    expect(cancelled.data.batch.state).toBe("cancelled");
    expect(cancelled.data.batch.counts.cancelled).toBe(3);
  });

  it("inside a run, reads a batch but cannot start or control one", async () => {
    const started = await call<TasksRunBatchOutput>("run_batch", {
      definition: { body: "Summarize." },
      items: [1],
    });
    const { id } = started.data.batch;
    await until(id, (b) => b.batch.state === "completed");

    const read = await call<TasksBatchOutput>("batch", { batchId: id }, { unattended: true });
    expect(read.isError).toBe(false);
    const list = await call<TasksBatchesOutput>("batches", {}, { unattended: true });
    expect(list.isError).toBe(false);
    const start = await call<{ error: string }>(
      "run_batch",
      { definition: { body: "Fan out." }, items: [1] },
      { unattended: true },
    );
    expect(start.isError).toBe(true);
    expect(start.data.error).toContain("not available inside an unattended");
    const control = await call<{ error: string }>(
      "batch_control",
      { batchId: id, action: "rerun_failed" },
      { unattended: true },
    );
    expect(control.isError).toBe(true);
    expect(control.data.error).toContain("not available inside an unattended");
  });
});
