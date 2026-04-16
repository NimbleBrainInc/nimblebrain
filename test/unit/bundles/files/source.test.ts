/**
 * Files InlineSource integration tests.
 *
 * The generic InlineSource contract (schema validation, unknown-tool errors)
 * is covered in test/unit/tools/inline-source.test.ts. This file only covers
 * what's specific to the files bundle: the on-disk round-trip and the tool
 * surface the model actually sees.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFilesSource } from "../../../../src/tools/platform/files.ts";
import type { ToolResult } from "../../../../src/engine/types.ts";
import type { Runtime } from "../../../../src/runtime/runtime.ts";
import type { InlineSource } from "../../../../src/tools/inline-source.ts";

function parseFirst(result: ToolResult): unknown {
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("expected text block");
  return JSON.parse(first.text);
}

function makeRuntime(workDir: string): Runtime {
  return {
    getWorkspaceScopedDir: () => workDir,
  } as unknown as Runtime;
}

let workDir: string;
let source: InlineSource;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "nb-files-test-"));
  source = createFilesSource(makeRuntime(workDir));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("files bundle", () => {
  test("advertises create (not write) as the canonical tool name", async () => {
    const tools = await source.tools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("files__create");
    expect(names).not.toContain("files__write");
  });

  test("create → read round-trips content on disk", async () => {
    const payload = "the quick brown fox";
    const encoded = Buffer.from(payload).toString("base64");

    const created = await source.execute("create", {
      filename: "fox.txt",
      base64_data: encoded,
      mime_type: "text/plain",
    });
    expect(created.isError).toBe(false);
    const { id } = parseFirst(created) as { id: string };
    expect(id).toMatch(/^fl_/);

    const read = await source.execute("read", { id });
    expect(read.isError).toBe(false);
    const body = parseFirst(read) as { base64Data: string; filename: string; mimeType: string };
    expect(Buffer.from(body.base64Data, "base64").toString("utf-8")).toBe(payload);
    expect(body.filename).toBe("fox.txt");
    expect(body.mimeType).toBe("text/plain");
  });

  test("read of nonexistent id surfaces a clean message (not a raw fs error)", async () => {
    const result = await source.execute("read", { id: "fl_doesnotexist" });
    expect(result.isError).toBe(true);
    const body = parseFirst(result) as { error: string };
    expect(body.error).toBe("File not found: fl_doesnotexist");
    expect(body.error).not.toContain("undefined");
    expect(body.error).not.toContain("ENOENT");
  });
});
