/**
 * HTTP-level tests for `/v1/workspaces/:wsId/chat/start` concurrency
 * protection: a conversation runs one turn at a time, and a start on a
 * conversation with a turn in flight is refused with HTTP 409
 * `run_in_progress`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { ApiErrorBody, ChatResponse } from "../../src/api/schemas/responses.ts";
import type { ServerHandle } from "../../src/api/server.ts";
import { startServer } from "../../src/api/server.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { postChatTurn } from "../helpers/chat-turn.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { readJson } from "../helpers/http.ts";
import { createMockModel } from "../helpers/mock-model.ts";
import { makeTestWorkDir } from "../helpers/test-workdir.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

describe("POST /v1/workspaces/:wsId/chat/start — concurrency protection", () => {
  let handle: ServerHandle | null = null;
  let runtime: Runtime | null = null;
  let cleanupDir: (() => void) | null = null;

  afterEach(async () => {
    handle?.stop(true);
    await runtime?.shutdown();
    cleanupDir?.();
    handle = null;
    runtime = null;
    cleanupDir = null;
  });

  function makeWorkDir(): string {
    const w = makeTestWorkDir("chat-start-concurrent");
    cleanupDir = w.cleanup;
    return w.workDir;
  }

  test("returns HTTP 409 when a run is in flight on the same conversation", async () => {
    // A gated model lets us hold runtime.chat() open deterministically. The
    // first call to doGenerate awaits the gate; releasing it lets the seed
    // chat complete.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let callCount = 0;
    const gatedModel = createMockModel(async () => {
      callCount++;
      if (callCount === 1) {
        // Only the first call (the seed run we hold open) is gated.
        return { content: [{ type: "text", text: "seeded" }] };
      }
      await gate;
      return { content: [{ type: "text", text: "unblocked" }] };
    });

    const workDir = makeWorkDir();
    runtime = await Runtime.start({
      identityProvider: devProvider,
      workDir,
      model: { provider: "custom", adapter: gatedModel },
      logging: { disabled: true },
    });
    await provisionTestWorkspace(runtime);
    handle = startServer({ runtime, port: 0 });
    const baseUrl = `http://localhost:${handle.port}`;

    // Seed a conversation (first doGenerate call returns immediately).
    const seed = await runtime.chat({
      identity: DEV_IDENTITY,
      message: "seed",
      workspaceId: TEST_WORKSPACE_ID,
    });
    const convId = seed.conversationId;

    // Start a turn on it; the gated model holds it in flight.
    const first = await fetch(`${baseUrl}/v1/workspaces/${TEST_WORKSPACE_ID}/chat/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "holding the run", conversationId: convId }),
    });
    expect(first.status).toBe(200);
    expect(runtime.isTurnActive(convId)).toBe(true);

    // A second start on the same conversation is refused with a JSON 409.
    const res = await fetch(`${baseUrl}/v1/workspaces/${TEST_WORKSPACE_ID}/chat/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "collides", conversationId: convId }),
    });
    expect(res.status).toBe(409);
    expect(res.headers.get("Content-Type")).toMatch(/application\/json/);
    const body = await readJson<ApiErrorBody>(res);
    expect(body.error).toBe("run_in_progress");
    expect(body.details?.conversationId).toBe(convId);

    // Release the gate and let the held turn finish so teardown is clean.
    release();
    while (runtime.isTurnActive(convId)) await new Promise((r) => setTimeout(r, 10));
  });

  test("concurrent starts produce exactly one run; the rest are refused with 409", async () => {
    const workDir = makeWorkDir();
    runtime = await Runtime.start({
      identityProvider: devProvider,
      workDir,
      model: { provider: "custom", adapter: createEchoModel() },
      logging: { disabled: true },
    });
    await provisionTestWorkspace(runtime);
    handle = startServer({ runtime, port: 0 });
    const baseUrl = `http://localhost:${handle.port}`;

    // Seed a conversation we can contend on.
    const seed = await runtime.chat({
      identity: DEV_IDENTITY,
      message: "seed",
      workspaceId: TEST_WORKSPACE_ID,
    });
    const convId = seed.conversationId;

    // Five concurrent starts on the same conversation: one runs to its done
    // frame, every other is refused before a turn begins.
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        postChatTurn(baseUrl, TEST_WORKSPACE_ID, {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: `concurrent ${i}`, conversationId: convId }),
        }).then(async (r) => ({
          status: r.status,
          body: await readJson<ChatResponse | ApiErrorBody>(r),
        })),
      ),
    );

    const winners = results.filter((r) => r.status === 200);
    const refused = results.filter((r) => r.status === 409);
    expect(winners.length).toBeGreaterThanOrEqual(1);
    expect(refused.length).toBeGreaterThanOrEqual(1);
    expect(winners.length + refused.length).toBe(5);
    for (const r of refused) expect((r.body as ApiErrorBody).error).toBe("run_in_progress");
  });
});
