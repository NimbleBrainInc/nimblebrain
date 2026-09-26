/**
 * A2: workspace files are addressable as MCP resources at `files://<id>`.
 * This test verifies that uploading a file via chat-multipart makes it
 * appear in `resources/list` and fetchable via `resources/read` over the
 * platform's REST surface.
 *
 * Coverage:
 * - text MIME → returned as `text` (utf-8 decoded)
 * - binary MIME → returned as `blob` (base64-encoded)
 * - `/mcp` JSON-RPC `resources/read` (the iframe-bridge path) resolves
 *   identity-owned `files://` URIs even though `files` lives outside every
 *   workspace registry
 * - non-existent URI → 404 / not-found
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { RESOURCE_SOURCE_META_KEY } from "../../src/api/mcp-server.ts";
import { type ServerHandle, startServer } from "../../src/api/server.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { ensureUserWorkspace } from "../../src/workspace/provisioning.ts";
import { personalWorkspaceIdFor } from "../../src/workspace/workspace-store.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";

// Files are workspace-owned. Chat-multipart uploads land in the workspace in
// the request path, and the downstream `files__*` tools / `resources/read`
// read from the workspace in theirs — here, the dev identity's personal
// workspace for both.
const PERSONAL_WS_ID = personalWorkspaceIdFor(DEV_IDENTITY.id);

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
    logging: { disabled: true },
    workDir: testDir,
  });
  await provisionTestWorkspace(runtime);
  await ensureUserWorkspace(runtime.getWorkspaceStore(), {
    id: DEV_IDENTITY.id,
    displayName: DEV_IDENTITY.displayName,
  });
  await runtime.ensureWorkspaceRegistry(PERSONAL_WS_ID);
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

  const res = await fetch(`${baseUrl}/v1/workspaces/${PERSONAL_WS_ID}/chat/stream`, {
    method: "POST",
    body: form,
  });
  if (res.status !== 200) {
    throw new Error(`chat/stream returned ${res.status}: ${await res.text()}`);
  }
  await res.text();

  // Look the id up via files__list (the canonical workspace listing).
  const listRes = await fetch(`${baseUrl}/v1/workspaces/${PERSONAL_WS_ID}/tools/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
  const res = await fetch(`${baseUrl}/v1/workspaces/${PERSONAL_WS_ID}/resources/read`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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

  it("resolves identity files over the /mcp JSON-RPC surface (iframe-bridge path)", async () => {
    // Regression: the iframe bridge reads `files://<id>` through `/mcp`
    // `resources/read` (bare URI, no `server` param) — NOT the REST endpoint
    // the other cases above exercise. `files` is a kernel identity source that
    // lives outside every workspace registry, so the `/mcp` handler resolves it
    // through the identity door. Files are workspace-owned, so the read resolves in
    // the workspace the session's URL names (here the dev user's personal
    // workspace, where the upload landed).
    // This drives the real MCP SDK client end-to-end to lock in the fix.
    const id = await uploadChatFile(PNG_BYTES, "bridge.png", "image/png");

    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/${PERSONAL_WS_ID}`));
    const client = new Client({ name: "files-mcp-bridge-test", version: "1.0.0" });
    await client.connect(transport);
    try {
      const result = await client.readResource({ uri: `files://${id}` });
      expect(result.contents).toHaveLength(1);
      const first = result.contents[0]!;
      expect(first.uri).toBe(`files://${id}`);
      expect(first.mimeType).toBe("image/png");
      expect(typeof first.blob).toBe("string");
      expect(Buffer.from(first.blob as string, "base64").equals(PNG_BYTES)).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("a read scoped to `files` resolves its file; one scoped to another source does not", async () => {
    // The iframe bridge names the calling app's server under
    // `RESOURCE_SOURCE_META_KEY`. The files app is the `files` source, so its
    // own read resolves; any other app's read of the same URI is not found,
    // exactly as a URI that does not exist.
    const id = await uploadChatFile("scoped\n", "scoped.txt", "text/plain");
    const uri = `files://${id}`;

    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/${PERSONAL_WS_ID}`));
    const client = new Client({ name: "files-mcp-scoped-test", version: "1.0.0" });
    await client.connect(transport);
    try {
      const own = await client.readResource({
        uri,
        _meta: { [RESOURCE_SOURCE_META_KEY]: "files" },
      });
      expect(own.contents[0]?.text).toBe("scoped\n");

      for (const source of ["conversations", "db-query"]) {
        await expect(
          client.readResource({ uri, _meta: { [RESOURCE_SOURCE_META_KEY]: source } }),
        ).rejects.toMatchObject({ code: -32002 });
      }
    } finally {
      await client.close();
    }
  });

  it("missing files:// URI surfaces as not-found", async () => {
    const { status, body } = await readResource("files://fl_does_not_exist__________");
    // The bridge surfaces in-process MCP errors as 4xx with an error body.
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
    expect(body).toBeDefined();
  });

  it("does not resolve a file from another workspace's path, even for its owner", async () => {
    const id = await uploadChatFile("cross-workspace\n", "x.txt", "text/plain");
    // The caller is a member of TEST_WORKSPACE_ID too, and `files` routes
    // through the identity door — but the file store is the workspace in the
    // path, so a file uploaded in the personal workspace is not found there.
    const res = await fetch(`${baseUrl}/v1/workspaces/${TEST_WORKSPACE_ID}/resources/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server: "files", uri: `files://${id}` }),
    });
    expect(res.status).not.toBe(200);
    expect(await res.text()).not.toContain("cross-workspace");
  });
});
