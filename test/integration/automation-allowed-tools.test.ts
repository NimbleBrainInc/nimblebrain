/**
 * An unattended run's `allowedTools` bounds what it can reach, not only what
 * it is shown at turn start. The model below tries both ways past the list:
 * activating a hidden tool through `nb__manage_tools`, then calling it by name.
 * Under the list both are refused and the tool never runs; without it the same
 * script reaches the tool, so the refusal comes from the list and nothing else.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import type { McpSource } from "../../src/tools/mcp-source.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { makeInProcessSource } from "../helpers/in-process-source.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

const TOOL = "crm__search";
const dir = join(tmpdir(), `nimblebrain-automation-allowed-tools-${Date.now()}`);
let runtime: Runtime;
let source: McpSource;
let handlerCalls = 0;

/** One run's script: activate the hidden tool, call it, finish. */
const reachForTool = () => [
  {
    toolCalls: [
      {
        toolCallId: "call-promote",
        toolName: "nb__manage_tools",
        input: JSON.stringify({ add: [TOOL] }),
      },
    ],
  },
  { toolCalls: [{ toolCallId: "call-tool", toolName: TOOL, input: "{}" }] },
  { text: "done" },
];

describe("an unattended run's allowedTools", () => {
  beforeAll(async () => {
    mkdirSync(dir, { recursive: true });
    runtime = await Runtime.start({
      identityProvider: devProvider,
      model: {
        provider: "custom",
        adapter: createEchoModel({ responses: [...reachForTool(), ...reachForTool()] }),
      },
      logging: { disabled: true },
      workDir: dir,
      telemetry: { enabled: false },
    });
    await provisionTestWorkspace(runtime);
    source = await makeInProcessSource("crm", [
      {
        name: "search",
        description: "Search the CRM.",
        inputSchema: { type: "object", properties: {} },
        handler: async () => {
          handlerCalls++;
          return { content: [{ type: "text", text: "found" }], isError: false };
        },
      },
    ]);
    runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID).addSource(source);
  });

  afterAll(async () => {
    await source.stop();
    await runtime.shutdown();
    if (existsSync(dir)) rmSync(dir, { recursive: true });
  });

  it("refuses activating or calling a tool outside the list", async () => {
    handlerCalls = 0;
    const result = await runtime.executeTask({
      identity: DEV_IDENTITY,
      workspaceId: TEST_WORKSPACE_ID,
      prompt: "search the crm",
      trigger: "schedule",
      allowedTools: ["files__*"],
    });

    expect(handlerCalls).toBe(0);
    expect(result.toolCalls.find((c) => c.name === TOOL)?.ok).toBe(false);
  });

  it("reaches the same tool when the run has no list", async () => {
    handlerCalls = 0;
    const result = await runtime.executeTask({
      identity: DEV_IDENTITY,
      workspaceId: TEST_WORKSPACE_ID,
      prompt: "search the crm",
      trigger: "schedule",
    });

    expect(handlerCalls).toBe(1);
    expect(result.toolCalls.find((c) => c.name === TOOL)?.ok).toBe(true);
  });
});
