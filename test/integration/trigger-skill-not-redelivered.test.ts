/**
 * A skill a trigger composed into the turn is not delivered again on request.
 *
 * A scheduling message matches task-authoring's triggers, so the runtime puts
 * its body in the turn. When the model then calls `nb__use_skill` for it, the
 * answer is "already loaded", with no second copy of the body: the turn's
 * composed skills reach the tool through the run's request context, across the
 * per-call restamp.
 *
 * The model is a fake server on the Chat Completions wire: the first request
 * calls nb__use_skill, the second answers in text.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

const testDir = join(tmpdir(), `nimblebrain-trigger-skill-${Date.now()}`);
let server: ReturnType<typeof Bun.serve>;
let runtime: Runtime;

function sse(chunks: unknown[]): Response {
  const body = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

beforeAll(async () => {
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { model: string; messages: Array<{ role: string }> };
      const base = { id: "c1", object: "chat.completion.chunk", created: 0, model: body.model };
      const afterTool = body.messages[body.messages.length - 1]?.role === "tool";
      const delta = afterTool
        ? { content: "Done." }
        : {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: "nb__use_skill", arguments: '{"name":"task-authoring"}' },
              },
            ],
          };
      return sse([
        {
          ...base,
          choices: [{ index: 0, delta, finish_reason: afterTool ? "stop" : "tool_calls" }],
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
        models: ["m"],
        contextWindow: 32_768,
      },
    },
    models: { default: "local:m", fast: "local:m" },
  });
  await provisionTestWorkspace(runtime);
});

afterAll(async () => {
  await runtime.shutdown();
  server.stop(true);
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

describe("a trigger-matched skill", () => {
  it("answers 'already loaded' when the model asks for it again", async () => {
    const result = await runtime.chat({
      identity: DEV_IDENTITY,
      workspaceId: TEST_WORKSPACE_ID,
      message: "Set up a scheduled task that runs every weekday at 8am.",
    });
    const call = result.toolCalls.find((c) => c.name === "nb__use_skill");
    expect(call?.ok).toBe(true);
    expect(call?.output).toContain("already loaded");
    expect(call?.output).not.toContain("<activated-skill>");
  });
});
