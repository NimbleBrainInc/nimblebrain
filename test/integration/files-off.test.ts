/**
 * `plugins: { files: false }` turns files off (`contracts/files/CONTRACT.md`
 * §10.1): no files server starts, no `files__*` tool or Files screen appears,
 * an attachment and an upload are refused, every file route answers that files
 * are disabled, `resources/read` of `files://` finds nothing, the bootstrap
 * carries no attachment limits, and host-resources serves no scheme. Chat and
 * tasks keep working.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { handleBootstrap } from "../../src/api/handlers.ts";
import type { ApiErrorBody, BootstrapResponse } from "../../src/api/schemas/responses.ts";
import { type ServerHandle, startServer } from "../../src/api/server.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { readJson } from "../helpers/http.ts";
import { newMcpClient } from "../helpers/mcp-client.ts";
import { answer, callTasks, waitForRun } from "../helpers/tasks-plugin.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

const WS = TEST_WORKSPACE_ID;
const testDir = join(tmpdir(), `nimblebrain-files-off-${Date.now()}`);

let runtime: Runtime;
let handle: ServerHandle;
let base: string;

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  runtime = await Runtime.start({
    identityProvider: devProvider,
    languageModel: createEchoModel(),
    logging: { disabled: true },
    workDir: testDir,
    plugins: { files: false },
  });
  await provisionTestWorkspace(runtime);
  handle = startServer({ runtime, port: 0 });
  base = `http://localhost:${handle.port}`;
}, 60_000);

afterAll(async () => {
  handle?.stop(true);
  await runtime?.shutdown();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
}, 30_000);

async function disabled(res: Response): Promise<void> {
  expect(res.status).toBe(404);
  expect((await readJson<ApiErrorBody>(res)).error).toBe("files_disabled");
}

describe("files off", () => {
  it("starts no files server and offers no files tool or screen", async () => {
    expect(runtime.isFilesEnabled()).toBe(false);
    expect(runtime.getFiles()).toBeNull();
    expect(runtime.getIdentitySource("files")).toBeUndefined();
    expect(existsSync(join(testDir, "plugin-data", "files"))).toBe(false);
    const names = (await runtime.listToolsForWorkspace(WS, DEV_IDENTITY.id)).map((t) => t.name);
    expect(names.some((n) => n.startsWith("files__"))).toBe(false);
    expect(names).toContain("tasks__create");
    const placements = runtime.getPlacementRegistry().forWorkspace(WS);
    expect(placements.some((p) => p.serverName === "files")).toBe(false);
  });

  it("refuses an attachment, and every file route answers files_disabled", async () => {
    const chat = new FormData();
    chat.append("message", "with a file");
    chat.append("files", new File(["x"], "a.txt", { type: "text/plain" }));
    await disabled(
      await fetch(`${base}/v1/workspaces/${WS}/chat/start`, { method: "POST", body: chat }),
    );

    const upload = new FormData();
    upload.append("files", new File(["x"], "a.txt", { type: "text/plain" }));
    await disabled(
      await fetch(`${base}/v1/workspaces/${WS}/resources`, { method: "POST", body: upload }),
    );
    await disabled(await fetch(`${base}/v1/workspaces/${WS}/files/fl_anything`));
    await disabled(
      await fetch(`${base}/v1/workspaces/${WS}/resources/read`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ server: "files", uri: "files://fl_anything" }),
      }),
    );
  });

  it("finds no files:// resource at the MCP door", async () => {
    const client = newMcpClient({ name: "files-off", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${WS}`)));
    try {
      await expect(client.readResource({ uri: "files://fl_anything" })).rejects.toThrow(
        /not found/i,
      );
    } finally {
      await client.close();
    }
  });

  it("carries no attachment limits in the bootstrap, and host-resources serves no scheme", async () => {
    const body = await readJson<BootstrapResponse>(
      await handleBootstrap(runtime, { ...DEV_IDENTITY, preferences: {} }),
    );
    expect(body.config.files).toBeUndefined();
    expect(runtime.getConnectorMcpDeps(WS).hostResources.schemes()).toEqual([]);
  });

  it("keeps chat, with and without a multipart body", async () => {
    const reply = await runtime.chat({ identity: DEV_IDENTITY, workspaceId: WS, message: "hi" });
    expect(reply.response).toContain("hi");
    const text = new FormData();
    text.append("message", "no files here");
    const res = await fetch(`${base}/v1/workspaces/${WS}/chat/start`, {
      method: "POST",
      body: text,
    });
    expect(res.status).toBe(200);
  }, 30_000);

  it("keeps tasks", async () => {
    answer(
      await callTasks(runtime, DEV_IDENTITY, WS, "create", {
        manifest: { name: "Report" },
        body: "write the report",
      }),
    );
    const asked = answer<{ runId: string }>(
      await callTasks(runtime, DEV_IDENTITY, WS, "run", { taskId: "report" }),
    );
    const ended = await waitForRun(runtime, DEV_IDENTITY, WS, asked.runId);
    expect(ended.run.execution).toBe("completed");
  }, 30_000);
});
