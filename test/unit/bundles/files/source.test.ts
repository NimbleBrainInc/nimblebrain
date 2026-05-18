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
import { NoopEventSink } from "../../../../src/adapters/noop-events.ts";
import { createFilesSource } from "../../../../src/tools/platform/files.ts";
import type { ContentBlock, ToolResult } from "../../../../src/engine/types.ts";
import type { Runtime } from "../../../../src/runtime/runtime.ts";
import type { McpSource } from "../../../../src/tools/mcp-source.ts";

function parseFirst(result: ToolResult): unknown {
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("expected text block");
  return JSON.parse(first.text);
}

function findText(result: ToolResult): string {
  for (const block of result.content as ContentBlock[]) {
    if (block.type === "text" && typeof (block as { text?: unknown }).text === "string") {
      return (block as { text: string }).text;
    }
  }
  throw new Error("expected a text block in tool result");
}

function findResourceLink(result: ToolResult): {
  uri: string;
  name: string;
  mimeType?: string;
  size?: number;
} {
  for (const block of result.content as ContentBlock[]) {
    if ((block as { type?: string }).type === "resource_link") {
      return block as unknown as {
        uri: string;
        name: string;
        mimeType?: string;
        size?: number;
      };
    }
  }
  throw new Error("expected a resource_link block in tool result");
}

function makeRuntime(workDir: string): Runtime {
  return {
    getWorkspaceScopedDir: () => workDir,
    getFilesConfig: () => ({ maxExtractedTextSize: 204_800 }),
  } as unknown as Runtime;
}

let workDir: string;
let source: McpSource;

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), "nb-files-test-"));
  source = createFilesSource(makeRuntime(workDir), new NoopEventSink());
  await source.start();
});

afterEach(async () => {
  await source.stop();
  rmSync(workDir, { recursive: true, force: true });
});

describe("files bundle", () => {
  test("advertises create (not write) as the canonical tool name", async () => {
    const tools = await source.tools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("files__create");
    expect(names).not.toContain("files__write");
  });

  test("read of an extractable text file inlines the extracted text — never base64", async () => {
    const payload = "the quick brown fox";
    const encoded = Buffer.from(payload).toString("base64");

    const created = await source.execute("create", {
      manifest: { filename: "fox.txt", mimeType: "text/plain" },
      body: encoded,
    });
    expect(created.isError).toBe(false);
    const { id } = parseFirst(created) as { id: string };
    expect(id).toMatch(/^fl_/);

    const read = await source.execute("read", { id });
    expect(read.isError).toBe(false);

    // resource_link is present and points at the workspace file.
    const link = findResourceLink(read);
    expect(link.uri).toBe(`files://${id}`);
    expect(link.name).toBe("fox.txt");
    expect(link.mimeType).toBe("text/plain");
    expect(link.size).toBe(payload.length);

    // The text block contains the extracted text — that's how the model
    // actually receives the file's content.
    const text = findText(read);
    expect(text).toContain("Read fox.txt");
    expect(text).toContain(payload);

    // structuredContent carries the same shape, machine-readable.
    expect(read.structuredContent).toMatchObject({
      id,
      filename: "fox.txt",
      mimeType: "text/plain",
      extractedText: payload,
      truncated: false,
    });

    // Regression guard for the base64 bug: no part of the result can
    // serialize to a payload containing `base64Data` or the raw payload-as-base64.
    const serialized = JSON.stringify(read);
    expect(serialized).not.toContain("base64Data");
    expect(serialized).not.toContain(Buffer.from(payload).toString("base64"));
  });

  test("read of an image returns metadata only — no bytes", async () => {
    // Minimal valid 1x1 PNG.
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    const pngBytes = Buffer.from(pngBase64, "base64");

    const created = await source.execute("create", {
      manifest: { filename: "pixel.png", mimeType: "image/png" },
      body: pngBase64,
    });
    expect(created.isError).toBe(false);
    const { id } = parseFirst(created) as { id: string };

    const read = await source.execute("read", { id });
    expect(read.isError).toBe(false);

    const link = findResourceLink(read);
    expect(link.uri).toBe(`files://${id}`);
    expect(link.mimeType).toBe("image/png");
    expect(link.size).toBe(pngBytes.length);

    const text = findText(read);
    expect(text).toContain("Read pixel.png");
    // The text must NOT contain the PNG signature characters or the base64.
    expect(text).not.toContain(pngBase64);
    expect(text).not.toContain("iVBORw0KGgo");

    expect(read.structuredContent).toMatchObject({
      filename: "pixel.png",
      mimeType: "image/png",
      extractedText: null,
    });

    const serialized = JSON.stringify(read);
    expect(serialized).not.toContain("base64Data");
    expect(serialized).not.toContain(pngBase64);
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
