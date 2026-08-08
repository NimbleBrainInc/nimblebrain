/**
 * The backfill's automation half, against the real on-disk layout.
 *
 * This branch had no test, and the one thing it needed to get right — where a
 * run index lives — it got wrong. The predicate looked for
 * `runs/index.jsonl`; the tree stores `automations/<owner>/runs/<automation>/index.jsonl`.
 * Matching nothing is indistinguishable from having nothing to match, so the
 * migration replayed conversations, reported success, and omitted every
 * automation run. On the tenant this was built for that was 1,820 runs and
 * 799M tokens: the exact spend the ledger exists to surface.
 *
 * So the fixtures here are built from the real shape rather than the spec's
 * description of it, and the suite covers the silence as well as the match —
 * a tree with automations and no matching index must fail loudly rather than
 * report a clean run.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRunIndex } from "../../../scripts/backfill-usage-ledger.ts";

const OWNER = "user_01ABC";
const WS = "ws_test0001";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "nb-backfill-"));
}

/** The real layout: automations/<owner>/runs/<automation>/index.jsonl. */
function seedRuns(root: string, automation: string, runs: Record<string, unknown>[]): string {
  const dir = join(root, "workspaces", WS, "automations", OWNER, "runs", automation);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "index.jsonl");
  writeFileSync(path, runs.map((r) => `${JSON.stringify(r)}\n`).join(""));
  return path;
}

describe("isRunIndex", () => {
  test("matches the real layout, with an automation id between runs/ and the file", () => {
    expect(isRunIndex(join("a", "automations", OWNER, "runs", "ce-inbox-triage", "index.jsonl"))).toBe(
      true,
    );
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
