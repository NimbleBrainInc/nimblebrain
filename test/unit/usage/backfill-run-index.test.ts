/**
 * The backfill's automation half, against the real on-disk layout.
 *
 * This branch had no test, and the one thing it needed to get right — where a
 * run index lives — it got wrong. The predicate looked for
 * `runs/index.jsonl`; the tree stores `automations/<owner>/runs/<automation>/index.jsonl`.
 * Matching nothing is indistinguishable from having nothing to match, so the
 * migration replayed conversations, reported success, and omitted every
 * automation run — on a deployment that leans on automations, most of the
 * spend this ledger exists to surface.
 *
 * So the fixtures are built from `automations/src/paths.ts` — the writer's own
 * path builder — rather than from a hand-joined literal. A fixture that spells
 * the layout out checks the predicate against a copy of itself and stays green
 * when the layout moves, which is this bug reproduced one level up.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  automationRunIndexPath,
  automationRunsDir,
} from "../../../src/bundles/automations/src/paths.ts";
import { collectEntries, isRunIndex, walk } from "../../../scripts/backfill-usage-ledger.ts";

const OWNER = "user_01ABC";
const WS = "ws_test0001";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "nb-backfill-"));
}

/**
 * Seed a run index at the path the runtime itself writes.
 *
 * Built from `automationRunIndexPath`, not from a hand-joined literal. A
 * fixture that spells the layout out only checks the predicate against a copy
 * of itself and stays green when the layout moves — which is the failure this
 * whole change exists to prevent, reproduced one level up in its own tests.
 */
function seedRuns(root: string, automation: string, runs: Record<string, unknown>[]): string {
  mkdirSync(automationRunsDir(root, WS, OWNER, automation), { recursive: true });
  const path = automationRunIndexPath(root, WS, OWNER, automation);
  writeFileSync(path, runs.map((r) => `${JSON.stringify(r)}\n`).join(""));
  return path;
}

describe("isRunIndex", () => {
  test("matches the real layout, with an automation id between runs/ and the file", () => {
    const root = tmp();
    expect(isRunIndex(automationRunIndexPath(root, WS, OWNER, "ce-inbox-triage"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("does NOT match runs/index.jsonl — the shape that matched nothing on disk", () => {
    // Kept as a test rather than deleted with the bug: the old predicate looked
    // for exactly this, and asserting it is *not* the layout is what stops a
    // future simplification from reintroducing the silence.
    expect(isRunIndex(join("a", "automations", OWNER, "runs", "index.jsonl"))).toBe(false);
  });

  test("does not match an index.jsonl outside a runs/ directory", () => {
    expect(isRunIndex(join("a", "conversations", "index.jsonl"))).toBe(false);
    expect(isRunIndex(join("a", "runs", "deeper", "nested", "index.jsonl"))).toBe(false);
  });

  test("does not match a sibling file inside a run directory", () => {
    expect(isRunIndex(join("a", "runs", "ce-inbox-triage", "meta.json"))).toBe(false);
  });
});

describe("a real tree is found end to end", () => {
  test("the seeded run index is what the predicate finds", () => {
    const root = tmp();
    const path = seedRuns(root, "ce-inbox-triage", [
      { id: "run_1", ts: "2026-06-01T10:00:00Z", inputTokens: 1_000_000, outputTokens: 20_000 },
    ]);
    // The fixture is built from the layout the runtime actually writes, so this
    // fails if either the layout or the predicate moves — which is the pairing
    // that was missing.
    expect(isRunIndex(path)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("the guard fires only on evidence the layout moved", () => {
  /** An automation definition with no runs/ subtree — created, never executed. */
  function seedDefinitionOnly(root: string, id: string): void {
    const dir = join(root, "workspaces", WS, "automations", OWNER);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id }));
  }

  test("a defined-but-never-run automation is not evidence of anything", () => {
    // runs/<id>/ is created lazily on first execution, so this is what a healthy
    // deployment looks like before an automation has fired. A guard that keys on
    // definitions cannot tell it from a layout move and takes the whole run down.
    const root = tmp();
    seedDefinitionOnly(root, "never-run");
    expect(() => collectEntries([join(root, "workspaces")], false)).not.toThrow();
    expect(collectEntries([join(root, "workspaces")], false)).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  test("a real run index is collected", () => {
    const root = tmp();
    seedRuns(root, "ce-inbox-triage", [
      { id: "run_1", ts: "2026-06-01T10:00:00Z", inputTokens: 1_000_000, outputTokens: 20_000 },
    ]);
    const entries = collectEntries([join(root, "workspaces")], false);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.origin).toBe("task");
    // No model on a run record, so the line is unpriced rather than free.
    expect(entries[0]?.rates).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });

  test("--skip-automations collects nothing from the automations tree", () => {
    const root = tmp();
    seedRuns(root, "ce-inbox-triage", [
      { id: "run_1", ts: "2026-06-01T10:00:00Z", inputTokens: 10, outputTokens: 1 },
    ]);
    expect(collectEntries([join(root, "workspaces")], true)).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("walk", () => {
  test("finds files matching the predicate and ignores the rest", () => {
    const root = tmp();
    seedRuns(root, "a", [{ id: "r", ts: "2026-06-01T10:00:00Z", inputTokens: 1 }]);
    expect(walk(root, isRunIndex)).toHaveLength(1);
    expect(walk(root, (p) => p.endsWith(".nope"))).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  test("an unreadable root yields nothing rather than throwing", () => {
    expect(walk("/dev/null/nope", () => true)).toEqual([]);
  });
});
