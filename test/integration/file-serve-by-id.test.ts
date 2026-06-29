/**
 * GET /v1/files/:fileId → workspace resolved from the file id alone.
 *
 * A file is WORKSPACE-owned, but its id is globally unique, so the bare id
 * addresses it: the file locator resolves the id to its workspace within the
 * caller's own owner partitions, with NO workspace or conversation in the URL (a
 * browser `<img>` GET can't send `X-Workspace-Id`, and doesn't need to). This is
 * what makes a file attached to a conversation in workspace A resolve even when
 * the client is focused elsewhere — there is no client-supplied coordinate to
 * get wrong.
 *
 * This drives the REAL serve handler over HTTP. If id-based resolution breaks,
 * the bare download 404s — the assertions below fail.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ServerHandle, startServer } from "../../src/api/server.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { provisionTestWorkspace } from "../helpers/test-workspace.ts";

const testDir = join(tmpdir(), `nb-file-serve-by-conversation-${Date.now()}`);

const WORKSPACE_A = "ws_workspace_a";

let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  runtime = await Runtime.start({
    model: { provider: "custom", adapter: createEchoModel() },
    noDefaultBundles: true,
    logging: { disabled: true },
    workDir: testDir,
  });
  await provisionTestWorkspace(runtime, WORKSPACE_A);
  handle = startServer({ runtime, port: 0 });
  baseUrl = `http://localhost:${handle.port}`;
});

afterAll(async () => {
  handle.stop(true);
  await runtime.shutdown();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

describe("GET /v1/files resolves the workspace from the file id", () => {
  it("serves a workspace-A attachment by bare id, no workspace in the URL", async () => {
    // A conversation born in workspace A; a file uploaded to it (the upload
    // resolves the conversation's workspace, A — the file lives under A).
    const born = await runtime.chat({ message: "hi", workspaceId: WORKSPACE_A });
    const convId = born.conversationId;

    const form = new FormData();
    form.append("file", new Blob(["served bytes"], { type: "text/plain" }), "served.txt");
    form.append("conversationId", convId);
    const upload = await fetch(`${baseUrl}/v1/resources`, { method: "POST", body: form });
    expect(upload.status).toBe(200);
    const uploadBody = await upload.json();
    const fileId: string = uploadBody.files[0].id;
    expect(uploadBody.files[0].workspaceId).toBe(WORKSPACE_A);

    // Download by bare id — no ?ws, no conversationId. The locator resolves the
    // id to workspace A within the owner's partitions. The personal workspace
    // (PERSONAL) is the "focused elsewhere" workspace the file does NOT live in;
    // the bare id resolves regardless, which is the whole point.
    const byId = await fetch(`${baseUrl}/v1/files/${fileId}`);
    expect(byId.status).toBe(200);
    expect(await byId.text()).toBe("served bytes");

    // A bogus (well-formed) id resolves to no partition → 404.
    const missing = await fetch(`${baseUrl}/v1/files/fl_${"0".repeat(24)}`);
    expect(missing.status).toBe(404);
  });
});
