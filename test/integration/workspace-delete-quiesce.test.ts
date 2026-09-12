/**
 * Deleting a workspace disarms the automations it held.
 *
 * The scheduler loads every workspace's automations into an in-memory map at
 * boot and re-reads it only from the automations tool surface — nothing
 * reloaded it on a workspace delete. So a deleted workspace's automations
 * stayed armed until the process restarted, and when one fired it wrote back
 * through a store that mkdir'd its way into the directory that had just been
 * archived. The workspace came back holding a run log and nothing else, and
 * `list()` skips a workspace directory with no parseable `workspace.json`, so
 * it appeared nowhere and was never deleted again.
 *
 * Two halves, both pinned here:
 *
 *   1. `Runtime.deleteWorkspace` drops the workspace's automations from the
 *      scheduler before anything else, so the correct behaviour does not rest
 *      on a write failing.
 *   2. `ensureWorkspaceDir` is the floor under it: the directory does not come
 *      back even if something does reach the store.
 *
 * The first test is the control, and it is not optional — without it, "the
 * automation did not fire" passes for a fixture that never armed one.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendRun } from "../../src/platform/automations/store.ts";
import type { Automation } from "../../src/platform/automations/types.ts";
import { runWithRequestContext } from "../../src/runtime/request-context.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import type { TaskRequest, TaskResult } from "../../src/runtime/types.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { makeTestWorkDir } from "../helpers/test-workdir.ts";

const WS_ID = "ws_quiesce";
const AUTOMATION_ID = "daily-digest";
/** No identity provider is configured, so every owner resolves to the dev id. */
const OWNER = "usr_default";

let workDir: string;
let cleanup: () => void;
let runtime: Runtime;
/** One entry per task the scheduler actually dispatched. */
let dispatched: string[];

/**
 * An automation already due, so `reloadScheduler()` arms its timer at zero
 * delay and the very next macrotask fires it. That is what makes both tests
 * deterministic rather than a sleep long enough to "probably" be safe.
 */
function armedAutomation(): Automation {
  const now = new Date().toISOString();
  return {
    id: AUTOMATION_ID,
    name: "Daily digest",
    prompt: "summarize the day",
    schedule: { type: "interval", intervalMs: 60_000 },
    enabled: true,
    workspaceId: WS_ID,
    ownerId: OWNER,
    source: "user",
    createdAt: now,
    updatedAt: now,
    nextRunAt: new Date(Date.now() - 1000).toISOString(),
  };
}

/** Write the automation and hand it to the scheduler, the way the tool does. */
function arm(): void {
  runWithRequestContext({ identity: null, workspaceId: WS_ID }, () => {
    const ctx = runtime.getAutomationsContext();
    const defs = ctx.definitions();
    defs.set(AUTOMATION_ID, armedAutomation());
    ctx.save(defs);
    ctx.reloadScheduler();
  });
}

/** Yield long enough for a zero-delay timer to run. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

beforeEach(async () => {
  dispatched = [];
  ({ workDir, cleanup } = makeTestWorkDir("ws-delete-quiesce"));
  runtime = await Runtime.start({
    model: { provider: "custom", adapter: createEchoModel() },
    logging: { disabled: true },
    workDir,
  });
  await runtime.getWorkspaceStore().create("Quiesce", "quiesce");
  await runtime.getWorkspaceStore().addMember(WS_ID, OWNER, "admin");

  // Stand in for the agent run. The automations source closed over
  // `(req) => runtime.executeTask(req)`, so shadowing the method on this
  // instance is what the scheduler reaches — and counting dispatches is the
  // only direct read on "did it fire".
  runtime.executeTask = async (request: TaskRequest): Promise<TaskResult> => {
    dispatched.push(request.prompt);
    return {
      output: "done",
      runId: `run_${dispatched.length}`,
      toolCalls: [],
      stopReason: "complete",
      usage: { inputTokens: 1, outputTokens: 1, model: "echo", llmMs: 1, iterations: 1 },
    };
  };
});

afterEach(async () => {
  await runtime.shutdown();
  cleanup();
});

test("the control: an armed automation in a live workspace fires", async () => {
  arm();
  await tick();

  expect(dispatched).toEqual(["summarize the day"]);
  expect(existsSync(join(workDir, "workspaces", WS_ID))).toBe(true);
});

test("deleting the workspace disarms it, and the directory does not come back", async () => {
  arm();

  // `deleteWorkspace` drops the workspace's automations in its synchronous
  // prefix, before its first await — so the zero-delay timer `arm()` just
  // scheduled is cleared before it can run. Nothing here waits on a race.
  const result = await runtime.deleteWorkspace(WS_ID);
  expect(result.deleted).toBe(true);

  await tick();
  await tick();

  expect(dispatched).toEqual([]);
  expect(existsSync(join(workDir, "workspaces", WS_ID))).toBe(false);
  expect(existsSync(join(workDir, "archived", WS_ID))).toBe(true);
});

test("a run that slips through cannot re-create the archived workspace", async () => {
  // The floor under the drop. The scheduler is disarmed, so this drives the
  // store directly — the same call `updateAfterRun` makes when a run that was
  // already in flight at delete time settles afterwards.
  arm();
  await runtime.deleteWorkspace(WS_ID);

  expect(() =>
    appendRun(workDir, WS_ID, OWNER, AUTOMATION_ID, {
      id: "run_late",
      automationId: AUTOMATION_ID,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      status: "success",
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
      iterations: 0,
    }),
  ).toThrow(/ws_quiesce/);

  expect(existsSync(join(workDir, "workspaces", WS_ID))).toBe(false);
});
