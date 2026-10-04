/**
 * An automation's trigger is optional (ADR-0045): it may have no schedule at
 * all (manual only), a schedule that fires once at a time T and then goes
 * inert, a recurring one, or an event. And a definition is `saved` or
 * `oneoff`, with one-offs left out of the default list.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Executor, isDue, Scheduler } from "../../../../src/platform/automations/scheduler.ts";
import {
  formatSchedule,
  handleCreate,
  handleList,
  handleRun,
  handleRuns,
  handleStatus,
  handleUpdate,
  type ToolContext,
} from "../../../../src/platform/automations/server.ts";
import {
  appendRun,
  deleteAutomationDefinition,
  loadOwnerAutomations,
  MAX_RUN_LINES,
  readAllRuns,
  readRunResult,
  readRuns,
  readRunsPage,
  saveAutomation,
} from "../../../../src/platform/automations/store.ts";
import {
  type Automation,
  type AutomationRun,
  ONCE_GRACE_MS,
  ONCE_MISSED_REASON,
  ONCE_RAN_REASON,
  onceRetirement,
} from "../../../../src/platform/automations/types.ts";
import { seedWorkspaceRoot } from "../../../helpers/test-workspace.ts";

const WS = "ws_0076759dbbe19fcc";
const OWNER = "usr_test";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "optional-trigger-"));
  seedWorkspaceRoot(workDir, WS);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const loadDefs = () => loadOwnerAutomations(workDir, WS, OWNER);

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    definitions: loadDefs,
    save: (defs) => {
      const onDisk = loadDefs();
      for (const auto of defs.values()) {
        auto.workspaceId ??= WS;
        auto.ownerId ??= OWNER;
        saveAutomation(workDir, WS, OWNER, auto);
      }
      for (const id of onDisk.keys()) {
        if (!defs.has(id)) deleteAutomationDefinition(workDir, WS, OWNER, id);
      }
    },
    reloadScheduler: () => {},
    runNow: (automationId) => {
      const run = makeRun(automationId, "success", "manual");
      appendRun(workDir, WS, OWNER, automationId, run);
      return { state: "started", run: Promise.resolve(run) };
    },
    cancelRun: () => false,
    readRuns: (id, opts) => readRuns(workDir, WS, OWNER, id, opts),
    readRunsPage: (id, opts) => readRunsPage(workDir, WS, OWNER, id, opts),
    readAllRuns: (opts) => readAllRuns(workDir, WS, OWNER, opts),
    readRunResult: (id, runId) => readRunResult(workDir, WS, OWNER, id, runId),
    defaultTimezone: "Pacific/Honolulu",
    currentUserId: OWNER,
    currentWorkspaceId: WS,
    ...overrides,
  };
}

function makeRun(
  automationId: string,
  status: AutomationRun["status"],
  trigger: AutomationRun["trigger"] = "scheduled",
): AutomationRun {
  const now = new Date().toISOString();
  return {
    id: `run_${Math.random().toString(36).slice(2, 10)}`,
    automationId,
    startedAt: now,
    completedAt: now,
    status,
    inputTokens: 10,
    outputTokens: 5,
    toolCalls: 0,
    iterations: 1,
    trigger,
  };
}

function makeAutomation(overrides: Partial<Automation> = {}): Automation {
  const now = new Date().toISOString();
  return {
    id: "send-it",
    name: "Send It",
    prompt: "Send the email",
    enabled: true,
    source: "user",
    workspaceId: WS,
    ownerId: OWNER,
    createdAt: now,
    updatedAt: now,
    runCount: 0,
    consecutiveErrors: 0,
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    ...overrides,
  };
}

const iso = (ms: number) => new Date(ms).toISOString();

/** An executor whose run ends with `status`, or throws when given an error. */
function executorThat(outcome: AutomationRun["status"] | Error): Executor {
  return mock(async (auto: Automation, _signal: AbortSignal, trigger) => {
    if (outcome instanceof Error) throw outcome;
    return { run: makeRun(auto.id, outcome, trigger), result: null };
  }) as Executor;
}

/** Seed `auto`, start a scheduler over it, run one tick, and stop. */
async function tick(auto: Automation, executor: Executor): Promise<Scheduler> {
  saveAutomation(workDir, WS, OWNER, auto);
  const scheduler = new Scheduler(executor, { workDir });
  scheduler.start();
  await scheduler.onTimer();
  scheduler.stop();
  return scheduler;
}

// ---------------------------------------------------------------------------
// Once at T
// ---------------------------------------------------------------------------

describe("a once schedule", () => {
  test.each([
    ["success", "success" as const],
    ["failure", "failure" as const],
    ["timeout", "timeout" as const],
    ["a thrown error", new Error("provider exploded")],
    ["a thrown timeout", new Error("Run timed out after 120000ms")],
  ])("fires at its time and goes inert after %s", async (_label, outcome) => {
    const at = Date.now() - 1000;
    const auto = makeAutomation({ schedule: { type: "once", at: iso(at) }, nextRunAt: iso(at) });
    const executor = executorThat(outcome);

    await tick(auto, executor);

    expect(executor).toHaveBeenCalledTimes(1);
    const stored = loadDefs().get(auto.id)!;
    expect(stored.enabled).toBe(false);
    expect(stored.nextRunAt).toBeUndefined();
    expect(stored.schedule).toEqual({ type: "once", at: iso(at) });
    expect(stored.disabledReason?.startsWith(ONCE_RAN_REASON)).toBe(true);
    expect(onceRetirement(stored)).toBe("ran");
    expect(isDue(stored, Date.now() + 86_400_000)).toBe(false);

    // A second tick never fires it again.
    const again = executorThat("success");
    await tick(stored, again);
    expect(again).not.toHaveBeenCalled();
  });

  test("does not fire before its time", async () => {
    const at = Date.now() + 3_600_000;
    const auto = makeAutomation({ schedule: { type: "once", at: iso(at) } });
    const executor = executorThat("success");

    const scheduler = await tick(auto, executor);

    expect(executor).not.toHaveBeenCalled();
    // Armed at exactly its time.
    expect(scheduler.getDefinitions().get(`${WS}/${OWNER}/${auto.id}`)?.nextRunAt).toBe(iso(at));
  });

  test("a time missed by less than the grace window fires on the next tick", async () => {
    const at = Date.now() - (ONCE_GRACE_MS - 60_000);
    const auto = makeAutomation({ schedule: { type: "once", at: iso(at) }, nextRunAt: iso(at) });
    const executor = executorThat("success");

    await tick(auto, executor);

    expect(executor).toHaveBeenCalledTimes(1);
    expect(onceRetirement(loadDefs().get(auto.id)!)).toBe("ran");
  });

  test("a time missed by more than the grace window is recorded skipped and goes inert", async () => {
    const at = Date.now() - (ONCE_GRACE_MS + 60_000);
    const auto = makeAutomation({ schedule: { type: "once", at: iso(at) }, nextRunAt: iso(at) });
    const executor = executorThat("success");

    await tick(auto, executor);

    expect(executor).not.toHaveBeenCalled();
    const stored = loadDefs().get(auto.id)!;
    expect(stored.enabled).toBe(false);
    expect(stored.nextRunAt).toBeUndefined();
    expect(stored.disabledReason?.startsWith(ONCE_MISSED_REASON)).toBe(true);
    expect(onceRetirement(stored)).toBe("missed");
    const runs = readRuns(workDir, WS, OWNER, auto.id);
    expect(runs.length).toBe(1);
    expect(runs[0]!.status).toBe("skipped");
    expect(runs[0]!.trigger).toBeUndefined();
  });

  test("Run now on an armed once runs it and leaves it armed", async () => {
    const at = Date.now() + 3_600_000;
    const auto = makeAutomation({ schedule: { type: "once", at: iso(at) } });
    saveAutomation(workDir, WS, OWNER, auto);
    const executor = executorThat("success");
    const scheduler = new Scheduler(executor, { workDir });
    scheduler.start();

    const run = await scheduler.runNow(WS, OWNER, auto.id);
    scheduler.stop();

    expect(run?.status).toBe("success");
    const stored = loadDefs().get(auto.id)!;
    expect(stored.enabled).toBe(true);
    expect(stored.nextRunAt).toBe(iso(at));
  });

  test("Run now on an inert once runs it and leaves it inert", async () => {
    const auto = makeAutomation({
      schedule: { type: "once", at: iso(Date.now() - 60_000) },
      enabled: false,
      disabledReason: `${ONCE_RAN_REASON}${iso(Date.now() - 60_000)}`,
    });
    saveAutomation(workDir, WS, OWNER, auto);
    const executor = executorThat("success");
    const scheduler = new Scheduler(executor, { workDir });
    scheduler.start();

    await scheduler.runNow(WS, OWNER, auto.id);
    scheduler.stop();

    const stored = loadDefs().get(auto.id)!;
    expect(onceRetirement(stored)).toBe("ran");
    expect(stored.nextRunAt).toBeUndefined();
  });
});

describe("once schedule validation and re-arm", () => {
  const future = () => iso(Date.now() + 3_600_000);

  test("create accepts a future time and arms it", () => {
    const at = future();
    const out = handleCreate(
      { manifest: { name: "Send It", schedule: { type: "once", at } }, body: "Send the email" },
      makeCtx(),
    );
    expect(out.automation.nextRunAt).toBe(new Date(at).toISOString());
    expect(out.automation.enabled).toBe(true);
  });

  test("create refuses a time in the past", () => {
    expect(() =>
      handleCreate(
        {
          manifest: { name: "Late", schedule: { type: "once", at: iso(Date.now() - 1000) } },
          body: "x",
        },
        makeCtx(),
      ),
    ).toThrow(/already passed/);
  });

  test.each([
    ["no time", {}],
    ["a time with no offset", { at: "2099-07-01T13:12:00" }],
    ["not a timestamp", { at: "next tuesday" }],
  ])("create refuses %s", (_label, fields) => {
    expect(() =>
      handleCreate(
        { manifest: { name: "Bad", schedule: { type: "once", ...fields } }, body: "x" },
        makeCtx(),
      ),
    ).toThrow(/at is required|Invalid once time/);
  });

  test("a new time re-arms one that already ran", () => {
    const ctx = makeCtx();
    const past = iso(Date.now() - 60_000);
    saveAutomation(
      workDir,
      WS,
      OWNER,
      makeAutomation({
        schedule: { type: "once", at: past },
        enabled: false,
        disabledAt: past,
        disabledReason: `${ONCE_RAN_REASON}${past}`,
      }),
    );

    const at = future();
    const out = handleUpdate(
      { name: "Send It", manifest: { schedule: { type: "once", at } } },
      ctx,
    );

    expect(out.automation.enabled).toBe(true);
    expect(out.automation.disabledReason).toBeUndefined();
    expect(out.automation.nextRunAt).toBe(new Date(at).toISOString());
    expect(onceRetirement(out.automation)).toBeNull();
  });

  test("enabling one whose time has passed is refused", () => {
    const past = iso(Date.now() - 60_000);
    saveAutomation(
      workDir,
      WS,
      OWNER,
      makeAutomation({
        schedule: { type: "once", at: past },
        enabled: false,
        disabledReason: `${ONCE_RAN_REASON}${past}`,
      }),
    );
    expect(() => handleUpdate({ name: "Send It", manifest: { enabled: true } }, makeCtx())).toThrow(
      /has passed/,
    );
    expect(loadDefs().get("send-it")?.enabled).toBe(false);
  });

  test("re-arming with a past time is refused", () => {
    saveAutomation(
      workDir,
      WS,
      OWNER,
      makeAutomation({ schedule: { type: "once", at: future() } }),
    );
    expect(() =>
      handleUpdate(
        { name: "Send It", manifest: { schedule: { type: "once", at: iso(Date.now() - 1000) } } },
        makeCtx(),
      ),
    ).toThrow(/already passed/);
  });

  test("a paused once keeps its pause when its time changes", () => {
    saveAutomation(
      workDir,
      WS,
      OWNER,
      makeAutomation({ schedule: { type: "once", at: future() }, enabled: false }),
    );
    const out = handleUpdate(
      { name: "Send It", manifest: { schedule: { type: "once", at: future() } } },
      makeCtx(),
    );
    expect(out.automation.enabled).toBe(false);
  });

  test("list and status say when it runs, and that it ran", () => {
    const ctx = makeCtx();
    const at = "2099-07-01T13:12:00-07:00";
    handleCreate({ manifest: { name: "Send It", schedule: { type: "once", at } }, body: "x" }, ctx);
    const armed = handleList({}, ctx).automations[0]!;
    expect(armed.schedule).toMatch(/^Once at Jul 1, 2099/);
    expect(armed.scheduleType).toBe("once");

    const stored = loadDefs().get("send-it")!;
    saveAutomation(workDir, WS, OWNER, {
      ...stored,
      enabled: false,
      disabledReason: `${ONCE_RAN_REASON}${at}`,
    });
    expect(handleList({}, ctx).automations[0]!.schedule).toMatch(/^Ran once at Jul 1, 2099/);
    expect(handleStatus({ name: "Send It" }, ctx).automation.scheduleHuman).toMatch(/^Ran once/);
  });
});

// ---------------------------------------------------------------------------
// Manual only
// ---------------------------------------------------------------------------

describe("an automation with no schedule", () => {
  test("is created, listed as manual only, and never arms", async () => {
    const ctx = makeCtx();
    const out = handleCreate({ manifest: { name: "By Hand" }, body: "Do it" }, ctx);
    expect(out.automation.schedule).toBeUndefined();
    expect(out.automation.nextRunAt).toBeUndefined();

    const row = handleList({}, ctx).automations[0]!;
    expect(row.schedule).toBe("Manual only");
    expect(row.scheduleType).toBe("none");
    expect(row.nextRunAt).toBeNull();
    expect(row.estimatedCostPerDay).toBe(0);

    const executor = executorThat("success");
    const originalSetTimeout = globalThis.setTimeout;
    let armedDelay = -1;
    globalThis.setTimeout = ((fn: () => void, delay?: number) => {
      armedDelay = delay ?? 0;
      return originalSetTimeout(fn, delay);
    }) as typeof globalThis.setTimeout;
    try {
      const scheduler = new Scheduler(executor, { workDir });
      scheduler.start();
      // Only the heartbeat: nothing is due.
      expect(armedDelay).toBe(60_000);
      await scheduler.onTimer();
      scheduler.stop();
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
    expect(executor).not.toHaveBeenCalled();
    expect(isDue(loadDefs().get("by-hand")!, Date.now())).toBe(false);
  });

  test("Run now runs it, enabled or not, with no disabled note", async () => {
    saveAutomation(
      workDir,
      WS,
      OWNER,
      makeAutomation({ id: "by-hand", name: "By Hand", enabled: false }),
    );
    const executor = executorThat("success");
    const scheduler = new Scheduler(executor, { workDir });
    scheduler.start();
    const ctx = makeCtx({
      reloadScheduler: () => scheduler.reload(),
      runNow: (id) => scheduler.requestRunNow(WS, OWNER, id),
    });

    const result = await handleRun({ name: "By Hand" }, ctx);
    scheduler.stop();

    if (!("run" in result)) throw new Error(`expected a run, got ${JSON.stringify(result)}`);
    expect(result.run.status).toBe("success");
    expect(result.message).toBeUndefined();
    expect(executor).toHaveBeenCalledTimes(1);
    expect(loadDefs().get("by-hand")?.nextRunAt).toBeUndefined();
  });

  test("update with schedule null clears the schedule and its next run", () => {
    const ctx = makeCtx();
    handleCreate(
      {
        manifest: { name: "Was Daily", schedule: { type: "cron", expression: "0 8 * * *" } },
        body: "x",
      },
      ctx,
    );
    expect(loadDefs().get("was-daily")?.nextRunAt).toBeDefined();

    const out = handleUpdate({ name: "Was Daily", manifest: { schedule: null } }, ctx);

    expect(out.updated).toBe(true);
    const stored = loadDefs().get("was-daily")!;
    expect("schedule" in stored).toBe(false);
    expect(stored.nextRunAt).toBeUndefined();
    expect(formatSchedule(stored.schedule)).toBe("Manual only");
  });

  test("a schedule can be given back to it", () => {
    const ctx = makeCtx();
    handleCreate({ manifest: { name: "By Hand" }, body: "x" }, ctx);
    const out = handleUpdate(
      { name: "By Hand", manifest: { schedule: { type: "interval", intervalMs: 3_600_000 } } },
      ctx,
    );
    expect(out.automation.schedule?.type).toBe("interval");
    expect(out.automation.nextRunAt).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Kind
// ---------------------------------------------------------------------------

describe("kind", () => {
  test("list returns saved automations by default, and one-offs when asked", () => {
    const ctx = makeCtx();
    handleCreate({ manifest: { name: "Kept" }, body: "x" }, ctx);
    handleCreate({ manifest: { name: "Just Once", kind: "oneoff" }, body: "x" }, ctx);
    // A definition written before `kind` existed reads as saved.
    saveAutomation(workDir, WS, OWNER, makeAutomation({ id: "legacy", name: "Legacy" }));

    const names = (args: Record<string, unknown>) =>
      handleList(args, ctx).automations.map((a) => a.name);
    expect(names({})).toEqual(["Kept", "Legacy"]);
    expect(names({ kind: "oneoff" })).toEqual(["Just Once"]);
    expect(names({ kind: "all" })).toEqual(["Just Once", "Kept", "Legacy"]);
    expect(handleList({}, ctx).total).toBe(2);
    expect(
      handleList({ kind: "all" }, ctx).automations.find((a) => a.name === "Just Once")?.kind,
    ).toBe("oneoff");
  });

  test("create stores no kind unless one is given", () => {
    const out = handleCreate({ manifest: { name: "Kept" }, body: "x" }, makeCtx());
    expect("kind" in out.automation).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Paged runs through the tool
// ---------------------------------------------------------------------------

describe("handleRuns pages back through archived history", () => {
  test("the first page reads the recent runs and hands a cursor into the archive", () => {
    const ctx = makeCtx();
    const base = Date.parse("2025-01-01T00:00:00Z");
    for (let i = 0; i < MAX_RUN_LINES + 5; i++) {
      appendRun(workDir, WS, OWNER, "busy", {
        ...makeRun("busy", "success"),
        id: `run_${i}`,
        startedAt: iso(base + i * 60_000),
      });
    }

    const first = handleRuns({ automationId: "busy", limit: 10 }, ctx);
    expect(first.runs.length).toBe(10);
    expect(first.nextBefore).toBeDefined();

    // Walk to the end: every run ever recorded, including those rolled out of
    // the hot index, comes back once.
    const ids = new Set(first.runs.map((r) => r.id));
    let before = first.nextBefore;
    while (before) {
      const page = handleRuns({ automationId: "busy", limit: 400, before }, ctx);
      for (const r of page.runs) ids.add(r.id);
      before = page.nextBefore;
    }
    expect(ids.size).toBe(MAX_RUN_LINES + 5);
    expect(ids.has("run_0")).toBe(true);
  });
});
