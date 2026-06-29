/**
 * GET /v1/files/:fileId?conversationId=<id> → workspace resolved from the
 * conversation, not the `?ws=` query.
 *
 * A file is WORKSPACE-owned and the serve endpoint partitions by `?ws=` because
 * a browser GET can't send `X-Workspace-Id`. But a file attached to a
 * conversation that lives in workspace A is only reachable via `?ws=A` — a
 * client that doesn't know A (it's focused elsewhere, or unfocused) 404s. With
 * `?conversationId=<id>` the handler resolves the conversation's authoritative
 * workspace (the same partition the chat read/write path uses) and serves from
 * there — the user's own download follows the conversation's workspace.
 *
 * This drives the REAL serve handler over HTTP. If the conversationId branch is
 * reverted, the workspace resolves to the wrong (personal/header) partition and
 * the download 404s — the assertions below fail.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ServerHandle, startServer } from "../../src/api/server.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { personalWorkspaceIdFor } from "../../src/workspace/workspace-store.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { provisionTestWorkspace } from "../helpers/test-workspace.ts";

const testDir = join(tmpdir(), `nb-file-serve-by-conversation-${Date.now()}`);

const WORKSPACE_A = "ws_workspace_a";
const OWNER = DEV_IDENTITY.id;
const PERSONAL = personalWorkspaceIdFor(OWNER);

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

describe("GET /v1/files resolves the workspace from conversationId", () => {
  it("serves a workspace-A attachment via conversationId with no (and wrong) ?ws", async () => {
    // A conversation born in workspace A; a file uploaded to it (unfocused
    // request → the upload resolves the conversation's workspace, A).
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

    // Download via conversationId, NO ?ws at all → resolves to workspace A.
    const byConv = await fetch(`${baseUrl}/v1/files/${fileId}?conversationId=${convId}`);
    expect(byConv.status).toBe(200);
    expect(await byConv.text()).toBe("served bytes");

    // Download via conversationId AND a WRONG ?ws (the personal workspace) →
    // conversationId wins, resolves to A, still served.
    const byConvWrongWs = await fetch(
      `${baseUrl}/v1/files/${fileId}?ws=${PERSONAL}&conversationId=${convId}`,
    );
    expect(byConvWrongWs.status).toBe(200);
    expect(await byConvWrongWs.text()).toBe("served bytes");

    // Control: WITHOUT conversationId and pointing at the wrong (personal)
    // workspace → the file isn't there → 404. This is the partition the
    // conversationId branch rescues.
    const wrongWsOnly = await fetch(`${baseUrl}/v1/files/${fileId}?ws=${PERSONAL}`);
    expect(wrongWsOnly.status).toBe(404);
  });
});
