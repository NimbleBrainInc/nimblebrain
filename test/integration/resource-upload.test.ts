import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ServerHandle, startServer } from "../../src/api/server.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";

let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;
const testDir = join(tmpdir(), `nimblebrain-resource-upload-test-${Date.now()}`);
const PER_FILE_LIMIT = 256 * 1024;
const TOTAL_LIMIT = 1 * 1024 * 1024;

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  runtime = await Runtime.start({
    model: { provider: "custom", adapter: createEchoModel() },
    noDefaultBundles: true,
    logging: { disabled: true },
    workDir: testDir,
    files: {
      maxFileSize: PER_FILE_LIMIT,
      maxTotalSize: TOTAL_LIMIT,
      maxFilesPerMessage: 5,
    },
  });
  await provisionTestWorkspace(runtime);
  handle = startServer({ runtime, port: 0 });
  baseUrl = `http://localhost:${handle.port}`;
});

afterAll(async () => {
  handle.stop(true);
  await runtime.shutdown();
  rmSync(testDir, { recursive: true, force: true });
});

describe("POST /v1/resources", () => {
  it("stores an uploaded file and returns its FileEntry", async () => {
    const form = new FormData();
    form.append("file", new Blob(["hello world"], { type: "text/plain" }), "hello.txt");

    const res = await fetch(`${baseUrl}/v1/resources`, {
      method: "POST",
      headers: { "X-Workspace-Id": TEST_WORKSPACE_ID },
      body: form,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.files).toHaveLength(1);
    const entry = body.files[0];
    expect(entry.id).toMatch(/^fl_[0-9a-f]{24}$/);
    expect(entry.filename).toBe("hello.txt");
    // Browsers may append parameters like `;charset=utf-8`; we keep the
    // raw Content-Type as-given so we don't lie about the upload.
    expect(entry.mimeType.split(";")[0]).toBe("text/plain");
    expect(entry.size).toBe(11);

    // Bytes physically land under the authenticated workspace's directory.
    // This is the "isolation by composition" guarantee — the upload route
    // never lets the caller pick a different workspace's path.
    const wsFilesDir = join(testDir, "workspaces", TEST_WORKSPACE_ID, "files");
    const onDisk = readdirSync(wsFilesDir);
    expect(onDisk.some((name) => name.startsWith(`${entry.id}_`))).toBe(true);
  });

  it("accepts multiple files in a single request", async () => {
    const form = new FormData();
    form.append("file", new Blob(["a"], { type: "text/plain" }), "a.txt");
    form.append("file", new Blob(["bb"], { type: "text/plain" }), "b.txt");

    const res = await fetch(`${baseUrl}/v1/resources`, {
      method: "POST",
      headers: { "X-Workspace-Id": TEST_WORKSPACE_ID },
      body: form,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.files).toHaveLength(2);
    expect(body.files.map((f: { filename: string }) => f.filename).sort()).toEqual([
      "a.txt",
      "b.txt",
    ]);
  });

  it("rejects an over-per-file-cap upload with structured details", async () => {
    const big = new Blob([new Uint8Array(PER_FILE_LIMIT + 1)], { type: "text/plain" });
    const form = new FormData();
    form.append("file", big, "too-big.txt");

    const res = await fetch(`${baseUrl}/v1/resources`, {
      method: "POST",
      headers: { "X-Workspace-Id": TEST_WORKSPACE_ID },
      body: form,
    });
    // Per-file enforcement happens after middleware: middleware passes
    // (single file is under the multipart total cap), then the handler
    // catches and replies 400 with file_upload_error.
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("file_upload_error");
    expect(body.details?.errors?.[0]).toContain("exceeds per-file limit");
  });

  it("rejects an upload over the multipart total cap at the middleware (413)", async () => {
    const big = new Blob([new Uint8Array(TOTAL_LIMIT + 1024)], { type: "text/plain" });
    const form = new FormData();
    form.append("file", big, "too-big.txt");

    const res = await fetch(`${baseUrl}/v1/resources`, {
      method: "POST",
      headers: { "X-Workspace-Id": TEST_WORKSPACE_ID },
      body: form,
    });
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toBe("payload_too_large");
    expect(body.details?.contentType).toContain("multipart/form-data");
  });

  it("rejects a disallowed MIME type with 400 file_upload_error", async () => {
    const form = new FormData();
    form.append(
      "file",
      new Blob(["MZ\x90\x00"], { type: "application/x-msdownload" }),
      "evil.exe",
    );

    const res = await fetch(`${baseUrl}/v1/resources`, {
      method: "POST",
      headers: { "X-Workspace-Id": TEST_WORKSPACE_ID },
      body: form,
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("file_upload_error");
    expect(body.details?.errors?.[0]).toContain("disallowed type");
  });

  it("rejects a multipart request with no files", async () => {
    const res = await fetch(`${baseUrl}/v1/resources`, {
      method: "POST",
      headers: { "X-Workspace-Id": TEST_WORKSPACE_ID },
      body: new FormData(),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("bad_request");
  });

  it("rejects upload to a workspace the caller is not a member of (403)", async () => {
    // Provision a second workspace with no member added — DEV_IDENTITY is
    // not in its member list, so resolveWorkspace must reject.
    const wsStore = runtime.getWorkspaceStore();
    const other = await wsStore.create("Other Workspace", "other");

    const form = new FormData();
    form.append("file", new Blob(["nope"], { type: "text/plain" }), "nope.txt");

    const res = await fetch(`${baseUrl}/v1/resources`, {
      method: "POST",
      headers: { "X-Workspace-Id": other.id },
      body: form,
    });
    expect(res.status).toBe(403);

    // And no `fl_*` file landed in the foreign workspace's files dir.
    // The dir itself exists (scaffoldWorkspace creates it with a .gitkeep)
    // — what we're proving is that no upload bytes were written there.
    const otherFilesDir = join(testDir, "workspaces", other.id, "files");
    const onDisk = existsSync(otherFilesDir) ? readdirSync(otherFilesDir) : [];
    expect(onDisk.some((name) => name.startsWith("fl_"))).toBe(false);
  });
});
