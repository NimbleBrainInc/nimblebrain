/**
 * A chat runs on a local model server through `providers.local`, end to end:
 * the runtime boots with no hosted key, posts Chat Completions to the server,
 * runs the tool the model calls, and prices the turn at zero.
 *
 * The server is a fake that speaks the streaming Chat Completions wire: a tool
 * call on the first request, text on the second, each with a usage chunk.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { getAvailableModels } from "../../src/model/catalog.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

const testDir = join(tmpdir(), `nimblebrain-local-model-${Date.now()}`);
const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
let server: ReturnType<typeof Bun.serve>;
let runtime: Runtime;

function sse(chunks: unknown[]): Response {
  const body = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

const usage = { prompt_tokens: 1200, completion_tokens: 20, total_tokens: 1220 };

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as Record<string, unknown>;
      requests.push({ path: new URL(req.url).pathname, body });
      const messages = body.messages as Array<{ role: string }>;
      const afterTool = messages[messages.length - 1]?.role === "tool";
      const base = { id: "c1", object: "chat.completion.chunk", created: 0, model: body.model };
      if (!afterTool) {
        return sse([
          {
            ...base,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_1",
                      type: "function",
                      function: { name: "files__list", arguments: "{}" },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          },
          { ...base, choices: [], usage },
        ]);
      }
      return sse([
        {
          ...base,
          choices: [{ index: 0, delta: { content: "No files yet." }, finish_reason: "stop" }],
        },
        { ...base, choices: [], usage },
      ]);
    },
  });

  mkdirSync(testDir, { recursive: true });
  runtime = await Runtime.start({
    identityProvider: devProvider,
    logging: { disabled: true },
    workDir: testDir,
    telemetry: { enabled: false },
    providers: {
      local: {
        baseURL: `http://localhost:${server.port}/v1`,
        models: ["gemma4:e4b"],
        contextWindow: 32_768,
      },
    },
    models: { default: "local:gemma4:e4b", fast: "local:gemma4:e4b" },
  });
  await provisionTestWorkspace(runtime);
});

afterAll(async () => {
  await runtime.shutdown();
  server.stop(true);
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

describe("a chat on a local model server", () => {
  it("runs the tool the model calls and answers, priced at zero", async () => {
    const result = await runtime.chat({
      identity: DEV_IDENTITY,
      workspaceId: TEST_WORKSPACE_ID,
      message: "What files do I have?",
    });

    expect(result.response).toBe("No files yet.");
    expect(result.toolCalls.map((t) => t.name)).toEqual(["files__list"]);
    expect(result.usage.model).toBe("local:gemma4:e4b");
    expect(result.usage.inputTokens).toBe(2400);
    expect(result.costUsd).toBe(0);
  });

  it("speaks Chat Completions to the server, with the server's model id and usage asked for", () => {
    // The turn's calls stream; the first turn's title, beside it, does not.
    const chat = requests.filter((r) => r.path === "/v1/chat/completions" && r.body.stream);
    expect(chat.length).toBeGreaterThanOrEqual(2);
    expect(chat[0]?.body.model).toBe("gemma4:e4b");
    expect(chat[0]?.body.stream_options).toEqual({ include_usage: true });
  });

  it("offers the local model in the picker", () => {
    const available = getAvailableModels(runtime.getProviderConfigs(), runtime.getModelPolicy());
    expect(available.local?.map((m) => m.id)).toEqual(["gemma4:e4b"]);
  });
});
