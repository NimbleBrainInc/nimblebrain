/**
 * InlineSource contract tests.
 *
 * InlineSource is the base layer every in-process bundle (files, conversations,
 * automations, home, settings, usage, nb) is built on. These tests verify the
 * guarantees the source enforces for its handlers, so the same class of bug
 * can't recur in one bundle after another:
 *
 *  - The declared `inputSchema` is enforced before handlers run — missing or
 *    wrongly-typed params never reach fs/Buffer/etc. as Node-internal errors.
 *  - Unknown tool names return a structured error that lists the real ones.
 *  - Tools with permissive schemas still pass through.
 */

import { describe, expect, test } from "bun:test";
import { InlineSource, type InlineToolDef } from "../../../src/tools/inline-source.ts";
import { textContent } from "../../../src/engine/content-helpers.ts";
import type { ToolResult } from "../../../src/engine/types.ts";

// ── Helpers ────────────────────────────────────────────────────────

function okResult(payload: object): ToolResult {
  return { content: textContent(JSON.stringify(payload)), isError: false };
}

function parseFirst(result: ToolResult): unknown {
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("expected text block");
  return JSON.parse(first.text);
}

function makeSpy(returnValue: ToolResult = okResult({ ok: true })) {
  const calls: Array<Record<string, unknown>> = [];
  const handler = async (input: Record<string, unknown>): Promise<ToolResult> => {
    calls.push(input);
    return returnValue;
  };
  return { handler, calls };
}

function createDef(handler: InlineToolDef["handler"]): InlineToolDef {
  return {
    name: "create",
    description: "Create a thing.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string" },
        base64_data: { type: "string" },
        mime_type: { type: "string" },
      },
      required: ["filename", "base64_data", "mime_type"],
    },
    handler,
  };
}

// ── Schema validation ─────────────────────────────────────────────

describe("InlineSource — schema validation", () => {
  test("blocks handler when a required field is missing", async () => {
    const { handler, calls } = makeSpy();
    const source = new InlineSource("test", [createDef(handler)]);

    const result = await source.execute("create", {});

    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
    const body = parseFirst(result) as { error: string };
    expect(body.error).toContain('Invalid arguments for "create"');
    expect(body.error).toContain("filename");
    // No Node internals leak
    expect(body.error).not.toContain("Buffer");
    expect(body.error).not.toContain("fs.");
  });

  test("blocks handler when a field has the wrong type", async () => {
    const { handler, calls } = makeSpy();
    const source = new InlineSource("test", [createDef(handler)]);

    const result = await source.execute("create", {
      filename: "x.txt",
      base64_data: 12345, // number, not string
      mime_type: "text/plain",
    });

    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
    const body = parseFirst(result) as { error: string };
    expect(body.error).toContain("base64_data");
    expect(body.error).not.toContain("Buffer");
  });

  test("passes through to the handler when input satisfies the schema", async () => {
    const { handler, calls } = makeSpy(okResult({ id: "fl_abc" }));
    const source = new InlineSource("test", [createDef(handler)]);

    const result = await source.execute("create", {
      filename: "x.txt",
      base64_data: "aGVsbG8=",
      mime_type: "text/plain",
    });

    expect(result.isError).toBe(false);
    expect(calls).toEqual([{ filename: "x.txt", base64_data: "aGVsbG8=", mime_type: "text/plain" }]);
  });

  test("skips validation for tools with no declared constraints", async () => {
    const { handler, calls } = makeSpy(okResult({ files: [], total: 0 }));
    const source = new InlineSource("test", [
      {
        name: "list",
        description: "List things.",
        // No properties, no required — intentionally permissive.
        inputSchema: { type: "object" },
        handler,
      },
    ]);

    const result = await source.execute("list", {});

    expect(result.isError).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

// ── Unknown tool ──────────────────────────────────────────────────

describe("InlineSource — unknown tool", () => {
  test("returns structured error listing available tools", async () => {
    const { handler } = makeSpy();
    const source = new InlineSource("files", [
      createDef(handler),
      {
        name: "read",
        description: "Read.",
        inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        handler,
      },
    ]);

    const result = await source.execute("destroy", { id: "x" });

    expect(result.isError).toBe(true);
    const body = parseFirst(result) as { error: string };
    expect(body.error).toContain('Unknown tool "destroy"');
    expect(body.error).toContain('source "files"');
    expect(body.error).toContain("create");
    expect(body.error).toContain("read");
  });
});
