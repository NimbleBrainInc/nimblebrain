/**
 * The fixed part of a turn's first model call stays within a ceiling.
 *
 * Every call of a turn carries the system prompt, the tools sent in full, and
 * any loaded skill before a word of conversation. On a 32k-token local model
 * that fixed part decides how much history fits: past about a quarter of the
 * window, a later turn loses the earlier ones. The target is 32,000 characters
 * (about 8k tokens). The ceiling below is a ratchet toward it: lower it when the
 * prompt shrinks, and never raise it to fit a change; make room instead.
 *
 * Measured on a fresh workspace, on the request a scheduling message sends
 * (it loads the task-authoring skill and the task tools, the largest common turn).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

/** Characters of the first request's system prompt, tools, and messages. */
const CEILING_CHARS = 49_000;
const TARGET_CHARS = 32_000;

const testDir = join(tmpdir(), `nimblebrain-prompt-size-${Date.now()}`);
const bodies: Array<Record<string, unknown>> = [];
let server: ReturnType<typeof Bun.serve>;
let runtime: Runtime;

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      bodies.push((await req.json()) as Record<string, unknown>);
      const chunk = {
        id: "c1",
        object: "chat.completion.chunk",
        created: 0,
        model: "m",
        choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
      };
      const usage = { ...chunk, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } };
      return new Response(
        `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(usage)}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
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

describe("a turn's fixed prompt", () => {
  it(`stays under ${CEILING_CHARS} characters (target ${TARGET_CHARS})`, async () => {
    await runtime.chat({
      identity: DEV_IDENTITY,
      workspaceId: TEST_WORKSPACE_ID,
      message: "Set up a scheduled task that runs every weekday at 8am.",
    });
    const first = bodies.find((b) => Array.isArray(b.tools));
    expect(first).toBeDefined();
    const size = JSON.stringify({ messages: first?.messages, tools: first?.tools }).length;
    expect(size).toBeLessThanOrEqual(CEILING_CHARS);
  });
});
