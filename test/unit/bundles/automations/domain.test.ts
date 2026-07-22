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
 * directly. These tests pin that contract — `updateAutomation` flips
 * `enabled` end-to-end via the same path the CLI exercises.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type AutomationDomainContext,
  createAutomation,
  deleteAutomation,
  updateAutomation,
} from "../../../../src/bundles/automations/src/domain.ts";
import {
  deleteAutomationDefinition,
  loadOwnerAutomations,
  saveAutomation,
} from "../../../../src/bundles/automations/src/store.ts";

// Automations are workspace-owned: the domain's collection context is backed by
// the per-automation store, scoped to one workspace + owner (the focus the tool
// surface would resolve). `save` reconciles the map against disk.
const WS = "ws_test";
const OWNER = "usr_test";
let workDir: string;
let reloadCount: number;

function makeCtx(): AutomationDomainContext {
  reloadCount = 0;
  return {
    definitions: () => loadOwnerAutomations(workDir, WS, OWNER),
    save: (map) => {
      const onDisk = loadOwnerAutomations(workDir, WS, OWNER);
      for (const auto of map.values()) {
        if (!auto.workspaceId) auto.workspaceId = WS;
        if (!auto.ownerId) auto.ownerId = OWNER;
        saveAutomation(workDir, WS, OWNER, auto);
      }
      for (const id of onDisk.keys()) {
        if (!map.has(id)) deleteAutomationDefinition(workDir, WS, OWNER, id);
      }
    },
    reloadScheduler: () => {
      reloadCount++;
    },
    defaultTimezone: "Pacific/Honolulu",
  };
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "automations-domain-"));
  mkdirSync(workDir, { recursive: true });
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("updateAutomation — pause/resume regression (CLI path)", () => {
  test("update with { enabled: false } actually flips enabled", () => {
    const ctx = makeCtx();
    const created = createAutomation(
      {
        name: "Daily Sync",
        prompt: "Sync everything",
        schedule: { type: "interval", intervalMs: 60_000 },
      },
      ctx,
    );
    expect(created.created).toBe(true);
    expect(created.automation.enabled).toBe(true);

    const result = updateAutomation("Daily Sync", { enabled: false }, ctx);
    expect(result.updated).toBe(true);
    expect(result.automation.enabled).toBe(false);

    // Re-read from disk to verify persistence (not just in-memory mutation).
    const fromDisk = ctx.definitions().get(created.automation.id);
    expect(fromDisk?.enabled).toBe(false);
  });

  test("update with { enabled: true } re-enables and clears disable state", () => {
    const ctx = makeCtx();
    const created = createAutomation(
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
    const auto = defs.get(created.automation.id)!;
    auto.consecutiveErrors = 5;
    auto.disabledAt = new Date().toISOString();
    auto.disabledReason = "Token budget exceeded";
    ctx.save(defs);

    const result = updateAutomation("Recovering", { enabled: true }, ctx);
    expect(result.updated).toBe(true);
    expect(result.automation.enabled).toBe(true);
    expect(result.automation.consecutiveErrors).toBe(0);
    expect(result.automation.disabledAt).toBeUndefined();
    expect(result.automation.disabledReason).toBeUndefined();
  });

  test("scheduler reload fires once per mutation, not on no-op", () => {
    const ctx = makeCtx();
    createAutomation(
      {
        name: "Counter",
        prompt: "Count",
        schedule: { type: "interval", intervalMs: 60_000 },
      },
      ctx,
    );
    expect(reloadCount).toBe(1); // From create

    updateAutomation("Counter", { enabled: false }, ctx);
    expect(reloadCount).toBe(2); // Mutation triggered reload

    // Calling update with no actual change should NOT trigger reload.
    updateAutomation("Counter", {}, ctx);
    expect(reloadCount).toBe(2);
  });
});

describe("token budget window anchoring", () => {
  test("create anchors budgetResetAt when the budget has a period", () => {
    const ctx = makeCtx();
    const { automation } = createAutomation(
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
    expect(automation.budgetResetAt).toBeDefined();
    expect(new Date(automation.budgetResetAt!).getTime()).toBeGreaterThan(Date.now());
  });

  test("create leaves budgetResetAt unset for a periodless (lifetime) budget", () => {
    const ctx = makeCtx();
    const { automation } = createAutomation(
      {
        name: "Lifetime",
        prompt: "watch",
        schedule: { type: "cron", expression: "0 12 * * *" },
        tokenBudget: { maxInputTokens: 300_000 },
      },
      ctx,
    );
    expect(automation.budgetResetAt).toBeUndefined();
  });

  test("changing the budget via update starts a fresh window: resets counters and re-anchors", () => {
    // The reported incident: a run from an earlier, unrelated design left a
    // large cumulative total. Rebuilding the automation via update set a new
    // budget, but the stale total carried over and, on the next run, summed
    // past the new ceiling and auto-disabled a freshly rebuilt automation.
    const ctx = makeCtx();
    const { automation } = createAutomation(
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
    const auto = defs.get(automation.id)!;
    auto.cumulativeInputTokens = 490_000;
    auto.cumulativeOutputTokens = 12_000;
    ctx.save(defs);

    // Rebuild: raise the budget via update (the operator's "rebuild on real
    // tools" edit).
    const result = updateAutomation(
      "Rebuilt",
      { tokenBudget: { maxInputTokens: 500_000, period: "daily" } },
      ctx,
    );

    // A written budget is a new window: totals cleared, boundary re-anchored.
    expect(result.automation.cumulativeInputTokens).toBe(0);
    expect(result.automation.cumulativeOutputTokens).toBe(0);
    expect(result.automation.budgetResetAt).toBeDefined();
    expect(new Date(result.automation.budgetResetAt!).getTime()).toBeGreaterThan(Date.now());

    // Persisted, not just mutated in memory.
    const fromDisk = ctx.definitions().get(automation.id);
    expect(fromDisk?.cumulativeInputTokens).toBe(0);
  });

  test("an update that does NOT touch tokenBudget leaves the running totals intact", () => {
    const ctx = makeCtx();
    const { automation } = createAutomation(
      {
        name: "Keep",
        prompt: "watch",
        schedule: { type: "cron", expression: "0 12 * * *" },
        tokenBudget: { maxInputTokens: 300_000, period: "daily" },
      },
      ctx,
    );
    const defs = ctx.definitions();
    const auto = defs.get(automation.id)!;
    auto.cumulativeInputTokens = 120_000;
    ctx.save(defs);

    // Editing the prompt must not reset the window mid-period.
    const result = updateAutomation("Keep", { prompt: "watch harder" }, ctx);
    expect(result.automation.cumulativeInputTokens).toBe(120_000);
  });
});

describe("createAutomation / deleteAutomation — bundle lifecycle path", () => {
  test("create with source=bundle and bundleName preserves identity for cleanup", () => {
    const ctx = makeCtx();
    createAutomation(
      {
        name: "monitoring__heartbeat",
        prompt: "ping",
        schedule: { type: "interval", intervalMs: 60_000 },
        source: "bundle",
        bundleName: "@acme/monitoring",
      },
      ctx,
    );
    createAutomation(
      {
        name: "user-authored",
        prompt: "agent stuff",
        schedule: { type: "interval", intervalMs: 60_000 },
      },
      ctx,
    );

    const defs = ctx.definitions();
    const bundleAuto = defs.get("monitoring-heartbeat");
    expect(bundleAuto?.source).toBe("bundle");
    expect(bundleAuto?.bundleName).toBe("@acme/monitoring");

    const userAuto = defs.get("user-authored");
    expect(userAuto?.source).toBe("agent");
    expect(userAuto?.bundleName).toBeUndefined();
  });

  test("delete by name removes from store", () => {
    const ctx = makeCtx();
    createAutomation(
      {
        name: "Delete Me",
        prompt: "x",
        schedule: { type: "interval", intervalMs: 60_000 },
      },
      ctx,
    );
    const result = deleteAutomation("Delete Me", ctx);
    expect(result.deleted).toBe(true);
    expect(ctx.definitions().size).toBe(0);
  });
});
