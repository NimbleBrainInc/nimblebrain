/**
 * Domain API regression tests.
 *
 * These tests guard against a silent breakage class: a caller invoking the
 * LLM-facing tool with the old flat shape `{ name, enabled }`. AJV with
 * `strict: false` accepts the extra root-level field without complaint, but
 * the new handler reads `args.manifest`, sees undefined, and returns
 * `updated: false` — silently no-op'ing while the caller assumes success.
 *
 * Fix: the CLI bypasses the LLM-facing tool and calls the domain API
 * directly. These tests pin that contract — `updateTask` flips
 * `enabled` end-to-end via the same path the CLI exercises.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTask,
  deleteTask,
  type TaskDomainContext,
  updateTask,
} from "../../../../src/platform/tasks/domain.ts";
import {
  deleteTaskDefinition,
  loadOwnerTasks,
  saveTask,
} from "../../../../src/platform/tasks/store.ts";
import { seedWorkspaceRoot } from "../../../helpers/test-workspace.ts";

// Tasks are workspace-owned: the domain's collection context is backed by
// the per-task store, scoped to one workspace + owner (the focus the tool
// surface would resolve). `save` reconciles the map against disk.
const WS = "ws_0076759dbbe19fcc";
const OWNER = "usr_test";
let workDir: string;
let reloadCount: number;

function makeCtx(): TaskDomainContext {
  reloadCount = 0;
  return {
    definitions: () => loadOwnerTasks(workDir, WS, OWNER),
    save: (map) => {
      const onDisk = loadOwnerTasks(workDir, WS, OWNER);
      for (const auto of map.values()) {
        if (!auto.workspaceId) auto.workspaceId = WS;
        if (!auto.ownerId) auto.ownerId = OWNER;
        saveTask(workDir, WS, OWNER, auto);
      }
      for (const id of onDisk.keys()) {
        if (!map.has(id)) deleteTaskDefinition(workDir, WS, OWNER, id);
      }
    },
    reloadScheduler: () => {
      reloadCount++;
    },
    defaultTimezone: "Pacific/Honolulu",
  };
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "tasks-domain-"));
  mkdirSync(workDir, { recursive: true });
  seedWorkspaceRoot(workDir, WS);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("updateTask — pause/resume regression (CLI path)", () => {
  test("update with { enabled: false } actually flips enabled", () => {
    const ctx = makeCtx();
    const created = createTask(
      {
        name: "Daily Sync",
        prompt: "Sync everything",
        schedule: { type: "interval", intervalMs: 60_000 },
      },
      ctx,
    );
    expect(created.created).toBe(true);
    expect(created.task.enabled).toBe(true);

    const result = updateTask("Daily Sync", { enabled: false }, ctx);
    expect(result.updated).toBe(true);
    expect(result.task.enabled).toBe(false);

    // Re-read from disk to verify persistence (not just in-memory mutation).
    const fromDisk = ctx.definitions().get(created.task.id);
    expect(fromDisk?.enabled).toBe(false);
  });

  test("update with { enabled: true } re-enables and clears disable state", () => {
    const ctx = makeCtx();
    const created = createTask(
      {
        name: "Recovering",
        prompt: "Try again",
        schedule: { type: "interval", intervalMs: 60_000 },
        enabled: false,
      },
      ctx,
    );
    // Manually stamp the disable-state fields the auto-disable path would set.
    const defs = ctx.definitions();
    const auto = defs.get(created.task.id)!;
    auto.consecutiveErrors = 5;
    auto.disabledAt = new Date().toISOString();
    auto.disabledReason = "Token budget exceeded";
    ctx.save(defs);

    const result = updateTask("Recovering", { enabled: true }, ctx);
    expect(result.updated).toBe(true);
    expect(result.task.enabled).toBe(true);
    expect(result.task.consecutiveErrors).toBe(0);
    expect(result.task.disabledAt).toBeUndefined();
    expect(result.task.disabledReason).toBeUndefined();
  });

  test("test_reenable_one_off_paused_past_its_date_clears_the_stale_run", () => {
    const ctx = makeCtx();
    const year = new Date().getUTCFullYear() + 1;
    const created = createTask(
      {
        name: "One-off send",
        prompt: "Send it",
        schedule: { type: "cron", expression: `0 0 9 1 1 * ${year}`, timezone: "UTC" },
      },
      ctx,
    );
    updateTask("One-off send", { enabled: false }, ctx);

    // The date passes while it is paused: its only occurrence is now behind it,
    // and the stored nextRunAt is that occurrence.
    const defs = ctx.definitions();
    const auto = defs.get(created.task.id)!;
    auto.schedule = { type: "cron", expression: "0 0 9 1 1 * 2020", timezone: "UTC" };
    auto.nextRunAt = "2020-01-01T09:00:00.000Z";
    ctx.save(defs);

    const result = updateTask("One-off send", { enabled: true }, ctx);
    expect(result.task.enabled).toBe(true);
    expect(result.task.nextRunAt).toBeUndefined();
    expect(ctx.definitions().get(created.task.id)?.nextRunAt).toBeUndefined();
  });

  test("test_reenable_recurring_cron_keeps_its_past_run_for_one_catch_up", () => {
    const ctx = makeCtx();
    const created = createTask(
      { name: "Daily", prompt: "Digest", schedule: { type: "cron", expression: "0 9 * * *" } },
      ctx,
    );
    updateTask("Daily", { enabled: false }, ctx);
    const defs = ctx.definitions();
    const past = new Date(Date.now() - 86_400_000).toISOString();
    defs.get(created.task.id)!.nextRunAt = past;
    ctx.save(defs);

    const result = updateTask("Daily", { enabled: true }, ctx);
    expect(result.task.nextRunAt).toBe(past);
  });

  test("scheduler reload fires once per mutation, not on no-op", () => {
    const ctx = makeCtx();
    createTask(
      {
        name: "Counter",
        prompt: "Count",
        schedule: { type: "interval", intervalMs: 60_000 },
      },
      ctx,
    );
    expect(reloadCount).toBe(1); // From create

    updateTask("Counter", { enabled: false }, ctx);
    expect(reloadCount).toBe(2); // Mutation triggered reload

    // Calling update with no actual change should NOT trigger reload.
    updateTask("Counter", {}, ctx);
    expect(reloadCount).toBe(2);
  });
});

describe("token budget window anchoring", () => {
  test("create anchors budgetResetAt when the budget has a period", () => {
    const ctx = makeCtx();
    const { task } = createTask(
      {
        name: "Watcher",
        prompt: "watch",
        schedule: { type: "cron", expression: "0 12 * * *" },
        tokenBudget: { maxInputTokens: 300_000, period: "daily" },
      },
      ctx,
    );
    // Anchored at write time (mirrors nextRunAt), so the scheduler's window can
    // roll from the first run instead of never — a future ISO boundary.
    expect(task.budgetResetAt).toBeDefined();
    expect(new Date(task.budgetResetAt!).getTime()).toBeGreaterThan(Date.now());
  });

  test("create leaves budgetResetAt unset for a periodless (lifetime) budget", () => {
    const ctx = makeCtx();
    const { task } = createTask(
      {
        name: "Lifetime",
        prompt: "watch",
        schedule: { type: "cron", expression: "0 12 * * *" },
        tokenBudget: { maxInputTokens: 300_000 },
      },
      ctx,
    );
    expect(task.budgetResetAt).toBeUndefined();
  });

  test("changing the budget via update starts a fresh window: resets counters and re-anchors", () => {
    // The reported incident: a run from an earlier, unrelated design left a
    // large cumulative total. Rebuilding the task via update set a new
    // budget, but the stale total carried over and, on the next run, summed
    // past the new ceiling and auto-disabled a freshly rebuilt task.
    const ctx = makeCtx();
    const { task } = createTask(
      {
        name: "Rebuilt",
        prompt: "reply/bounce watcher",
        schedule: { type: "cron", expression: "0 12,17 * * 1-5" },
        tokenBudget: { maxInputTokens: 300_000, period: "daily" },
      },
      ctx,
    );

    // Simulate spend accrued under the prior design.
    const defs = ctx.definitions();
    const auto = defs.get(task.id)!;
    auto.cumulativeInputTokens = 490_000;
    auto.cumulativeOutputTokens = 12_000;
    ctx.save(defs);

    // Rebuild: raise the budget via update (the operator's "rebuild on real
    // tools" edit).
    const result = updateTask(
      "Rebuilt",
      { tokenBudget: { maxInputTokens: 500_000, period: "daily" } },
      ctx,
    );

    // A written budget is a new window: totals cleared, boundary re-anchored.
    expect(result.task.cumulativeInputTokens).toBe(0);
    expect(result.task.cumulativeOutputTokens).toBe(0);
    expect(result.task.budgetResetAt).toBeDefined();
    expect(new Date(result.task.budgetResetAt!).getTime()).toBeGreaterThan(Date.now());

    // Persisted, not just mutated in memory.
    const fromDisk = ctx.definitions().get(task.id);
    expect(fromDisk?.cumulativeInputTokens).toBe(0);
  });

  test("an update that does NOT touch tokenBudget leaves the running totals intact", () => {
    const ctx = makeCtx();
    const { task } = createTask(
      {
        name: "Keep",
        prompt: "watch",
        schedule: { type: "cron", expression: "0 12 * * *" },
        tokenBudget: { maxInputTokens: 300_000, period: "daily" },
      },
      ctx,
    );
    const defs = ctx.definitions();
    const auto = defs.get(task.id)!;
    auto.cumulativeInputTokens = 120_000;
    ctx.save(defs);

    // Editing the prompt must not reset the window mid-period.
    const result = updateTask("Keep", { prompt: "watch harder" }, ctx);
    expect(result.task.cumulativeInputTokens).toBe(120_000);
  });

  test("re-sending an unchanged budget does NOT reset the window (change-gated, not write-gated)", () => {
    const ctx = makeCtx();
    const { task } = createTask(
      {
        name: "Resend",
        prompt: "watch",
        schedule: { type: "cron", expression: "0 12 * * *" },
        tokenBudget: { maxInputTokens: 300_000, period: "daily" },
      },
      ctx,
    );
    const defs = ctx.definitions();
    const auto = defs.get(task.id)!;
    auto.cumulativeInputTokens = 200_000;
    ctx.save(defs);

    // A caller re-sends the identical budget alongside an unrelated edit. The
    // budget didn't change, so accumulated spend must survive.
    const result = updateTask(
      "Resend",
      { prompt: "watch harder", tokenBudget: { maxInputTokens: 300_000, period: "daily" } },
      ctx,
    );
    expect(result.task.cumulativeInputTokens).toBe(200_000);
  });
});

describe("createTask / deleteTask — internal caller path", () => {
  test("an explicit source overrides the agent default", () => {
    const ctx = makeCtx();
    createTask(
      {
        name: "operator-authored",
        prompt: "ping",
        schedule: { type: "interval", intervalMs: 60_000 },
        source: "user",
      },
      ctx,
    );
    createTask(
      {
        name: "tool-authored",
        prompt: "agent stuff",
        schedule: { type: "interval", intervalMs: 60_000 },
      },
      ctx,
    );

    const defs = ctx.definitions();
    expect(defs.get("operator-authored")?.source).toBe("user");
    expect(defs.get("tool-authored")?.source).toBe("agent");
  });

  test("delete by name removes from store", () => {
    const ctx = makeCtx();
    createTask(
      {
        name: "Delete Me",
        prompt: "x",
        schedule: { type: "interval", intervalMs: 60_000 },
      },
      ctx,
    );
    const result = deleteTask("Delete Me", ctx);
    expect(result.deleted).toBe(true);
    expect(ctx.definitions().size).toBe(0);
  });
});

describe("an event schedule", () => {
  const eventSchedule = {
    type: "event" as const,
    match: { source: "precision-outbound", name: "reply.*" },
  };

  test("carries no nextRunAt, because it has no position in time", () => {
    const ctx = makeCtx();
    const { task } = createTask(
      { name: "Reply triage", prompt: "Triage.", schedule: eventSchedule, source: "user" },
      ctx,
    );
    expect(task.nextRunAt).toBeUndefined();
  });

  // A clock schedule leaves a nextRunAt behind. The timer ignores it, but the
  // status surface reads it, so a moment nothing will ever act on is worse than
  // none at all.
  test("clears a nextRunAt left over from the clock schedule it replaced", () => {
    const ctx = makeCtx();
    createTask(
      {
        name: "Reply triage",
        prompt: "Triage.",
        schedule: { type: "interval", intervalMs: 3_600_000 },
        source: "user",
      },
      ctx,
    );
    const before = ctx.definitions().get("reply-triage");
    expect(before?.nextRunAt).toBeDefined();

    updateTask("Reply triage", { schedule: eventSchedule }, ctx);
    expect(ctx.definitions().get("reply-triage")?.nextRunAt).toBeUndefined();
  });

  /**
   * A connector that could give itself a task subscribed to its own
   * outbox has written a self-wake loop with no operator anywhere in it. The
   * tool schema cannot carry `source` at all, so this is the only door the
   * check can sit on.
   */
  test("is refused for a provenance outside user and agent", () => {
    const ctx = makeCtx();
    expect(() =>
      createTask(
        {
          name: "Self wake",
          prompt: "Go.",
          schedule: eventSchedule,
          source: "bundle" as never,
        },
        ctx,
      ),
    ).toThrow(/cannot run on events/);
    expect(ctx.definitions().size).toBe(0);
  });

  test("cannot be patched onto a task with such a provenance either", () => {
    const ctx = makeCtx();
    createTask(
      {
        name: "Bundle job",
        prompt: "Go.",
        schedule: { type: "interval", intervalMs: 3_600_000 },
        source: "bundle" as never,
      },
      ctx,
    );
    expect(() => updateTask("Bundle job", { schedule: eventSchedule }, ctx)).toThrow(
      /cannot run on events/,
    );
    expect(ctx.definitions().get("bundle-job")?.schedule.type).toBe("interval");
  });

  test("is allowed for a user and for the agent acting on one's instruction", () => {
    const ctx = makeCtx();
    for (const source of ["user", "agent"] as const) {
      const { task } = createTask(
        { name: `Triage ${source}`, prompt: "Triage.", schedule: eventSchedule, source },
        ctx,
      );
      expect(task.schedule.type).toBe("event");
    }
  });
});

describe("updateTask — a schedule with no next run", () => {
  test("clears the nextRunAt left by the schedule it replaced", () => {
    const ctx = makeCtx();
    createTask(
      {
        name: "Morning",
        prompt: "Say good morning",
        schedule: { type: "cron", expression: "0 9 * * *" },
      },
      ctx,
    );
    expect(loadOwnerTasks(workDir, WS, OWNER).get("morning")?.nextRunAt).toBeDefined();

    updateTask("Morning", { schedule: { type: "cron", expression: "0 9 31 2 *" } }, ctx);

    expect(loadOwnerTasks(workDir, WS, OWNER).get("morning")?.nextRunAt).toBeUndefined();
  });
});
