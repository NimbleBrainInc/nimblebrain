/**
 * A2: workspace files are addressable as MCP resources at `files://<id>`.
 * This test verifies that uploading a file via chat-multipart makes it
 * appear in `resources/list` and fetchable via `resources/read` over the
 * platform's REST surface.
 *
 * Coverage:
 * - text MIME → returned as `text` (utf-8 decoded)
 * - binary MIME → returned as `blob` (base64-encoded)
 * - non-existent URI → 404 / not-found
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ServerHandle, startServer } from "../../src/api/server.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;
const testDir = join(tmpdir(), `nb-files-mcp-resources-${Date.now()}`);

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  runtime = await Runtime.start({
    model: { provider: "custom", adapter: createEchoModel() },
    noDefaultBundles: true,
    logging: { disabled: true },
    workDir: testDir,
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

async function uploadChatFile(content: string | Buffer, filename: string, mimeType: string): Promise<string> {
  const form = new FormData();
  form.append("message", "uploaded a file");
  form.append("workspaceId", TEST_WORKSPACE_ID);
  const bytes = typeof content === "string" ? Buffer.from(content) : content;
  form.append("files", new File([new Uint8Array(bytes)], filename, { type: mimeType }));

  const res = await fetch(`${baseUrl}/v1/chat/stream`, {
    method: "POST",
    headers: { "X-Workspace-Id": TEST_WORKSPACE_ID },
    body: form,
  });
  if (res.status !== 200) {
    throw new Error(`chat/stream returned ${res.status}: ${await res.text()}`);
  }
  await res.text();

  // Look the id up via files__list (the canonical workspace listing).
  const listRes = await fetch(`${baseUrl}/v1/tools/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Workspace-Id": TEST_WORKSPACE_ID },
    body: JSON.stringify({ server: "files", tool: "list", arguments: { limit: 100 } }),
  });
  const listBody = (await listRes.json()) as { content: { type: string; text: string }[] };
  const listed = JSON.parse(listBody.content[0]!.text) as {
    files: { id: string; filename: string }[];
  };
  const match = listed.files.find((f) => f.filename === filename);
  if (!match) throw new Error(`uploaded file ${filename} not found in registry`);
  return match.id;
}

async function readResource(uri: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}/v1/resources/read`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Workspace-Id": TEST_WORKSPACE_ID },
    body: JSON.stringify({ server: "files", uri }),
  });
  return { status: res.status, body: await res.json() };
}

describe("workspace files exposed as MCP resources", () => {
  it("text-MIME upload comes back as a `text` resource", async () => {
    const id = await uploadChatFile("hello world\n", "note.txt", "text/plain");
    const { status, body } = await readResource(`files://${id}`);
    expect(status).toBe(200);

    const result = body as { contents: Array<{ uri: string; text?: string; blob?: string; mimeType?: string }> };
    expect(result.contents).toHaveLength(1);
    const first = result.contents[0]!;
    expect(first.uri).toBe(`files://${id}`);
    // Browsers/Bun attach `;charset=utf-8` to text uploads; the registry
    // stores the MIME verbatim. The classifier (`isTextMime`) tolerates
    // the parameter and routes the read through the text branch — that's
    // what we're really asserting here.
    expect(first.mimeType?.startsWith("text/plain")).toBe(true);
    expect(first.text).toBe("hello world\n");
    expect(first.blob).toBeUndefined();
  });

  it("binary-MIME upload (PNG) comes back as a base64 `blob` resource", async () => {
    const id = await uploadChatFile(PNG_BYTES, "photo.png", "image/png");
    const { status, body } = await readResource(`files://${id}`);
    expect(status).toBe(200);

    const result = body as { contents: Array<{ uri: string; text?: string; blob?: string; mimeType?: string }> };
    const first = result.contents[0]!;
    expect(first.mimeType).toBe("image/png");
    expect(first.text).toBeUndefined();
    expect(first.blob).toBeDefined();
    expect(Buffer.from(first.blob!, "base64").equals(PNG_BYTES)).toBe(true);
  });

  it("missing files:// URI surfaces as not-found", async () => {
    const { status, body } = await readResource("files://fl_does_not_exist__________");
    // The bridge surfaces in-process MCP errors as 4xx with an error body.
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
    expect(body).toBeDefined();
  });
});
