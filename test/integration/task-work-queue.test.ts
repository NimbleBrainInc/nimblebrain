/**
 * Scheduled and requested task runs go through the runtime's work queue: the
 * timer and `tasks__run` only enqueue, and the tasks scheduler's worker claims
 * each item and runs it through the door. Each case boots a real runtime (the
 * echo model, the filesystem queue at `<workDir>/queue`) and reads the run
 * records it leaves.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResult } from "../../src/engine/types.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import type {
  TasksCancelOutput,
  TasksCreateOutput,
  TasksRunOutput,
  TasksRunResultOutput,
} from "../../src/platform/schemas/tasks.ts";
import {
  INTERRUPTED_RUN_ERROR,
  SCHEDULED_RUN_KIND,
  scheduledItemKey,
} from "../../src/platform/tasks/scheduler.ts";
import { loadTask, readRuns, readRunTicket, saveTask } from "../../src/platform/tasks/store.ts";
import { createFilesystemWorkQueue } from "../../src/providers/queue/filesystem.ts";
import type { AdmissionLease } from "../../src/runtime/admission.ts";
import { runWithRequestContext } from "../../src/runtime/request-context.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { WORK_QUEUE_DIR } from "../../src/runtime/work-queue.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

const WS = TEST_WORKSPACE_ID;
const OWNER = DEV_IDENTITY.id;

let workDir: string;
const running: Runtime[] = [];

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "task-work-queue-"));
});

afterEach(async () => {
  for (const rt of running.splice(0)) await rt.shutdown();
  rmSync(workDir, { recursive: true, force: true });
});

/** A runtime on `workDir` with one unattended run slot. */
async function boot(): Promise<Runtime> {
  const runtime = await Runtime.start({
    identityProvider: devProvider,
    languageModel: createEchoModel(),
    logging: { disabled: true },
    telemetry: { enabled: false },
    tasks: { maxConcurrentRuns: 1 },
    workDir,
  });
  running.push(runtime);
  await provisionTestWorkspace(runtime);
  return runtime;
}

async function shutdown(runtime: Runtime): Promise<void> {
  running.splice(running.indexOf(runtime), 1);
  await runtime.shutdown();
}

/** Call a tasks tool as the dev user and read its answer. */
async function call<T>(runtime: Runtime, tool: string, args: Record<string, unknown>): Promise<T> {
  const tasks = runtime.getIdentitySource("tasks");
  if (!tasks) throw new Error("tasks source missing");
  await tasks.tools();
  const result: ToolResult = await runWithRequestContext(
    { identity: DEV_IDENTITY, workspaceId: WS },
    () => tasks.execute(tool, args),
  );
  const block = result.content?.[0];
  const text = block?.type === "text" ? block.text : "";
  if (result.isError) throw new Error(`tasks__${tool} failed: ${text}`);
  return JSON.parse(text) as T;
}

async function create(runtime: Runtime, name: string, schedule?: Record<string, unknown>) {
  return call<TasksCreateOutput>(runtime, "create", {
    manifest: { name, ...(schedule ? { schedule } : {}) },
    body: "Say hello.",
  });
}

/** Hold the runtime's one unattended run slot, as another source's run would. */
function holdSlot(runtime: Runtime): AdmissionLease {
  const ticket = runtime.getRunAdmission().request({ workspaceId: WS, key: "test:hold" });
  if (ticket.state !== "admitted") throw new Error(`expected a free slot, got ${ticket.state}`);
  return ticket.lease;
}

async function waitFor(cond: () => boolean, what: string, ms = 4000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

describe("task runs on the work queue", () => {
  it("opens the queue under the work directory, and a second runtime on it fails at boot", async () => {
    const runtime = await boot();
    expect(existsSync(join(workDir, WORK_QUEUE_DIR))).toBe(true);
    await expect(
      Runtime.start({
        identityProvider: devProvider,
        languageModel: createEchoModel(),
        logging: { disabled: true },
        telemetry: { enabled: false },
        workDir,
      }),
    ).rejects.toThrow("cannot open the work queue");
    await shutdown(runtime);
  });

  it("a scheduled run fires once from the timer", async () => {
    const runtime = await boot();
    // An interval's first run is due at once.
    const { task } = await create(runtime, "Hourly", { intervalMs: 3_600_000 });
    await waitFor(() => readRuns(workDir, WS, OWNER, task.id).length === 1, "the scheduled run");
    await Bun.sleep(200);

    const runs = readRuns(workDir, WS, OWNER, task.id);
    expect(runs.map((r) => [r.status, r.trigger])).toEqual([["success", "scheduled"]]);
    const stored = loadTask(workDir, WS, OWNER, task.id)!;
    expect(stored.runCount).toBe(1);
    expect(stored.scheduledRunInFlight).toBeUndefined();
    expect(new Date(stored.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it("a requested run through tasks__run runs and answers with its record", async () => {
    const runtime = await boot();
    const { task } = await create(runtime, "Manual");
    const out = await call<TasksRunOutput>(runtime, "run", { taskId: task.id });
    if (!("run" in out)) throw new Error(`expected the run's record, got ${JSON.stringify(out)}`);
    expect(out.run.status).toBe("success");

    const ticket = readRunTicket(workDir, WS, OWNER, out.run.id);
    expect(ticket?.run.status).toBe("success");
    // The work queue carried it: its ticket was written under the claim.
    expect(ticket?.claimToken).toBe(1);
    expect(readRuns(workDir, WS, OWNER, task.id).map((r) => r.id)).toEqual([out.run.id]);
  });

  it("a run queued when the runtime stops runs after the restart", async () => {
    const first = await boot();
    const { task } = await create(first, "Queued");
    const hold = holdSlot(first);
    const queued = await call<TasksRunOutput>(first, "run", { taskId: task.id });
    if (!("status" in queued) || queued.status !== "queued") {
      throw new Error(`expected a queued answer, got ${JSON.stringify(queued)}`);
    }
    expect(queued.position).toBe(1);
    await shutdown(first);
    hold.release();

    // The stop recorded nothing: the run is still queued, not skipped.
    expect(readRuns(workDir, WS, OWNER, task.id)).toEqual([]);
    expect(readRunTicket(workDir, WS, OWNER, queued.runId)?.run.status).toBe("queued");

    const second = await boot();
    await waitFor(
      () => readRunTicket(workDir, WS, OWNER, queued.runId)?.run.status === "success",
      "the queued run after the restart",
    );
    const result = await call<TasksRunResultOutput>(second, "run_result", {
      runId: queued.runId,
    });
    expect(result.status).toBe("ended");
    expect(readRuns(workDir, WS, OWNER, task.id).map((r) => [r.id, r.status])).toEqual([
      [queued.runId, "success"],
    ]);
  });

  it("a scheduled run cut off by a crash is recorded interrupted and not run again", async () => {
    const first = await boot();
    const { task } = await create(first, "Daily", { cron: "0 9 * * *" });
    await shutdown(first);

    // What a process that died under the run leaves: the task marked with the
    // run in flight at its due occurrence, and the occurrence's item claimed
    // under a lease that has since run out.
    const occurrence = new Date(Date.now() - 60_000).toISOString();
    const runId = "run_c0ffee000001";
    const stored = loadTask(workDir, WS, OWNER, task.id)!;
    saveTask(workDir, WS, OWNER, {
      ...stored,
      nextRunAt: occurrence,
      scheduledRunInFlight: { runId, startedAt: occurrence },
    });
    const dead = createFilesystemWorkQueue({
      dir: join(workDir, WORK_QUEUE_DIR),
      now: () => Date.now() - 10 * 60_000,
    });
    await dead.enqueue({
      scope: WS,
      kind: SCHEDULED_RUN_KIND,
      payload: { workspaceId: WS, ownerId: OWNER, taskId: task.id, runId, occurrence },
      idempotencyKey: scheduledItemKey(OWNER, task.id, occurrence),
    });
    await dead.claim({ workerId: "dead", leaseMs: 60_000, kinds: [SCHEDULED_RUN_KIND] });
    await dead.close();

    await boot();
    await Bun.sleep(300);

    const runs = readRuns(workDir, WS, OWNER, task.id);
    expect(runs.map((r) => [r.id, r.status, r.error])).toEqual([
      [runId, "failure", INTERRUPTED_RUN_ERROR],
    ]);
    const after = loadTask(workDir, WS, OWNER, task.id)!;
    expect(after.scheduledRunInFlight).toBeUndefined();
    expect(new Date(after.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it("a queued run cancelled by id is recorded cancelled, and its claim does not run it", async () => {
    const runtime = await boot();
    const { task } = await create(runtime, "Cancelled");
    const { task: other } = await create(runtime, "Other");
    const hold = holdSlot(runtime);
    const queued = await call<TasksRunOutput>(runtime, "run", { taskId: task.id });
    if (!("status" in queued) || queued.status !== "queued") {
      throw new Error(`expected a queued answer, got ${JSON.stringify(queued)}`);
    }

    const cancel = await call<TasksCancelOutput>(runtime, "cancel", { runId: queued.runId });
    expect(cancel.cancelled).toBe(true);
    expect(readRunTicket(workDir, WS, OWNER, queued.runId)?.run.status).toBe("cancelled");

    // Free the slot and ask for another run: the worker claims the cancelled
    // item first and settles it without running, then runs the new one.
    hold.release();
    const next = await call<TasksRunOutput>(runtime, "run", { taskId: other.id });
    if (!("run" in next)) throw new Error(`expected the run's record, got ${JSON.stringify(next)}`);
    expect(next.run.status).toBe("success");

    expect(readRuns(workDir, WS, OWNER, task.id).map((r) => [r.id, r.status])).toEqual([
      [queued.runId, "cancelled"],
    ]);
  });
});
