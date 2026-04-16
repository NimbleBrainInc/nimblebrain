import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  WORKSPACE_DIRS,
  scaffoldWorkspace,
} from "../../../src/workspace/scaffold.ts";

let wsPath: string;

beforeEach(async () => {
  wsPath = await mkdtemp(join(tmpdir(), "scaffold-test-"));
});

afterEach(async () => {
  await rm(wsPath, { recursive: true, force: true });
});

describe("scaffoldWorkspace", () => {
  test("creates all required subdirectories", async () => {
    await scaffoldWorkspace(wsPath);

    for (const dir of WORKSPACE_DIRS) {
      const dirPath = join(wsPath, dir);
      expect(existsSync(dirPath)).toBe(true);
      expect(statSync(dirPath).isDirectory()).toBe(true);
    }
  });

  test("creates .gitkeep files in each directory", async () => {
    await scaffoldWorkspace(wsPath);

    for (const dir of WORKSPACE_DIRS) {
      const gitkeep = join(wsPath, dir, ".gitkeep");
      expect(existsSync(gitkeep)).toBe(true);
    }
  });

  test("is idempotent — running twice does not error", async () => {
    await scaffoldWorkspace(wsPath);
    await scaffoldWorkspace(wsPath);

    for (const dir of WORKSPACE_DIRS) {
      expect(existsSync(join(wsPath, dir))).toBe(true);
    }
  });

  test("does not destroy existing data in directories", async () => {
    await scaffoldWorkspace(wsPath);

    // Write a file into the data/ directory
    const testFile = join(wsPath, "data", "important.json");
    await writeFile(testFile, '{"key":"value"}');

    // Re-scaffold
    await scaffoldWorkspace(wsPath);

    expect(existsSync(testFile)).toBe(true);
  });

  test("directories are readable and writable", async () => {
    await scaffoldWorkspace(wsPath);

    for (const dir of WORKSPACE_DIRS) {
      const testFile = join(wsPath, dir, "write-test.tmp");
      await writeFile(testFile, "ok");
      expect(existsSync(testFile)).toBe(true);
    }
  });
});
