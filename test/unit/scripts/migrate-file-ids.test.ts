/**
 * Tests for `scripts/lib/migrate-file-ids.ts` — the plan and apply behind
 * `bun run migrate:file-ids`, driven against a fixture work dir.
 *
 * The headline assertion: after apply, every migrated file is readable through
 * the real `FileStore` under an id the runtime's own validator (`FILE_ID_RE`)
 * accepts, and no reference the runtime reads still names an old id.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  applyFileIdMigration,
  isLegacyFileId,
  planFileIdMigration,
  readMapping,
  rewriteFileIds,
} from "../../../scripts/lib/migrate-file-ids.ts";
import { createFileStore } from "../../../src/files/store.ts";
import { FILE_ID_RE } from "../../../src/files/uri.ts";

const OLD_A = "fl_mo7gybgy_5ad5f8a8";
const OLD_B = "fl_mo7h0000_0badf00d";
const CURRENT = "fl_0123456789abcdef01234567";
const PARTITION = join("workspaces", "ws_aaaaaaaaaaaaaaaa", "files", "usr_1");
const CONV = join("workspaces", "ws_aaaaaaaaaaaaaaaa", "conversations", "usr_1", "conv_1.jsonl");

let workDir: string;

function put(rel: string, content: string): void {
  const abs = join(workDir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function read(rel: string): string {
  return readFileSync(join(workDir, rel), "utf-8");
}

function entry(id: string, filename: string): string {
  return JSON.stringify({
    id,
    filename,
    mimeType: "text/plain",
    size: 5,
    tags: [],
    source: "chat",
    conversationId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    description: null,
  });
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "migrate-file-ids-"));
  put(
    join(PARTITION, "registry.jsonl"),
    `${[entry(OLD_A, "a.txt"), entry(OLD_B, "b.txt"), entry(CURRENT, "c.txt")].join("\n")}\n`,
  );
  put(join(PARTITION, `${OLD_A}_a.txt`), "aaaaa");
  put(
    join(PARTITION, `${OLD_A}.extracted.json`),
    JSON.stringify({ text: "aaaaa", maxSize: 10, truncated: false }),
  );
  put(join(PARTITION, `${OLD_B}_b.txt`), `mentions ${OLD_A} inside user content`);
  put(join(PARTITION, `${CURRENT}_c.txt`), "ccccc");
  put(
    CONV,
    `${JSON.stringify({ type: "user.message", content: [{ type: "resource_link", uri: `files://${OLD_A}` }] })}\n` +
      `${JSON.stringify({ type: "tool.done", output: `saved ${OLD_B} and ${OLD_A}; also ${CURRENT}` })}\n`,
  );
  put(
    join("logs", "workspace", "2026-01-01.jsonl"),
    `${JSON.stringify({ msg: `files://${OLD_A}` })}\n`,
  );
  put(join("users", "usr_1", "files", "registry.jsonl"), `${entry(OLD_A, "a.txt")}\n`);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("isLegacyFileId", () => {
  test("matches the retired form only", () => {
    expect(isLegacyFileId(OLD_A)).toBe(true);
    expect(isLegacyFileId(CURRENT)).toBe(false);
    expect(isLegacyFileId(`${OLD_A}x`)).toBe(false);
  });
});

describe("rewriteFileIds", () => {
  const mapping = new Map([[OLD_A, CURRENT]]);

  test("rewrites files:// URIs, bare ids, and blob-name prefixes", () => {
    const { text, count } = rewriteFileIds(`files://${OLD_A} ${OLD_A} ${OLD_A}_a.txt`, mapping);
    expect(text).toBe(`files://${CURRENT} ${CURRENT} ${CURRENT}_a.txt`);
    expect(count).toBe(3);
  });

  test("leaves an id that merely contains a mapped id, and unmapped ids", () => {
    const input = `x${OLD_A} ${OLD_A}9 ${OLD_B}`;
    expect(rewriteFileIds(input, mapping)).toEqual({ text: input, count: 0 });
  });
});

describe("planFileIdMigration", () => {
  test("a dry-run plans every legacy id and writes nothing", () => {
    const before = readdirSync(workDir).sort();
    const plan = planFileIdMigration(workDir);

    expect(Object.keys(plan.mapping).sort()).toEqual([OLD_A, OLD_B].sort());
    for (const rec of Object.values(plan.mapping)) {
      expect(FILE_ID_RE.test(rec.newId)).toBe(true);
      expect(rec.partitions).toEqual([PARTITION]);
    }
    expect(plan.renames.map((r) => r.kind).sort()).toEqual(["blob", "blob", "sidecar"]);
    expect(plan.rewrites.map((r) => [r.kind, r.refs]).sort()).toEqual([
      ["conversation", 3],
      ["registry", 2],
    ]);
    expect(plan.skipped).toEqual({ logs: 1, archived: 0, users: 1, fileContents: 1 });
    expect(plan.errors).toEqual([]);

    expect(readdirSync(workDir).sort()).toEqual(before);
    expect(existsSync(join(workDir, ".migrations"))).toBe(false);
  });

  test("counts a legacy-shaped reference no partition owns, and leaves it", () => {
    put(
      join("workspaces", "ws_aaaaaaaaaaaaaaaa", "tasks", "t.json"),
      JSON.stringify({ ref: "fl_zzzzzzzz_deadbeef" }),
    );
    const plan = planFileIdMigration(workDir);
    expect(plan.orphanRefs).toBe(1);
    expect(plan.rewrites.some((r) => r.path.endsWith("t.json"))).toBe(false);
  });
  test("skips symlinks, so a link loop neither recurses nor double-counts", () => {
    symlinkSync("..", join(workDir, "workspaces", "ws_aaaaaaaaaaaaaaaa", "loop"));
    const plan = planFileIdMigration(workDir);
    expect(Object.keys(plan.mapping).sort()).toEqual([OLD_A, OLD_B].sort());
    expect(plan.rewrites.every((r) => !r.path.includes("loop"))).toBe(true);
  });
});

describe("applyFileIdMigration", () => {
  test("renames, rewrites, backs up, and the store reads the file under its new id", async () => {
    const plan = planFileIdMigration(workDir);
    const result = applyFileIdMigration(workDir, plan, "run1");
    const newA = plan.mapping[OLD_A]?.newId as string;
    const newB = plan.mapping[OLD_B]?.newId as string;

    expect(result).toMatchObject({ rewritten: 2, refs: 5, renamed: 3 });

    const store = createFileStore(join(workDir, PARTITION));
    const file = await store.readFile(newA);
    expect(file.filename).toBe("a.txt");
    expect(file.data.toString()).toBe("aaaaa");
    expect((await store.readExtractedText(newA))?.text).toBe("aaaaa");
    expect(await store.findEntry(OLD_A)).toBeNull();
    expect((await store.readRegistry()).map((e) => e.id).sort()).toEqual(
      [newA, newB, CURRENT].sort(),
    );

    const conv = read(CONV);
    expect(conv).toContain(`files://${newA}`);
    expect(conv).toContain(`saved ${newB} and ${newA}; also ${CURRENT}`);
    expect(conv).not.toContain(OLD_A);

    // User content, logs, and the reader-less legacy registry are untouched.
    expect(read(join(PARTITION, `${newB}_b.txt`))).toContain(OLD_A);
    expect(read(join("logs", "workspace", "2026-01-01.jsonl"))).toContain(OLD_A);
    expect(read(join("users", "usr_1", "files", "registry.jsonl"))).toContain(OLD_A);

    // Backups hold the pre-rewrite bytes; the mapping is the audit record.
    expect(read(join(".migrations", "file-ids", "backups", "run1", CONV))).toContain(
      `files://${OLD_A}`,
    );
    expect(readMapping(workDir)[OLD_A]?.newId).toBe(newA);
  });

  test("a second run is a no-op", () => {
    applyFileIdMigration(workDir, planFileIdMigration(workDir), "run1");
    const after = read(CONV);
    const again = planFileIdMigration(workDir);
    expect(again.minted).toEqual([]);
    expect(again.renames).toEqual([]);
    expect(again.rewrites).toEqual([]);
    expect(read(CONV)).toBe(after);
  });

  test("an interrupted run resumes with the persisted ids", () => {
    const plan = planFileIdMigration(workDir);
    // Simulate a crash after the mapping and rewrites, before any rename.
    applyFileIdMigration(workDir, { ...plan, renames: [] }, "run1");
    const resumed = planFileIdMigration(workDir);
    expect(resumed.minted).toEqual([]);
    expect(resumed.rewrites).toEqual([]);
    expect(resumed.renames).toHaveLength(3);
    applyFileIdMigration(workDir, resumed, "run2");
    const newA = plan.mapping[OLD_A]?.newId as string;
    expect(existsSync(join(workDir, PARTITION, `${newA}_a.txt`))).toBe(true);
    expect(planFileIdMigration(workDir).renames).toEqual([]);
  });

  test("a file copied into a second owner's partition takes the same new id in both", async () => {
    const other = join("workspaces", "ws_aaaaaaaaaaaaaaaa", "files", "usr_2");
    const otherConv = join(
      "workspaces",
      "ws_aaaaaaaaaaaaaaaa",
      "conversations",
      "usr_2",
      "c.jsonl",
    );
    put(join(other, "registry.jsonl"), `${entry(OLD_A, "a.txt")}\n`);
    put(join(other, `${OLD_A}_a.txt`), "aaaaa");
    put(otherConv, `${JSON.stringify({ uri: `files://${OLD_A}` })}\n`);

    const plan = planFileIdMigration(workDir);
    expect(plan.errors).toEqual([]);
    expect(plan.mapping[OLD_A]?.partitions.sort()).toEqual([PARTITION, other].sort());
    applyFileIdMigration(workDir, plan, "run1");

    const newA = plan.mapping[OLD_A]?.newId as string;
    for (const partition of [PARTITION, other]) {
      const file = await createFileStore(join(workDir, partition)).readFile(newA);
      expect(file.data.toString()).toBe("aaaaa");
    }
    expect(read(otherConv)).toContain(`files://${newA}`);
  });

  test("refuses a plan with errors", () => {
    const plan = planFileIdMigration(workDir);
    expect(() => applyFileIdMigration(workDir, { ...plan, errors: ["x"] }, "run1")).toThrow();
    expect(existsSync(join(workDir, ".migrations"))).toBe(false);
  });
});
