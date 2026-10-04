import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { migrateTaskStorage } from "../../../../src/platform/tasks/migrate-storage.ts";

const WS = "ws_0076759dbbe19fcc";
const OWNER = "usr_owner";
const OTHER = "usr_other";

let workDir: string;

/** `workspaces/<WS>/<segment>/<owner>/<rel>` under the test workDir. */
function at(segment: "automations" | "tasks", owner: string, rel: string): string {
  return join(workDir, "workspaces", WS, segment, owner, rel);
}

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

/** A full owner tree: definition, hot index and sidecar, archive month, ticket, key. */
function seedLegacyOwner(owner: string): void {
  write(at("automations", owner, "digest.json"), '{"id":"digest"}');
  write(at("automations", owner, "runs/digest/index.jsonl"), '{"id":"run_a"}\n');
  write(at("automations", owner, "runs/digest/run_a.result.json"), '{"output":"a"}');
  write(at("automations", owner, "runs/digest/archive/2026-01/index.jsonl"), '{"id":"run_old"}\n');
  write(
    at("automations", owner, "runs/digest/keys/" + "a".repeat(64) + ".json"),
    '{"runId":"run_a"}',
  );
  write(at("automations", owner, "run-tickets/run_a.json"), '{"runId":"run_a"}');
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "nb-task-storage-"));
  // The workspace root exists, as `WorkspaceStore.create` leaves it.
  mkdirSync(join(workDir, "workspaces", WS), { recursive: true });
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("migrateTaskStorage", () => {
  test("moves each owner's whole tree from automations/ to tasks/", () => {
    seedLegacyOwner(OWNER);
    seedLegacyOwner(OTHER);

    const report = migrateTaskStorage(workDir);

    expect(report.moved.sort()).toEqual([`${WS}/${OTHER}`, `${WS}/${OWNER}`]);
    expect(report.conflicts).toEqual([]);
    for (const owner of [OWNER, OTHER]) {
      expect(readFileSync(at("tasks", owner, "digest.json"), "utf-8")).toBe('{"id":"digest"}');
      expect(existsSync(at("tasks", owner, "runs/digest/archive/2026-01/index.jsonl"))).toBe(true);
      expect(existsSync(at("tasks", owner, "run-tickets/run_a.json"))).toBe(true);
    }
    expect(existsSync(join(workDir, "workspaces", WS, "automations"))).toBe(false);
  });

  test("is a no-op once migrated, and on a workdir with no automations/", () => {
    seedLegacyOwner(OWNER);
    migrateTaskStorage(workDir);

    const again = migrateTaskStorage(workDir);

    expect(again).toEqual({ moved: [], merged: [], conflicts: [], rewritten: 0 });
    expect(existsSync(at("tasks", OWNER, "digest.json"))).toBe(true);

    const empty = mkdtempSync(join(tmpdir(), "nb-task-storage-empty-"));
    try {
      expect(migrateTaskStorage(empty)).toEqual({
        moved: [],
        merged: [],
        conflicts: [],
        rewritten: 0,
      });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("merges into an owner dir that exists, never overwriting, and reports conflicts", () => {
    // tasks/ already holds this owner (a process on the old layout wrote
    // automations/ again after the move).
    write(at("tasks", OWNER, "digest.json"), '{"id":"digest","v":2}');
    write(at("tasks", OWNER, "runs/digest/run_a.result.json"), '{"output":"a"}');
    seedLegacyOwner(OWNER);
    write(at("automations", OWNER, "weekly.json"), '{"id":"weekly"}');

    const report = migrateTaskStorage(workDir);

    // Only in the old tree: moved in.
    expect(readFileSync(at("tasks", OWNER, "weekly.json"), "utf-8")).toBe('{"id":"weekly"}');
    expect(existsSync(at("tasks", OWNER, "run-tickets/run_a.json"))).toBe(true);
    expect(existsSync(at("tasks", OWNER, "runs/digest/index.jsonl"))).toBe(true);
    // Identical in both: the old copy is dropped.
    expect(existsSync(at("automations", OWNER, "runs/digest/run_a.result.json"))).toBe(false);
    // Different in both: the new tree is kept, the old file stays, and it is reported.
    expect(readFileSync(at("tasks", OWNER, "digest.json"), "utf-8")).toBe('{"id":"digest","v":2}');
    expect(readFileSync(at("automations", OWNER, "digest.json"), "utf-8")).toBe('{"id":"digest"}');
    expect(report.conflicts).toEqual([`${WS}/${OWNER}/digest.json`]);
    expect(report.moved).toEqual([]);
    expect(report.merged).toContain(`${WS}/${OWNER}/weekly.json`);
  });

  test("rewrites records' old id key to taskId before moving them", () => {
    write(at("automations", OWNER, "digest.json"), '{"id":"digest"}');
    write(
      at("automations", OWNER, "runs/digest/index.jsonl"),
      '{"id":"run_a","automationId":"digest"}\n{"id":"run_b","automationId":"digest"}\n',
    );
    write(
      at("automations", OWNER, "runs/digest/run_a.result.json"),
      '{"runId":"run_a","automationId":"digest"}',
    );
    write(
      at("automations", OWNER, "run-tickets/run_a.json"),
      '{"runId":"run_a","automationId":"digest","run":{"id":"run_a","automationId":"digest"}}',
    );

    const report = migrateTaskStorage(workDir);

    expect(report.rewritten).toBe(3);
    expect(readFileSync(at("tasks", OWNER, "runs/digest/index.jsonl"), "utf-8")).toBe(
      '{"id":"run_a","taskId":"digest"}\n{"id":"run_b","taskId":"digest"}\n',
    );
    expect(readFileSync(at("tasks", OWNER, "runs/digest/run_a.result.json"), "utf-8")).toBe(
      '{"runId":"run_a","taskId":"digest"}',
    );
    expect(readFileSync(at("tasks", OWNER, "run-tickets/run_a.json"), "utf-8")).toBe(
      '{"runId":"run_a","taskId":"digest","run":{"id":"run_a","taskId":"digest"}}',
    );
    // The definition carried no such key and is moved as it was.
    expect(readFileSync(at("tasks", OWNER, "digest.json"), "utf-8")).toBe('{"id":"digest"}');
  });

  test("a rerun after a crash mid-way finishes the move", () => {
    // A crash after the first owner's rename and part of a merge: one owner
    // already under tasks/, one still in automations/, and one split across both.
    seedLegacyOwner(OWNER);
    seedLegacyOwner(OTHER);
    migrateTaskStorage(workDir);
    seedLegacyOwner("usr_third");
    write(at("tasks", "usr_third", "digest.json"), '{"id":"digest"}');

    const report = migrateTaskStorage(workDir);

    expect(report.conflicts).toEqual([]);
    expect(existsSync(at("tasks", "usr_third", "runs/digest/index.jsonl"))).toBe(true);
    expect(existsSync(at("tasks", "usr_third", "run-tickets/run_a.json"))).toBe(true);
    expect(existsSync(join(workDir, "workspaces", WS, "automations"))).toBe(false);
    expect(existsSync(at("tasks", OWNER, "digest.json"))).toBe(true);
  });
});
