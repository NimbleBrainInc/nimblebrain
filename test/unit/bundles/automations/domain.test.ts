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
import { loadDefinitions, saveDefinitions } from "../../../../src/bundles/automations/src/store.ts";

let storeDir: string;
let reloadCount: number;

function makeCtx(): AutomationDomainContext {
  reloadCount = 0;
  return {
    definitions: () => loadDefinitions(storeDir),
    save: (defs) => saveDefinitions(defs, storeDir),
    reloadScheduler: () => {
      reloadCount++;
    },
    defaultTimezone: "Pacific/Honolulu",
  };
}

beforeEach(() => {
  storeDir = mkdtempSync(join(tmpdir(), "automations-domain-"));
  mkdirSync(storeDir, { recursive: true });
});

afterEach(() => {
  rmSync(storeDir, { recursive: true, force: true });
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
