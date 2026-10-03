/**
 * Files app: folders, moving files, and the server-side list (filters,
 * facets, paging). Driven through the source's tools, as the browser and the
 * agent reach them.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../../../src/adapters/noop-events.ts";
import type { ToolResult } from "../../../../src/engine/types.ts";
import { workspaceFilesDir } from "../../../../src/files/paths.ts";
import { createFileStore, type FileStore } from "../../../../src/files/store.ts";
import type { FileEntry } from "../../../../src/files/types.ts";
import { fileKind } from "../../../../src/platform/files/query.ts";
import { createFilesSource } from "../../../../src/platform/files/source.ts";
import type {
  FilesCreateOutput,
  FilesFolderOutput,
  FilesListOutput,
  FilesMoveOutput,
} from "../../../../src/platform/schemas/files.ts";
import {
  type RequestContext,
  runWithRequestContext,
} from "../../../../src/runtime/request-context.ts";
import type { Runtime } from "../../../../src/runtime/runtime.ts";
import type { McpSource } from "../../../../src/tools/mcp-source.ts";
import { seedWorkspaceRoot } from "../../../helpers/test-workspace.ts";

const OWNER_ID = "usr_test";
const WS_ID = "ws_00859aff6f095b0e";

let workDir: string;
let source: McpSource;
let store: FileStore;

function makeRuntime(dir: string): Runtime {
  return {
    getCurrentIdentity: () => ({ id: OWNER_ID }),
    resolveRequestUserId: (identity?: { id: string }) => identity?.id ?? OWNER_ID,
    getWorkspaceFileStore: (wsId: string, ownerId: string) =>
      createFileStore(workspaceFilesDir(dir, wsId, ownerId)),
    getFilesConfig: () => ({ maxExtractedTextSize: 204_800 }),
  } as unknown as Runtime;
}

function exec(
  tool: string,
  args: Record<string, unknown>,
  ctx: Partial<RequestContext> = {},
): Promise<ToolResult> {
  return runWithRequestContext({ identity: null, workspaceId: WS_ID, ...ctx }, () =>
    source.execute(tool, args),
  );
}

function parse<T>(result: ToolResult): T {
  const first = result.content[0];
  if (first?.type !== "text") throw new Error("expected text block");
  return JSON.parse(first.text) as T;
}

function errorOf(result: ToolResult): string {
  expect(result.isError).toBe(true);
  return parse<{ error: string }>(result).error;
}

async function list(args: Record<string, unknown> = {}): Promise<FilesListOutput> {
  const result = await exec("list", args);
  expect(result.isError).toBe(false);
  return parse<FilesListOutput>(result);
}

async function folder(name: string, parentId?: string): Promise<FilesFolderOutput> {
  const result = await exec("create_folder", { manifest: { name, parentId } });
  expect(result.isError).toBe(false);
  return parse<FilesFolderOutput>(result);
}

/** Seed a registry entry directly, so dates, sources, and types are exact. */
async function seed(partial: Partial<FileEntry> & { id: string; filename: string }) {
  await store.appendRegistry({
    mimeType: "text/plain",
    size: 10,
    tags: [],
    source: "agent",
    conversationId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    description: null,
    ...partial,
  });
}

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), "nb-files-folders-"));
  seedWorkspaceRoot(workDir, WS_ID);
  store = createFileStore(workspaceFilesDir(workDir, WS_ID, OWNER_ID));
  source = createFilesSource(makeRuntime(workDir), new NoopEventSink());
  await source.start();
});

afterEach(async () => {
  await source.stop();
  rmSync(workDir, { recursive: true, force: true });
});

describe("folders", () => {
  test("a folder lists with its parent's other contents and a breadcrumb", async () => {
    const reports = await folder("Reports");
    const q3 = await folder("Q3", reports.id);
    expect(q3.path).toBe("Reports/Q3");

    await seed({ id: "fl_a", filename: "top.txt" });
    await seed({ id: "fl_b", filename: "inside.txt", folderId: reports.id });

    const root = await list({ folderId: "root" });
    expect(root.files.map((f) => f.id)).toEqual(["fl_a"]);
    expect(root.folders.map((f) => f.name)).toEqual(["Reports"]);
    expect(root.breadcrumb).toEqual([]);

    const inReports = await list({ folderId: reports.id });
    expect(inReports.files.map((f) => f.id)).toEqual(["fl_b"]);
    expect(inReports.files[0]?.folderPath).toBe("Reports");
    expect(inReports.folders.map((f) => f.name)).toEqual(["Q3"]);

    const inQ3 = await list({ folderId: q3.id });
    expect(inQ3.breadcrumb.map((c) => c.name)).toEqual(["Reports", "Q3"]);
  });

  test("a sibling name is unique, case-insensitively", async () => {
    await folder("Reports");
    const result = await exec("create_folder", { manifest: { name: "reports" } });
    expect(errorOf(result)).toContain("already exists");
  });

  test("a name with a slash is refused at the schema", async () => {
    const result = await exec("create_folder", { manifest: { name: "a/b" } });
    expect(result.isError).toBe(true);
  });

  test("rename and move keep the folder's contents with it", async () => {
    const a = await folder("A");
    const b = await folder("B");
    await seed({ id: "fl_x", filename: "x.txt", folderId: a.id });

    const moved = parse<FilesFolderOutput>(
      await exec("update_folder", { id: a.id, manifest: { name: "Archive", parentId: b.id } }),
    );
    expect(moved.path).toBe("B/Archive");

    const inside = await list({ folderId: a.id });
    expect(inside.files.map((f) => f.folderPath)).toEqual(["B/Archive"]);
  });

  test("a folder cannot move into itself or below itself", async () => {
    const a = await folder("A");
    const child = await folder("Child", a.id);
    expect(
      errorOf(await exec("update_folder", { id: a.id, manifest: { parentId: a.id } })),
    ).toContain("cannot be moved");
    expect(
      errorOf(await exec("update_folder", { id: a.id, manifest: { parentId: child.id } })),
    ).toContain("cannot be moved");
  });

  test("a folder that holds anything is not deleted, and says what it holds", async () => {
    const a = await folder("A");
    await folder("Child", a.id);
    await seed({ id: "fl_x", filename: "x.txt", folderId: a.id });

    const refusal = errorOf(await exec("delete_folder", { id: a.id }));
    expect(refusal).toContain("1 file and 1 folder");
    expect((await list({ folderId: "root" })).folders).toHaveLength(1);
  });

  test("an empty folder is deleted", async () => {
    const a = await folder("A");
    expect((await exec("delete_folder", { id: a.id })).isError).toBe(false);
    expect((await list({ folderId: "root" })).folders).toHaveLength(0);
  });

  test("listing a folder that does not exist is an error", async () => {
    const result = await exec("list", { folderId: `fd_${"0".repeat(24)}` });
    expect(errorOf(result)).toContain("Folder not found");
  });
});

describe("move", () => {
  test("moves files into a folder and back to the top level", async () => {
    const a = await folder("A");
    await seed({ id: "fl_1", filename: "one.txt" });
    await seed({ id: "fl_2", filename: "two.txt" });

    const out = parse<FilesMoveOutput>(
      await exec("move", { ids: ["fl_1", "fl_2"], folderId: a.id }),
    );
    expect(out.folderId).toBe(a.id);
    expect((await list({ folderId: a.id })).total).toBe(2);

    await exec("move", { ids: ["fl_1"], folderId: "root" });
    expect((await list({ folderId: "root" })).files.map((f) => f.id)).toEqual(["fl_1"]);
  });

  test("an unknown id moves nothing", async () => {
    const a = await folder("A");
    await seed({ id: "fl_1", filename: "one.txt" });
    expect(errorOf(await exec("move", { ids: ["fl_1", "fl_nope"], folderId: a.id }))).toContain(
      "fl_nope",
    );
    expect((await list({ folderId: a.id })).total).toBe(0);
  });
});

describe("create", () => {
  test("a folder path is created as needed and reused", async () => {
    const first = parse<FilesCreateOutput>(
      await exec("create", {
        manifest: { filename: "a.md", mimeType: "text/markdown", folder: "Reports/Q3" },
        body: "# a",
        encoding: "text",
      }),
    );
    const second = parse<FilesCreateOutput>(
      await exec("create", {
        manifest: { filename: "b.md", mimeType: "text/markdown", folder: "/reports/q3/" },
        body: "# b",
        encoding: "text",
      }),
    );
    expect(first.folderId).not.toBeNull();
    expect(second.folderId).toBe(first.folderId);
    expect((await list({ folderId: "root" })).folders.map((f) => f.name)).toEqual(["Reports"]);
  });

  test("stamps the conversation in a chat and the run in an automation run", async () => {
    const inChat = parse<FilesCreateOutput>(
      await exec(
        "create",
        { manifest: { filename: "c.txt", mimeType: "text/plain" }, body: "c", encoding: "text" },
        { conversationId: "conv_1" },
      ),
    );
    const inRun = parse<FilesCreateOutput>(
      await exec(
        "create",
        { manifest: { filename: "r.txt", mimeType: "text/plain" }, body: "r", encoding: "text" },
        { runId: "run_1" },
      ),
    );
    expect((await store.findEntry(inChat.id))?.conversationId).toBe("conv_1");
    expect((await store.findEntry(inRun.id))?.runId).toBe("run_1");
    expect((await list({ conversationId: "conv_1" })).files.map((f) => f.id)).toEqual([inChat.id]);
    expect((await list({ runId: "run_1" })).files.map((f) => f.id)).toEqual([inRun.id]);
  });
});

describe("list", () => {
  beforeEach(async () => {
    await seed({ id: "fl_img", filename: "logo.png", mimeType: "image/png", source: "chat" });
    await seed({
      id: "fl_pdf",
      filename: "report.pdf",
      mimeType: "application/pdf",
      createdAt: "2026-03-01T00:00:00.000Z",
    });
    await seed({
      id: "fl_csv",
      filename: "leads.csv",
      mimeType: "text/csv",
      description: "quarterly report data",
      createdAt: "2026-02-01T00:00:00.000Z",
      source: "app",
    });
  });

  test("classifies kinds from the MIME type", () => {
    expect(fileKind("image/png")).toBe("image");
    expect(fileKind("application/pdf")).toBe("document");
    expect(fileKind("text/csv")).toBe("data");
    expect(fileKind("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe(
      "data",
    );
    expect(fileKind("font/woff2")).toBe("font");
    expect(fileKind("application/zip")).toBe("other");
  });

  test("a query and a kind filter apply together, before the page is cut", async () => {
    const out = await list({ query: "report", kinds: ["data"], limit: 1 });
    expect(out.files.map((f) => f.id)).toEqual(["fl_csv"]);
    expect(out.total).toBe(1);
  });

  test("each facet counts with every filter but its own", async () => {
    const out = await list({ kinds: ["document"], sources: ["agent"] });
    expect(out.total).toBe(1);
    // Kinds ignore the kind filter but keep the source filter: only agent files.
    expect(out.facets.kinds).toEqual({ image: 0, document: 1, data: 0, font: 0, other: 0 });
    // Sources ignore the source filter but keep the kind filter: only documents.
    expect(out.facets.sources).toEqual({ chat: 0, agent: 1, app: 0, manual: 0 });
  });

  test("sorts, with the default direction per field, and pages", async () => {
    expect((await list()).files.map((f) => f.id)).toEqual(["fl_pdf", "fl_csv", "fl_img"]);
    expect((await list({ sort: "filename" })).files.map((f) => f.filename)).toEqual([
      "leads.csv",
      "logo.png",
      "report.pdf",
    ]);
    const page2 = await list({ sort: "filename", limit: 2, offset: 2 });
    expect(page2.files.map((f) => f.filename)).toEqual(["report.pdf"]);
    expect(page2.total).toBe(3);
  });

  test("filters by creation time", async () => {
    const out = await list({ createdAfter: "2026-02-01", createdBefore: "2026-03-01" });
    expect(out.files.map((f) => f.id)).toEqual(["fl_csv"]);
  });

  test("a query also finds folders by name, and a file filter leaves folders out", async () => {
    await folder("Reports");
    expect((await list({ query: "report" })).folders.map((f) => f.name)).toEqual(["Reports"]);
    expect((await list({ query: "report", kinds: ["data"] })).folders).toEqual([]);
  });

  test("recursive takes in a folder's subfolders", async () => {
    const a = await folder("A");
    const b = await folder("B", a.id);
    await exec("move", { ids: ["fl_img"], folderId: a.id });
    await exec("move", { ids: ["fl_pdf"], folderId: b.id });
    expect((await list({ folderId: a.id })).total).toBe(1);
    const all = await list({ folderId: a.id, recursive: true });
    expect(all.files.map((f) => f.folderPath).sort()).toEqual(["A", "A/B"]);
  });
});
