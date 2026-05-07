import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeJsonAtomic } from "../../src/util/atomic-json.ts";

function freshDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "nb-atomic-json-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("writeJsonAtomic", () => {
  test("writes JSON pretty-printed with trailing newline", async () => {
    const { dir, cleanup } = freshDir();
    try {
      const path = join(dir, "file.json");
      await writeJsonAtomic(path, { a: 1, b: [2, 3] });
      const raw = readFileSync(path, "utf-8");
      expect(raw).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}\n');
    } finally {
      cleanup();
    }
  });

  test("creates the file with mode 0o600 (owner read/write only)", async () => {
    const { dir, cleanup } = freshDir();
    try {
      const path = join(dir, "secret.json");
      await writeJsonAtomic(path, { token: "x" });
      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      cleanup();
    }
  });

  test("overwrites cleanly across calls — no tmp files left behind", async () => {
    const { dir, cleanup } = freshDir();
    try {
      const path = join(dir, "doc.json");
      await writeJsonAtomic(path, { v: 1 });
      await writeJsonAtomic(path, { v: 2 });
      await writeJsonAtomic(path, { v: 3 });
      expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ v: 3 });
      const leftovers = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
      expect(leftovers).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("concurrent writes to the same path don't deadlock or leak tmps", async () => {
    const { dir, cleanup } = freshDir();
    try {
      const path = join(dir, "race.json");
      // 10 concurrent writes — last-writer-wins on the rename target;
      // intermediate tmps land in the same dir and get cleaned up by
      // each rename. Test that no tmp survives.
      await Promise.all(
        Array.from({ length: 10 }, (_, i) => writeJsonAtomic(path, { i })),
      );
      expect(existsSync(path)).toBe(true);
      const leftovers = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
      expect(leftovers).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("propagates write failure (e.g. nonexistent dir) without leaking tmp", async () => {
    const { dir, cleanup } = freshDir();
    try {
      const path = join(dir, "missing-subdir", "nested.json");
      await expect(writeJsonAtomic(path, { x: 1 })).rejects.toThrow();
      // Parent dir was the temp dir — there should be no orphan .tmp
      // files in it. The `*.tmp` lives next to the target path
      // (which is inside the missing subdir), not in the parent.
      const leftovers = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
      expect(leftovers).toEqual([]);
    } finally {
      cleanup();
    }
  });
});
