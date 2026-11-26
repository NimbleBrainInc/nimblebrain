/**
 * The chat door runs a model's call only on a tool the run can list, and only
 * when that tool is model-visible. A source whose listing fails (a connector
 * that is reconnecting) still executes on demand, so the check is the engine's.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { textContent } from "../../src/engine/content-helpers.ts";
import type { EngineEvent } from "../../src/engine/types.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import type { Tool, ToolSource } from "../../src/tools/types.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

const started: Array<{ runtime: Runtime; dir: string }> = [];

afterEach(async () => {
  for (const { runtime, dir } of started.splice(0)) {
    await runtime.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A source that lists `tool` only while `state.connected`, and executes on demand. */
function flakySource(tool: Tool) {
  const state = { executed: 0, connected: false };
  const source: ToolSource = {
    name: tool.source,
    start: async () => {},
    stop: async () => {},
    tools: async () => {
      if (!state.connected) throw new Error("not connected");
      return [tool];
    },
    execute: async () => {
      state.executed++;
      return { content: textContent("ran"), isError: false };
    },
  };
  return { source, state };
}

/** A runtime whose model calls `toolName` once, with `source` added to the test workspace. */
async function startWith(toolName: string, source: ToolSource): Promise<Runtime> {
  const dir = join(tmpdir(), `nimblebrain-chat-unlisted-tool-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  const runtime = await Runtime.start({
    identityProvider: devProvider,
    languageModel: createEchoModel({
      responses: [{ toolCalls: [{ toolCallId: "c1", toolName, input: "{}" }] }, { text: "done" }],
    }),
    logging: { disabled: true },
    workDir: dir,
    telemetry: { enabled: false },
  });
  started.push({ runtime, dir });
  await provisionTestWorkspace(runtime);
  (await runtime.ensureWorkspaceRegistry(TEST_WORKSPACE_ID)).addSource(source);
  return runtime;
}

describe("chat door: unlisted tools", () => {
  it("refuses an app-only tool whose source cannot list it", async () => {
    const { source, state } = flakySource({
      name: "flaky__app_action",
      description: "app-only",
      inputSchema: { type: "object", properties: {} },
      source: "flaky",
      meta: { ui: { visibility: ["app"] } },
    });
    const runtime = await startWith("flaky__app_action", source);

    const result = await runtime.chat({
      identity: DEV_IDENTITY,
      workspaceId: TEST_WORKSPACE_ID,
      message: "go",
    });

    expect(state.executed).toBe(0);
    const call = result.toolCalls.find((c) => c.name === "flaky__app_action");
    expect(call?.ok).toBe(false);
    expect(call?.output).toContain("not in this run's tool list");
  }, 60_000);

  it("runs a model-visible tool whose source lists again when the run re-reads", async () => {
    const { source, state } = flakySource({
      name: "back__action",
      description: "model-visible",
      inputSchema: { type: "object", properties: {} },
      source: "back",
    });
    const runtime = await startWith("back__action", source);

    // The run-start listing fails; the source reconnects once the model has
    // answered, so the refresh on the call's miss lists it.
    await runtime.chat(
      { identity: DEV_IDENTITY, workspaceId: TEST_WORKSPACE_ID, message: "go" },
      {
        emit: (event: EngineEvent) => {
          if (event.type === "llm.done") state.connected = true;
        },
      },
    );

    expect(state.executed).toBe(1);
  }, 60_000);
});
