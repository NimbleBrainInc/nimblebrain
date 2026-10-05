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
import { IdentityConnectorStore } from "../../src/identity/connector-store.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { DeclaredToolsUnavailableError } from "../../src/runtime/errors.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import type { McpSource } from "../../src/tools/mcp-source.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import {
  type FakeConnectorServer,
  startFakeConnectorServer,
} from "../helpers/fake-connector-server.ts";
import { makeInProcessSource } from "../helpers/in-process-source.ts";
import { recordingModel } from "../helpers/recording-model.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

const TOOL = "crm__search";
const dir = join(tmpdir(), `nimblebrain-task-allowed-tools-${Date.now()}`);
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
      languageModel: createEchoModel({ responses: [...reachForTool(), ...reachForTool()] }),
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

/**
 * The platform's own `nb__` tools are held to the list too: only search and
 * activation pass without being named, since they are how the run finds the
 * tools it is allowed. The script below searches for a files tool, then calls
 * two `nb__` tools the list does not name.
 */
describe("an unattended run's allowedTools and the nb__ tools", () => {
  const nbDir = join(tmpdir(), `nimblebrain-task-allowed-nb-${Date.now()}`);
  let nbRuntime: Runtime;
  const recorded = recordingModel(
    createEchoModel({
      responses: [
        {
          toolCalls: [
            {
              toolCallId: "call-search",
              toolName: "nb__search",
              input: JSON.stringify({ scope: "tools", query: "files" }),
            },
          ],
        },
        {
          toolCalls: [
            {
              toolCallId: "call-resource",
              toolName: "nb__read_resource",
              input: JSON.stringify({ server: "files", uri: "files://anything" }),
            },
            {
              toolCallId: "call-prefs",
              toolName: "nb__set_preferences",
              input: JSON.stringify({ timezone: "UTC" }),
            },
          ],
        },
        { text: "done" },
      ],
    }),
  );

  beforeAll(async () => {
    mkdirSync(nbDir, { recursive: true });
    nbRuntime = await Runtime.start({
      identityProvider: devProvider,
      languageModel: recorded.model,
      logging: { disabled: true },
      workDir: nbDir,
      telemetry: { enabled: false },
    });
    await provisionTestWorkspace(nbRuntime);
  });

  afterAll(async () => {
    await nbRuntime.shutdown();
    if (existsSync(nbDir)) rmSync(nbDir, { recursive: true });
  });

  it("finds a files tool through nb__search and is refused nb__ tools the list does not name", async () => {
    const result = await nbRuntime.executeTask({
      identity: DEV_IDENTITY,
      workspaceId: TEST_WORKSPACE_ID,
      prompt: "tidy the files",
      trigger: "schedule",
      allowedTools: ["files__*"],
    });

    const call = (name: string) => result.toolCalls.find((c) => c.name === name);
    expect(call("nb__search")?.ok).toBe(true);
    expect(call("nb__search")?.output).toContain("files__");
    for (const name of ["nb__read_resource", "nb__set_preferences"]) {
      expect(call(name)?.ok).toBe(false);
      expect(call(name)?.output).toContain("not in this run's allowed tools");
    }

    // The model is shown what the router reaches, and no more.
    const shown = recorded.calls[0]?.tools.map((t) => t.name) ?? [];
    expect(shown).toContain("nb__search");
    expect(shown).not.toContain("nb__read_resource");
    expect(shown).not.toContain("nb__set_preferences");
    expect(shown).not.toContain("nb__status");
    expect(shown.some((n) => n.startsWith("files__"))).toBe(true);
  });

  // The skill catalog is opened only through `nb__use_skill`, so a run whose
  // list does not name that tool is not offered one.
  it("offers the skill catalog only when the list allows nb__use_skill", async () => {
    const systemPromptOf = async (allowedTools: string[]) => {
      recorded.calls.length = 0;
      await nbRuntime.executeTask({
        identity: DEV_IDENTITY,
        workspaceId: TEST_WORKSPACE_ID,
        prompt: "tidy the files",
        trigger: "schedule",
        allowedTools,
      });
      return JSON.stringify(recorded.calls[0]?.prompt.filter((m) => m.role === "system"));
    };
    const catalogInstruction = "When a task matches a listed skill, load it with `nb__use_skill`";

    expect(await systemPromptOf(["files__*", "nb__use_skill"])).toContain(catalogInstruction);
    expect(await systemPromptOf(["files__*"])).not.toContain(catalogInstruction);
  });
});

/**
 * A tool the list declares that nothing the run can reach matches is a run
 * that cannot do its job. Left to run, it never tries the tool and ends
 * `complete`, so it is refused before its first model call instead. Reachable
 * here is the router's set, which holds the owner's granted `my_` connectors.
 */
describe("an unattended run whose declared tools are unavailable", () => {
  const declDir = join(tmpdir(), `nimblebrain-task-declared-tools-${Date.now()}`);
  let declRuntime: Runtime;
  let personal: FakeConnectorServer;
  const recorded = recordingModel(createEchoModel({ responses: [{ text: "done" }] }));

  const run = (allowedTools: string[]) =>
    declRuntime.executeTask({
      identity: DEV_IDENTITY,
      workspaceId: TEST_WORKSPACE_ID,
      prompt: "suppress the new crm contacts",
      trigger: "schedule",
      allowedTools,
    });

  beforeAll(async () => {
    mkdirSync(declDir, { recursive: true });
    declRuntime = await Runtime.start({
      identityProvider: devProvider,
      languageModel: recorded.model,
      logging: { disabled: true },
      workDir: declDir,
      telemetry: { enabled: false },
      allowInsecureRemotes: true,
    });
    await provisionTestWorkspace(declRuntime);
    personal = startFakeConnectorServer(["list_notes"]);
    await new IdentityConnectorStore({ workDir: declDir }).add(DEV_IDENTITY.id, {
      url: personal.url,
      serverName: "granola",
      ui: null,
    });
    await declRuntime
      .getPermissionStore()
      .grantConnector(DEV_IDENTITY.id, "granola", TEST_WORKSPACE_ID);
  });

  afterAll(async () => {
    await declRuntime.shutdown();
    personal.close();
    if (existsSync(declDir)) rmSync(declDir, { recursive: true });
  });

  it("refuses the run before any model call, naming the missing tools", async () => {
    recorded.calls.length = 0;
    const err = await run(["crm__*", "files__*", "mail__send"]).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DeclaredToolsUnavailableError);
    expect((err as DeclaredToolsUnavailableError).code).toBe("declared_tools_unavailable");
    expect((err as DeclaredToolsUnavailableError).tools).toEqual(["crm__*", "mail__send"]);
    expect(recorded.calls).toHaveLength(0);
  });

  it("runs when every declared tool is reachable, a granted personal connector included", async () => {
    recorded.calls.length = 0;
    await run(["files__*", "my_granola__*", "nb__search"]);

    expect(recorded.calls).toHaveLength(1);
  });

  it("checks nothing for a run with no list", async () => {
    recorded.calls.length = 0;
    await run([]);

    expect(recorded.calls).toHaveLength(1);
  });
});
