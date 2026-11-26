/**
 * What the model is told about reaching its tools matches the run's tool
 * surface (`RuntimeCapabilities.promotesTools`). A native run with proxied tools
 * is told to find them with `nb__search` and promote them with
 * `nb__manage_tools`; a run on an ACP runtime, which the tool projection serves
 * every tool from the start, is told nothing about promoting, and its search
 * results say to call a match directly.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { textContent } from "../../../src/engine/content-helpers.ts";
import type { ToolResult } from "../../../src/engine/types.ts";
import { createAcpRuntime } from "../../../src/execution/acp/acp-runtime.ts";
import { DEV_IDENTITY } from "../../../src/identity/providers/dev.ts";
import { Runtime } from "../../../src/runtime/runtime.ts";
import type { RuntimeConfig } from "../../../src/runtime/types.ts";
import type { ToolSource } from "../../../src/tools/types.ts";
import { emptyLog, scriptedConnection, scriptedDriver } from "../../helpers/acp/scripted-agent.ts";
import { devProvider } from "../../helpers/dev-provider.ts";
import { createMockModel } from "../../helpers/mock-model.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../../helpers/test-workspace.ts";

const PROMOTION_GUIDANCE = "These apps have tools that are not in your direct tool list";
const SEARCH_CALL = { id: "s1", name: "nb__search", input: { scope: "tools", query: "widget" } };

/** Each native system prompt, and each `nb__search` result text, in order. */
const nativeSystems: string[] = [];
const nativeSearches: string[] = [];

/** Calls `nb__search` once, then answers in text. */
const nativeModel = createMockModel(async ({ prompt }) => {
  const system = prompt.find((m) => m.role === "system");
  // The first turn's title runs beside it on the same model; it is not the turn.
  if (
    typeof system?.content === "string" &&
    system.content.startsWith("Generate a 3-6 word title")
  ) {
    return { content: [{ type: "text", text: "Widget Tools" }] };
  }
  if (system && typeof system.content === "string") nativeSystems.push(system.content);
  const last = prompt[prompt.length - 1];
  if (last?.role === "tool") {
    for (const part of last.content) {
      if (part.type === "tool-result") nativeSearches.push(JSON.stringify(part.output));
    }
    return { content: [{ type: "text", text: "done" }] };
  }
  return {
    content: [
      {
        type: "tool-call",
        toolCallId: SEARCH_CALL.id,
        toolName: SEARCH_CALL.name,
        input: JSON.stringify(SEARCH_CALL.input),
      },
    ],
    finishReason: "tool-calls",
  };
});

const agentLog = emptyLog();

/** An installed app whose tools push the workspace past the direct-tool limit. */
function widgetSource(): ToolSource {
  return {
    name: "widgets",
    async start() {},
    async stop() {},
    async tools() {
      return Array.from({ length: 40 }, (_, i) => ({
        name: `widgets__widget_${i}`,
        description: `Widget tool ${i}`,
        inputSchema: { type: "object", properties: {} },
        source: "mcp:widgets",
      }));
    },
    async execute(): Promise<ToolResult> {
      return { content: textContent("ok"), isError: false };
    },
  };
}

const workDir = join(tmpdir(), `nimblebrain-tool-guidance-${Date.now()}`);
const config: RuntimeConfig = {
  identityProvider: devProvider,
  languageModel: nativeModel,
  logging: { disabled: true },
  telemetry: { enabled: false },
  workDir,
  execution: { default: "native" },
  agentRuntimes: [
    createAcpRuntime(
      "scripted-acp",
      scriptedDriver(),
      scriptedConnection({
        script: () => [
          { toolCalls: [{ toolName: SEARCH_CALL.name, input: SEARCH_CALL.input }] },
          { text: "done" },
        ],
        systemPrompt: {},
        log: agentLog,
      }),
    ),
  ],
};
let runtime: Runtime;

beforeAll(async () => {
  mkdirSync(workDir, { recursive: true });
  runtime = await Runtime.start(config);
  await provisionTestWorkspace(runtime);
  runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID).addSource(widgetSource());
  // The prompt narrates installed connectors; this source stands in for one.
  runtime.buildAppsList = async () => [{ name: "widgets", ui: null }];
});

afterAll(async () => {
  await runtime?.shutdown();
  rmSync(workDir, { recursive: true, force: true });
});

function chat(message: string) {
  return runtime.chat({ message, workspaceId: TEST_WORKSPACE_ID, identity: DEV_IDENTITY });
}

describe("tool guidance follows the run's tool surface", () => {
  test("a native run with proxied tools is told to promote them", async () => {
    config.execution = { default: "native" };
    await chat("find the widget tools");

    expect(nativeSystems.at(0)).toContain(PROMOTION_GUIDANCE);
    expect(nativeSearches.at(0)).toContain("widgets__widget_");
    expect(nativeSearches.at(0)).toContain("activate it with nb__manage_tools first");
  });

  test("a run the projection serves is told nothing about promoting, and calls matches directly", async () => {
    config.execution = { default: "scripted-acp" };
    await chat("find the widget tools");

    const text = JSON.stringify(agentLog.systemPrompts.at(-1));
    expect(text).toContain("## Installed Apps");
    expect(text).not.toContain(PROMOTION_GUIDANCE);

    const search = JSON.stringify(agentLog.toolResults.at(-1));
    expect(search).toContain("widgets__widget_");
    expect(search).toContain("Call a match directly");
    expect(search).not.toContain("nb__manage_tools");
  });
});
