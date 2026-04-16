import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileConfig } from "../../../src/files/types.ts";
import { DEFAULT_FILE_CONFIG } from "../../../src/files/types.ts";
import type { Runtime } from "../../../src/runtime/runtime.ts";
import { createFilesSource } from "../../../src/tools/platform/files.ts";

function makeStubRuntime(workDir: string, config: Partial<FileConfig> = {}): Runtime {
  const merged = { ...DEFAULT_FILE_CONFIG, ...config };
  return {
    getWorkspaceScopedDir: () => workDir,
    getFilesConfig: () => merged,
  } as unknown as Runtime;
}

function extractText(result: { content: { type: string; text?: string }[] }): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
}

describe("platform files source — write size enforcement", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "nb-files-test-"));
    mkdirSync(join(workDir, "files"), { recursive: true });
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  test("write succeeds when decoded size is within maxFileSize", async () => {
    const runtime = makeStubRuntime(workDir, { maxFileSize: 1024 });
    const source = createFilesSource(runtime);

    const payload = Buffer.from("hello, world").toString("base64");
    const result = await source.execute("write", {
      filename: "hello.txt",
      base64_data: payload,
      mime_type: "text/plain",
    });

    expect(result.isError).toBe(false);
  });

  test("write rejects when decoded size exceeds maxFileSize", async () => {
    const runtime = makeStubRuntime(workDir, { maxFileSize: 8 });
    const source = createFilesSource(runtime);

    // 16 bytes decoded — over the 8-byte limit
    const payload = Buffer.from("0123456789abcdef").toString("base64");
    const result = await source.execute("write", {
      filename: "too-big.bin",
      base64_data: payload,
      mime_type: "application/octet-stream",
    });

    expect(result.isError).toBe(true);
    expect(extractText(result)).toContain("exceeds limit");
    expect(extractText(result)).toContain("too-big.bin");
  });

  test("write uses runtime config override (not just defaults)", async () => {
    const runtime = makeStubRuntime(workDir, { maxFileSize: 100 });
    const source = createFilesSource(runtime);

    // 50-byte decoded — under the 100 limit. Pins the runtime config as the
    // source of truth (not a hard-coded default).
    const payload = Buffer.from("x".repeat(50)).toString("base64");
    const result = await source.execute("write", {
      filename: "ok.txt",
      base64_data: payload,
      mime_type: "text/plain",
    });

    expect(result.isError).toBe(false);
  });
});
