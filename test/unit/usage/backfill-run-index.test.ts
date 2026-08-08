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
import { isRunIndex } from "../../../scripts/backfill-usage-ledger.ts";

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
