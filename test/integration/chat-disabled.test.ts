/**
 * An instance with chat turned off (`plugins: { conversations: false }`): no
 * plugin implements the conversations contract, so chat is off (ADR-0076, chat
 * is derived from the contract) and the rest of the product works.
 *
 * - Every chat route answers `404 chat_disabled`, and `runtime.chat` refuses.
 * - The bootstrap reports `config.chat: false`, and the shell gets no
 *   Conversations placement.
 * - No `conversations__*` tool is listed at the door; the other identity apps
 *   (files, tasks) answer there.
 * - A task run, which has no conversation, runs.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { ApiErrorBody, BootstrapResponse } from "../../src/api/schemas/responses.ts";
import { type ServerHandle, startServer } from "../../src/api/server.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { ChatDisabledError } from "../../src/runtime/errors.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { readJson } from "../helpers/http.ts";
import { newMcpClient } from "../helpers/mcp-client.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

const testDir = join(tmpdir(), `nimblebrain-chat-disabled-${Date.now()}`);
const CONVERSATION = "conv_0123456789abcdef";

let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  runtime = await Runtime.start({
    identityProvider: devProvider,
    languageModel: createEchoModel(),
    logging: { disabled: true },
    workDir: testDir,
    plugins: { conversations: false },
  });
  await provisionTestWorkspace(runtime);
  handle = startServer({ runtime, port: 0 });
  baseUrl = `http://localhost:${handle.port}`;
});

afterAll(async () => {
  handle?.stop(true);
  await runtime?.shutdown();
  rmSync(testDir, { recursive: true, force: true });
});

async function mcpClient(): Promise<Client> {
  const client = newMcpClient({ name: "chat-disabled-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/${TEST_WORKSPACE_ID}`)),
  );
  return client;
}

async function expectChatDisabled(res: Response): Promise<void> {
  expect(res.status).toBe(404);
  const body = await readJson<ApiErrorBody>(res);
  expect(body.error).toBe("chat_disabled");
}

describe("chat refuses", () => {
  it("the runtime reports chat off and refuses a turn", async () => {
    expect(runtime.isChatEnabled()).toBe(false);
    await expect(
      runtime.chat({ identity: DEV_IDENTITY, workspaceId: TEST_WORKSPACE_ID, message: "hi" }),
    ).rejects.toBeInstanceOf(ChatDisabledError);
  });

  it("POST chat/start answers 404 chat_disabled", async () => {
    const res = await fetch(`${baseUrl}/v1/workspaces/${TEST_WORKSPACE_ID}/chat/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    await expectChatDisabled(res);
  });

  it("the conversation event stream answers 404 chat_disabled", async () => {
    const res = await fetch(
      `${baseUrl}/v1/workspaces/${TEST_WORKSPACE_ID}/conversations/${CONVERSATION}/events`,
    );
    await expectChatDisabled(res);
  });

  it("Stop answers 404 chat_disabled", async () => {
    const res = await fetch(
      `${baseUrl}/v1/workspaces/${TEST_WORKSPACE_ID}/conversations/${CONVERSATION}/cancel`,
      { method: "POST" },
    );
    await expectChatDisabled(res);
  });
});

describe("the shell shows no chat", () => {
  it("the bootstrap reports config.chat false", async () => {
    const res = await fetch(`${baseUrl}/v1/bootstrap`);
    expect(res.status).toBe(200);
    const body = await readJson<BootstrapResponse>(res);
    expect(body.config.chat).toBe(false);
  });

  it("no placement belongs to a conversations server", () => {
    const placements = runtime.getPlacementRegistry().forWorkspace(TEST_WORKSPACE_ID);
    expect(placements.some((p) => p.serverName === "conversations")).toBe(false);
    expect(placements.some((p) => p.serverName === "tasks")).toBe(true);
  });
});

describe("the rest of the product works", () => {
  it("the door lists no conversations tool and answers the other identity apps", async () => {
    const client = await mcpClient();
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names.some((n) => n.startsWith("conversations__"))).toBe(false);
      expect(names).toContain("tasks__list");
      expect(names).toContain("files__list");
      const tasks = await client.callTool({ name: "tasks__list", arguments: {} });
      expect(tasks.isError).toBeFalsy();
      const files = await client.callTool({ name: "files__list", arguments: {} });
      expect(files.isError).toBeFalsy();
    } finally {
      await client.close();
    }
  });

  it("a task run, which has no conversation, runs", async () => {
    const result = await runtime.executeTask({
      prompt: "summarize the day",
      identity: DEV_IDENTITY,
      workspaceId: TEST_WORKSPACE_ID,
    });
    expect(result.stopReason).toBe("complete");
    expect(result.output).toContain("summarize the day");
  });

  it("deleting the workspace needs no conversations plugin", async () => {
    const ws = await runtime.getWorkspaceStore().create("Spare", {
      members: [{ userId: DEV_IDENTITY.id, role: "admin" }],
    });
    const result = await runtime.deleteWorkspace(ws.id);
    expect(result.deleteError).toBeUndefined();
    expect(result.deleted).toBe(true);
  });
});
