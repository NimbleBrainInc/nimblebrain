import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatResponse } from "../../src/api/schemas/responses.ts";
import type { ServerHandle } from "../../src/api/server.ts";
import { startServer } from "../../src/api/server.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { postChatTurn } from "../helpers/chat-turn.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { readJson } from "../helpers/http.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;
const testDir = join(tmpdir(), `nimblebrain-appctx-${Date.now()}`);

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  runtime = await Runtime.start({
    identityProvider: devProvider,
    languageModel: createEchoModel(),
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

describe("POST /v1/workspaces/:wsId/chat/start with appContext", () => {
  it("succeeds when appContext is provided", async () => {
    const res = await postChatTurn(baseUrl, TEST_WORKSPACE_ID, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Hello from app",
        appContext: { appName: "my-app", serverName: "my-server" },
        workspaceId: TEST_WORKSPACE_ID,
      }),
    });

    expect(res.status).toBe(200);
    const body = await readJson<ChatResponse>(res);
    expect(body.response).toBe("Hello from app");
    expect(body.conversationId).toMatch(/^conv_/);
  });

  it("succeeds without appContext", async () => {
    const res = await postChatTurn(baseUrl, TEST_WORKSPACE_ID, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "No context", workspaceId: TEST_WORKSPACE_ID }),
    });

    expect(res.status).toBe(200);
    const body = await readJson<ChatResponse>(res);
    expect(body.response).toBe("No context");
    expect(body.conversationId).toMatch(/^conv_/);
  });
});
