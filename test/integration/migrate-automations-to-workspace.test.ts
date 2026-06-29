import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  automationFilePath,
  automationRunIndexPath,
  workspaceAutomationsDir,
} from "../../src/bundles/automations/src/paths.ts";
import type { Automation, AutomationRun, AutomationsFile } from "../../src/bundles/automations/src/types.ts";
import { migrateAutomationsToWorkspace } from "../../scripts/migrate-automations-to-workspace.ts";
import { personalWorkspaceIdFor } from "../../src/workspace/workspace-store.ts";

/**
 * Round-trip coverage for the identity → workspace-owned, per-automation
 * migration. Does real filesystem I/O against a throwaway work-dir, hence
 * `test/integration/`.
 */

const ALICE = "user_alice";
const BOB = "user_bob";

const DIGEST_ID = "daily-digest";
const REPORT_ID = "weekly-report";

/** A complete Automation; callers override the few fields a case cares about. */
function automation(over: Partial<Automation> & { id: string; name: string }): Automation {
  return {
    prompt: "do the thing",
    schedule: { type: "cron", expression: "0 9 * * *" },
    enabled: true,
    source: "user",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    runCount: 0,
    consecutiveErrors: 0,
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    ...over,
  };
}

/** A source run record: an AutomationRun summary plus the legacy `conversationId`. */
function runRecord(over: Partial<AutomationRun> & { id: string; automationId: string }): AutomationRun & {
  conversationId: string;
} {
  return {
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:05.000Z",
    status: "success",
    inputTokens: 100,
    outputTokens: 50,
    toolCalls: 2,
    iterations: 3,
    conversationId: "conv_legacy_should_be_stripped",
    ...over,
  };
}

function sourceAutomationsDir(workDir: string, ownerId: string): string {
  return join(workDir, "users", ownerId, "automations");
}

/** Seed an owner's `automations.json` collection. */
function seedCollection(workDir: string, ownerId: string, automations: Automation[]): void {
  const dir = sourceAutomationsDir(workDir, ownerId);
  mkdirSync(dir, { recursive: true });
  const file: AutomationsFile = { version: 1, updatedAtMs: Date.now(), automations };
  writeFileSync(join(dir, "automations.json"), `${JSON.stringify(file, null, 2)}\n`, "utf-8");
}

/** Seed an owner's `runs/<automationId>.jsonl` append log. */
function seedRuns(
  workDir: string,
  ownerId: string,
  automationId: string,
  records: Array<Record<string, unknown>>,
): void {
  const dir = join(sourceAutomationsDir(workDir, ownerId), "runs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${automationId}.jsonl`),
    `${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
    "utf-8",
  );
}

/** Strip `conversationId` — the expected shape of each migrated run line. */
function stripConv(rec: Record<string, unknown>): Record<string, unknown> {
  const { conversationId: _drop, ...rest } = rec;
  return rest;
}

function parseJsonl(file: string): Array<Record<string, unknown>> {
  return readFileSync(file, "utf-8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("migrate-automations-to-workspace", () => {
  let workDir: string;

  // Source automations.
  let digestAutomation: Automation;
  let reportAutomation: Automation;
  // Source run records.
  let digestRuns: Array<AutomationRun & { conversationId: string }>;
  let reportRuns: Array<AutomationRun & { conversationId: string }>;

  // Destinations.
  let digestWsId: string;
  let reportWsId: string;
  let digestDest: string;
  let reportDest: string;
  let digestRunsDest: string;
  let reportRunsDest: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "nb-automations-workspace-migrate-"));

    // (a) explicit workspaceId → that workspace's owner partition.
    digestAutomation = automation({
      id: DIGEST_ID,
      name: "Daily Digest",
      ownerId: ALICE,
      workspaceId: "ws_helix",
    });
    // (b) no workspaceId → the owner's personal workspace (ws_user_<ownerId>).
    reportAutomation = automation({ id: REPORT_ID, name: "Weekly Report", ownerId: BOB });

    seedCollection(workDir, ALICE, [digestAutomation]);
    seedCollection(workDir, BOB, [reportAutomation]);

    digestRuns = [
      runRecord({ id: "run_d1", automationId: DIGEST_ID }),
      runRecord({ id: "run_d2", automationId: DIGEST_ID, status: "failure", error: "boom" }),
      runRecord({ id: "run_d3", automationId: DIGEST_ID }),
    ];
    reportRuns = [
      runRecord({ id: "run_r1", automationId: REPORT_ID }),
      runRecord({ id: "run_r2", automationId: REPORT_ID }),
    ];
    seedRuns(workDir, ALICE, DIGEST_ID, digestRuns);
    seedRuns(workDir, BOB, REPORT_ID, reportRuns);

    digestWsId = "ws_helix";
    reportWsId = personalWorkspaceIdFor(BOB);
    digestDest = automationFilePath(workDir, digestWsId, ALICE, DIGEST_ID);
    reportDest = automationFilePath(workDir, reportWsId, BOB, REPORT_ID);
    digestRunsDest = automationRunIndexPath(workDir, digestWsId, ALICE, DIGEST_ID);
    reportRunsDest = automationRunIndexPath(workDir, reportWsId, BOB, REPORT_ID);
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  test("dry-run plans every move but writes nothing", () => {
    const summary = migrateAutomationsToWorkspace(workDir, { write: false });

    expect(summary.moved).toBe(2);
    expect(summary.skippedExisting).toBe(0);
    expect(summary.runsMoved).toBe(2);

    // Sources untouched, destinations absent, no lock left behind.
    expect(existsSync(join(sourceAutomationsDir(workDir, ALICE), "automations.json"))).toBe(true);
    expect(existsSync(digestDest)).toBe(false);
    expect(existsSync(reportDest)).toBe(false);
    expect(existsSync(digestRunsDest)).toBe(false);
    expect(existsSync(reportRunsDest)).toBe(false);
    expect(existsSync(join(workDir, ".migration-lock"))).toBe(false);
  });

  test("--write writes a bare Automation per file plus a conversationId-stripped run log", () => {
    const summary = migrateAutomationsToWorkspace(workDir, { write: true });

    expect(summary.moved).toBe(2);
    expect(summary.runsMoved).toBe(2);
    expect(summary.skippedExisting).toBe(0);

    // Each target is a bare Automation that round-trips deep-equal to the source.
    expect(existsSync(digestDest)).toBe(true);
    expect(existsSync(reportDest)).toBe(true);
    expect(JSON.parse(readFileSync(digestDest, "utf-8"))).toEqual(digestAutomation);
    expect(JSON.parse(readFileSync(reportDest, "utf-8"))).toEqual(reportAutomation);

    // Run logs land at runs/<id>/index.jsonl, each record minus conversationId.
    expect(parseJsonl(digestRunsDest)).toEqual(digestRuns.map(stripConv));
    expect(parseJsonl(reportRunsDest)).toEqual(reportRuns.map(stripConv));
    // conversationId really is gone.
    for (const rec of parseJsonl(digestRunsDest)) {
      expect("conversationId" in rec).toBe(false);
    }

    // The source identity tree is left in place.
    expect(existsSync(join(sourceAutomationsDir(workDir, ALICE), "automations.json"))).toBe(true);
    expect(existsSync(join(sourceAutomationsDir(workDir, ALICE), "runs", `${DIGEST_ID}.jsonl`))).toBe(
      true,
    );

    // No temp/lock residue.
    expect(existsSync(join(workDir, ".migration-lock"))).toBe(false);
  });

  test("a second --write run is idempotent — identical bytes, no duplicate run lines", () => {
    migrateAutomationsToWorkspace(workDir, { write: true });

    const digestBytes = readFileSync(digestDest);
    const digestRunBytes = readFileSync(digestRunsDest);
    const reportRunBytes = readFileSync(reportRunsDest);
    const digestRunLineCount = parseJsonl(digestRunsDest).length;

    const second = migrateAutomationsToWorkspace(workDir, { write: true });

    expect(second.moved).toBe(0);
    expect(second.skippedExisting).toBe(2);
    expect(second.runsMoved).toBe(0);
    expect(second.runsSkippedExisting).toBe(2);

    // Bytes are byte-for-byte identical, and run lines were not duplicated.
    expect(readFileSync(digestDest)).toEqual(digestBytes);
    expect(readFileSync(digestRunsDest)).toEqual(digestRunBytes);
    expect(readFileSync(reportRunsDest)).toEqual(reportRunBytes);
    expect(parseJsonl(digestRunsDest).length).toBe(digestRunLineCount);

    // The lock is released after the run.
    expect(existsSync(join(workDir, ".migration-lock"))).toBe(false);
  });

  test("crash recovery: a pre-existing target is skipped while the rest complete", () => {
    // Simulate a prior partial run: the digest definition was already written,
    // but its run log never made it.
    mkdirSync(workspaceAutomationsDir(workDir, digestWsId, ALICE), { recursive: true });
    writeFileSync(digestDest, JSON.stringify(digestAutomation, null, 2), "utf-8");

    const summary = migrateAutomationsToWorkspace(workDir, { write: true });

    // The digest definition is recognised as already-migrated and left alone...
    expect(summary.skippedExisting).toBe(1);
    // ...but its run log (which never landed) is still completed on this run.
    expect(summary.runsMoved).toBe(2); // digest runs (recovered) + report runs
    expect(existsSync(digestRunsDest)).toBe(true);
    expect(parseJsonl(digestRunsDest)).toEqual(digestRuns.map(stripConv));

    // The report automation migrates normally.
    expect(summary.moved).toBe(1);
    expect(existsSync(reportDest)).toBe(true);
    expect(existsSync(reportRunsDest)).toBe(true);

    expect(existsSync(join(workDir, ".migration-lock"))).toBe(false);
  });
});
