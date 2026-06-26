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
import { roomFilesDir } from "../../../../src/files/paths.ts";
import { createFileStore } from "../../../../src/files/store.ts";
import { createFilesSource } from "../../../../src/tools/platform/files.ts";
import type { ContentBlock, ToolResult } from "../../../../src/engine/types.ts";
import { runWithRequestContext } from "../../../../src/runtime/request-context.ts";
import type { Runtime } from "../../../../src/runtime/runtime.ts";
import type { McpSource } from "../../../../src/tools/mcp-source.ts";
import type { FilesReadPdfPagesOutput } from "../../../../src/tools/platform/schemas/files.ts";

/** The owner and focused room every handler call in this file runs as. */
const OWNER_ID = "usr_test";
const WS_ID = "ws_user_usr_test";

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
  // Files are room-owned: the source resolves its store via
  // `getRoomFileStore(fileWorkspaceId, resolveRequestUserId(getCurrentIdentity()))`,
  // where the room comes from the request context (see `exec`) and the owner
  // from the current identity. The mock roots each store at the matching room
  // partition so the on-disk round-trip is exercised faithfully.
  return {
    getCurrentIdentity: () => ({ id: OWNER_ID }),
    resolveRequestUserId: (identity?: { id: string }) => identity?.id ?? OWNER_ID,
    getRoomFileStore: (wsId: string, ownerId: string) =>
      createFileStore(roomFilesDir(workDir, wsId, ownerId)),
    getFilesConfig: () => ({ maxExtractedTextSize: 204_800 }),
  } as unknown as Runtime;
}

/**
 * Run a files tool the way the runtime does during a chat: inside a request
 * context whose `fileWorkspaceId` names the focused room. Without it the
 * room-owned store has no room in scope and `getStore()` throws.
 */
function exec(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
  return runWithRequestContext(
    { identity: null, scope: { kind: "identity" }, fileWorkspaceId: WS_ID },
    () => source.execute(tool, args),
  );
}

function pdfString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function makeTextPdf(pageTexts: string[]): Buffer {
  const objects: string[] = [];
  const pageObjectIds = pageTexts.map((_, index) => 4 + index * 2);

  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageTexts.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

  for (let index = 0; index < pageTexts.length; index++) {
    const pageId = 4 + index * 2;
    const contentId = pageId + 1;
    const content = `BT /F1 24 Tf 72 720 Td (${pdfString(pageTexts[index]!)}) Tj ET`;
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;
    objects[contentId] = `<< /Length ${Buffer.byteLength(content, "utf-8")} >>\nstream\n${content}\nendstream`;
  }

  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (let id = 1; id < objects.length; id++) {
    const object = objects[id];
    if (!object) continue;
    offsets[id] = Buffer.byteLength(body, "utf-8");
    body += `${id} 0 obj\n${object}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(body, "utf-8");
  body += `xref\n0 ${objects.length}\n`;
  body += "0000000000 65535 f \n";
  for (let id = 1; id < objects.length; id++) {
    body += `${String(offsets[id] ?? 0).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "utf-8");
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
    expect(names).toContain("files__read_pdf_pages");
    expect(names).not.toContain("files__write");
  });

  test("read of an extractable text file inlines the extracted text — never base64", async () => {
    const payload = "the quick brown fox";
    const encoded = Buffer.from(payload).toString("base64");

    const created = await exec("create", {
      manifest: { filename: "fox.txt", mimeType: "text/plain" },
      body: encoded,
    });
    expect(created.isError).toBe(false);
    const { id } = parseFirst(created) as { id: string };
    expect(id).toMatch(/^fl_/);

    const read = await exec("read", { id });
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

    const created = await exec("create", {
      manifest: { filename: "pixel.png", mimeType: "image/png" },
      body: pngBase64,
    });
    expect(created.isError).toBe(false);
    const { id } = parseFirst(created) as { id: string };

    const read = await exec("read", { id });
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
    const result = await exec("read", { id: "fl_doesnotexist" });
    expect(result.isError).toBe(true);
    const body = parseFirst(result) as { error: string };
    expect(body.error).toBe("File not found: fl_doesnotexist");
    expect(body.error).not.toContain("undefined");
    expect(body.error).not.toContain("ENOENT");
  });

  test("read_pdf_pages returns only requested PDF page text", async () => {
    const pdf = makeTextPdf([
      "page one should stay hidden",
      "page two has the relevant appendix",
      "page three should stay hidden",
    ]);

    const created = await exec("create", {
      manifest: { filename: "report.pdf", mimeType: "application/pdf" },
      body: pdf.toString("base64"),
    });
    expect(created.isError).toBe(false);
    const { id } = parseFirst(created) as { id: string };

    const result = await exec("read_pdf_pages", { id, pages: [2] });
    expect(result.isError).toBe(false);

    const link = findResourceLink(result);
    expect(link.uri).toBe(`files://${id}`);
    expect(link.mimeType).toBe("application/pdf");

    const text = findText(result);
    expect(text).toContain("Read PDF pages 2 from report.pdf");
    expect(text).toContain("--- Page 2 ---");
    expect(text).toContain("page two has the relevant appendix");
    expect(text).not.toContain("page one should stay hidden");
    expect(text).not.toContain("page three should stay hidden");
    expect(JSON.stringify(result)).not.toContain(pdf.toString("base64"));

    const structured = result.structuredContent as unknown as FilesReadPdfPagesOutput;
    expect(structured).toMatchObject({
      id,
      filename: "report.pdf",
      mimeType: "application/pdf",
      totalPages: 3,
      requestedPages: [2],
      missingPages: [],
    });
    expect(structured.pages).toHaveLength(1);
    expect(structured.pages[0]).toMatchObject({
      page: 2,
      text: "page two has the relevant appendix",
      truncated: false,
      empty: false,
    });
  });

  test("read_pdf_pages reports out-of-range pages without failing valid pages", async () => {
    const pdf = makeTextPdf(["only page"]);

    const created = await exec("create", {
      manifest: { filename: "single.pdf", mimeType: "application/pdf" },
      body: pdf.toString("base64"),
    });
    expect(created.isError).toBe(false);
    const { id } = parseFirst(created) as { id: string };

    const result = await exec("read_pdf_pages", { id, pages: [99, 1, 1] });
    expect(result.isError).toBe(false);

    const text = findText(result);
    expect(text).toContain("--- Page 1 ---");
    expect(text).toContain("only page");
    expect(text).toContain("Missing pages: 99 (PDF has 1 page).");

    const structured = result.structuredContent as unknown as FilesReadPdfPagesOutput;
    expect(structured.requestedPages).toEqual([1, 99]);
    expect(structured.missingPages).toEqual([99]);
    expect(structured.pages.map((page) => page.page)).toEqual([1]);
  });

  test("read_pdf_pages rejects non-PDF files cleanly", async () => {
    const created = await exec("create", {
      manifest: { filename: "notes.txt", mimeType: "text/plain" },
      body: Buffer.from("not a pdf").toString("base64"),
    });
    expect(created.isError).toBe(false);
    const { id } = parseFirst(created) as { id: string };

    const result = await exec("read_pdf_pages", { id, pages: [1] });
    expect(result.isError).toBe(true);
    const body = parseFirst(result) as { error: string };
    expect(body.error).toBe("File is not a PDF: notes.txt (text/plain)");
  });

  test("read_pdf_pages rejects empty page lists at schema validation", async () => {
    const result = await exec("read_pdf_pages", { id: "fl_any", pages: [] });

    expect(result.isError).toBe(true);
    const body = parseFirst(result) as { error: string };
    expect(body.error).toContain('Invalid arguments for "read_pdf_pages"');
    expect(body.error).toContain("/pages: must NOT have fewer than 1 items");
  });

  test("read_pdf_pages rejects more than 10 pages at schema validation", async () => {
    const result = await exec("read_pdf_pages", {
      id: "fl_any",
      pages: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    });

    expect(result.isError).toBe(true);
    const body = parseFirst(result) as { error: string };
    expect(body.error).toContain('Invalid arguments for "read_pdf_pages"');
    expect(body.error).toContain("/pages: must NOT have more than 10 items");
  });
});
