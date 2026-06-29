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
import { createFileStore } from "../../../../src/files/store.ts";
import type { FileEntry } from "../../../../src/files/types.ts";
import { createFilesSource } from "../../../../src/tools/platform/files.ts";
import type { ContentBlock, ToolResult } from "../../../../src/engine/types.ts";
import type { Runtime } from "../../../../src/runtime/runtime.ts";
import type { McpSource } from "../../../../src/tools/mcp-source.ts";
import type { FilesReadPdfPagesOutput } from "../../../../src/tools/platform/schemas/files.ts";

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
  // Files are identity-owned: the source resolves its store via
  // `resolveRequestUserId(getCurrentIdentity())` + `getFileStore(userId)`. The
  // mock keeps the store at `<workDir>/files` so the on-disk assertions are
  // unchanged.
  return {
    getCurrentIdentity: () => ({ id: "usr_test" }),
    resolveRequestUserId: (identity?: { id: string }) => identity?.id ?? "usr_test",
    getFileStore: () => createFileStore(join(workDir, "files")),
    getFilesConfig: () => ({ maxExtractedTextSize: 204_800 }),
  } as unknown as Runtime;
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

  test("read_pdf_pages returns only requested PDF page text", async () => {
    const pdf = makeTextPdf([
      "page one should stay hidden",
      "page two has the relevant appendix",
      "page three should stay hidden",
    ]);

    const created = await source.execute("create", {
      manifest: { filename: "report.pdf", mimeType: "application/pdf" },
      body: pdf.toString("base64"),
    });
    expect(created.isError).toBe(false);
    const { id } = parseFirst(created) as { id: string };

    const result = await source.execute("read_pdf_pages", { id, pages: [2] });
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

    const created = await source.execute("create", {
      manifest: { filename: "single.pdf", mimeType: "application/pdf" },
      body: pdf.toString("base64"),
    });
    expect(created.isError).toBe(false);
    const { id } = parseFirst(created) as { id: string };

    const result = await source.execute("read_pdf_pages", { id, pages: [99, 1, 1] });
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
    const created = await source.execute("create", {
      manifest: { filename: "notes.txt", mimeType: "text/plain" },
      body: Buffer.from("not a pdf").toString("base64"),
    });
    expect(created.isError).toBe(false);
    const { id } = parseFirst(created) as { id: string };

    const result = await source.execute("read_pdf_pages", { id, pages: [1] });
    expect(result.isError).toBe(true);
    const body = parseFirst(result) as { error: string };
    expect(body.error).toBe("File is not a PDF: notes.txt (text/plain)");
  });

  test("read_pdf_pages rejects empty page lists at schema validation", async () => {
    const result = await source.execute("read_pdf_pages", { id: "fl_any", pages: [] });

    expect(result.isError).toBe(true);
    const body = parseFirst(result) as { error: string };
    expect(body.error).toContain('Invalid arguments for "read_pdf_pages"');
    expect(body.error).toContain("/pages: must NOT have fewer than 1 items");
  });

  test("read_pdf_pages rejects more than 10 pages at schema validation", async () => {
    const result = await source.execute("read_pdf_pages", {
      id: "fl_any",
      pages: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    });

    expect(result.isError).toBe(true);
    const body = parseFirst(result) as { error: string };
    expect(body.error).toContain('Invalid arguments for "read_pdf_pages"');
    expect(body.error).toContain("/pages: must NOT have more than 10 items");
  });
});

// ---------------------------------------------------------------------------
// Room (workspace) filtering — the list scopes to the focused room before the
// limit, mirroring the conversation-list filter.
// ---------------------------------------------------------------------------

function fileEntry(over: Partial<FileEntry> & { id: string }): FileEntry {
  return {
    id: over.id,
    filename: `${over.id}.txt`,
    mimeType: "text/plain",
    size: 10,
    tags: [],
    source: "manual",
    conversationId: null,
    createdAt: "2025-01-01T00:00:00.000Z",
    description: null,
    ...over,
  };
}

function listOut(result: ToolResult): { files: Array<{ id: string }>; totalCount: number } {
  return parseFirst(result) as { files: Array<{ id: string }>; totalCount: number };
}

function listFiles(result: ToolResult): string[] {
  return listOut(result).files.map((f) => f.id);
}

describe("files room filtering", () => {
  async function seed(): Promise<void> {
    const store = createFileStore(join(workDir, "files"));
    await store.ensureFilesDir();
    await store.appendRegistry(fileEntry({ id: "fl_helix", workspaceId: "ws_helix" }));
    await store.appendRegistry(fileEntry({ id: "fl_acme", workspaceId: "ws_acme" }));
    await store.appendRegistry(fileEntry({ id: "fl_legacy" })); // no stamped room
  }

  test("workspaceId scopes to that room, excluding other rooms and roomless files", async () => {
    await seed();
    const res = await source.execute("list", { workspaceId: "ws_helix" });
    expect(res.isError).toBe(false);
    expect(listFiles(res)).toEqual(["fl_helix"]);
    expect(listOut(res).totalCount).toBe(1);
  });

  test("includeUnstamped folds roomless files into the personal room", async () => {
    await seed();
    const res = await source.execute("list", {
      workspaceId: "ws_user_u1",
      includeUnstamped: true,
    });
    expect(listFiles(res)).toEqual(["fl_legacy"]);
  });

  test("no workspaceId returns all rooms' files", async () => {
    await seed();
    const res = await source.execute("list", {});
    expect(listFiles(res).sort()).toEqual(["fl_acme", "fl_helix", "fl_legacy"]);
  });

  test("the room filter runs before the limit (no post-pagination under-count)", async () => {
    const store = createFileStore(join(workDir, "files"));
    await store.ensureFilesDir();
    // 25 Acme files newer than one older Helix file.
    for (let i = 0; i < 25; i++) {
      const day = String(i + 1).padStart(2, "0");
      await store.appendRegistry(
        fileEntry({
          id: `fl_acme_${i}`,
          workspaceId: "ws_acme",
          createdAt: `2025-02-${day}T00:00:00.000Z`,
        }),
      );
    }
    await store.appendRegistry(
      fileEntry({ id: "fl_helix_old", workspaceId: "ws_helix", createdAt: "2025-01-01T00:00:00.000Z" }),
    );

    // The global most-recent page of 20 is all Acme — the Helix file isn't in it.
    const globalPage = await source.execute("list", { limit: 20 });
    expect(listFiles(globalPage)).not.toContain("fl_helix_old");

    // Room-scoped: the limit applies to Helix's set, so its file is returned.
    const helix = await source.execute("list", { limit: 20, workspaceId: "ws_helix" });
    expect(listFiles(helix)).toEqual(["fl_helix_old"]);
    expect(listOut(helix).totalCount).toBe(1);
  });
});
