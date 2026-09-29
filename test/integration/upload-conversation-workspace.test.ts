/**
 * Upload attached to a conversation → the workspace in the path, and only it.
 *
 * A conversation is WORKSPACE-owned, and its attached files live in the SAME
 * workspace's partition (`workspaces/<wsId>/files/<ownerId>/`), the one the chat
 * read path rehydrates from. An upload addressed to `/v1/workspaces/<wsId>/`
 * writes to `<wsId>`, so it may attach only to a conversation stored there. A
 * conversation in another workspace is refused exactly like an unknown one
 * (`404 conversation_not_found`) before any bytes are stored — never written to
 * the conversation's workspace instead of the path's (ADR-0037).
 *
 * Drives the REAL handlers over HTTP: `POST /v1/workspaces/:wsId/resources`
 * (`handleResourceUpload`) and the multipart form of
 * `POST /v1/workspaces/:wsId/chat/start` (`parseMultipartChatBody`).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiErrorBody, UploadResourceResponse } from "../../src/api/schemas/responses.ts";
import { type ServerHandle, startServer } from "../../src/api/server.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { readJson } from "../helpers/http.ts";
import { provisionTestWorkspace } from "../helpers/test-workspace.ts";

/** What `POST …/resources` answers: the stored entries, plus per-file errors. */

const testDir = join(tmpdir(), `nb-upload-conversation-workspace-${Date.now()}`);

// The conversation's workspace — the chat is born here (focused on WORKSPACE_A).
const WORKSPACE_A = "ws_workspace_a";
// Dev mode: no identity on the request → the dev owner.
const OWNER = DEV_IDENTITY.id;
// Another workspace the owner belongs to — a DIFFERENT workspace than WORKSPACE_A.
const OTHER = "ws_workspace_other";

let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  runtime = await Runtime.start({
    identityProvider: devProvider,
    model: { provider: "custom", adapter: createEchoModel() },
    logging: { disabled: true },
    workDir: testDir,
  });
  await provisionTestWorkspace(runtime, WORKSPACE_A);
  await provisionTestWorkspace(runtime, OTHER);
  handle = startServer({ runtime, port: 0 });
  baseUrl = `http://localhost:${handle.port}`;
});

afterAll(async () => {
  handle.stop(true);
  await runtime.shutdown();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

function attachmentForm(conversationId: string, extra: Record<string, string> = {}): FormData {
  const form = new FormData();
  form.append("file", new Blob(["attachment bytes"], { type: "text/plain" }), "attach.txt");
  form.append("conversationId", conversationId);
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  return form;
}

async function registrySizes(): Promise<{ a: number; other: number }> {
  return {
    a: (await runtime.getWorkspaceFileStore(WORKSPACE_A, OWNER).readRegistry()).length,
    other: (await runtime.getWorkspaceFileStore(OTHER, OWNER).readRegistry()).length,
  };
}

/** The answer with the id factored out, so two refusals can be compared whole. */
function shape(body: { details?: { conversationId?: string } }, id: string) {
  expect(body.details?.conversationId).toBe(id);
  return { ...body, details: { ...body.details, conversationId: "<id>" } };
}

describe("an upload attached to a conversation writes only to the workspace in the path", () => {
  const UPLOAD_ROUTES = [
    { name: "resources", path: "/resources", extra: {} },
    { name: "chat/start (multipart)", path: "/chat/start", extra: { message: "with a file" } },
  ] as const;

  for (const route of UPLOAD_ROUTES) {
    it(`${route.name}: a conversation in another workspace is refused like an unknown one, and nothing is stored`, async () => {
      const born = await runtime.chat({
        identity: DEV_IDENTITY,
        message: "hello from A",
        workspaceId: WORKSPACE_A,
      });
      const unknownId = "conv_0000000000000003";
      const before = await registrySizes();

      const inA = await fetch(`${baseUrl}/v1/workspaces/${OTHER}${route.path}`, {
        method: "POST",
        body: attachmentForm(born.conversationId, route.extra),
      });
      const unknown = await fetch(`${baseUrl}/v1/workspaces/${OTHER}${route.path}`, {
        method: "POST",
        body: attachmentForm(unknownId, route.extra),
      });

      expect(inA.status).toBe(404);
      expect(unknown.status).toBe(404);
      const inABody = await readJson<ApiErrorBody>(inA);
      expect(inABody.error).toBe("conversation_not_found");
      expect(shape(inABody, born.conversationId)).toEqual(shape(await unknown.json(), unknownId));
      // Neither the path's partition nor the conversation's gained a file.
      expect(await registrySizes()).toEqual(before);
    });
  }

  it("resources: a conversation in the path's workspace takes the file there", async () => {
    const born = await runtime.chat({
      identity: DEV_IDENTITY,
      message: "hello from A",
      workspaceId: WORKSPACE_A,
    });
    const res = await fetch(`${baseUrl}/v1/workspaces/${WORKSPACE_A}/resources`, {
      method: "POST",
      body: attachmentForm(born.conversationId),
    });
    expect(res.status).toBe(200);
    const body = await readJson<UploadResourceResponse>(res);
    expect(body.files).toHaveLength(1);
    const fileId: string = body.files[0].id;
    expect(body.files[0].workspaceId).toBe(WORKSPACE_A);
    expect(body.files[0].conversationId).toBe(born.conversationId);
    expect(
      await runtime.getWorkspaceFileStore(WORKSPACE_A, OWNER).findEntry(fileId),
    ).not.toBeNull();
    expect(await runtime.getWorkspaceFileStore(OTHER, OWNER).findEntry(fileId)).toBeNull();
  });
});
