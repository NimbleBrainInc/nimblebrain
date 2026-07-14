/**
 * Integration test for the bundle-skill adapter.
 *
 * Boots a real Runtime, registers an in-process MCP source whose registry name
 * is a reverse-DNS SLUG (`ai-nimblebrain-test-mcp`, like a fleet connector) that
 * exposes:
 *   - one tool (`ai-nimblebrain-test-mcp__doit`) so its tools land in the toolset
 *   - one SEP-2640 skill resource at the SHORT-name `skill://test/SKILL.md`,
 *     discovered via `resources/list` (NOT a guessed URI)
 *
 * The slug-vs-short-name split is the exact production bug: discovery must find
 * the skill by listing resources, since the old guess (`skill://<sourceName>/…`)
 * looked under the slug and missed the short-name path.
 *
 * Then runs a chat with NO `appContext` — the failing production case — and
 * verifies the synthesized skill flows through `selectLayer3Skills` and appears
 * in the `skills.loaded` payload with `scope: "bundle"` and
 * `loadedBy: "tool_affinity"`.
 */

import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { reconstructMessages } from "../../src/conversation/event-reconstructor.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";
import { namespacedToolName } from "../../src/tools/namespace.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";

const SKILL_BODY = `---
name: test
description: How to use the test server.
---

# How to use the test server

Always call test__doit before anything else.`;

function createSkillFixtureBundle(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const nodeModulesPath = join(import.meta.dir, "../..", "node_modules");
  const serverCode = `
const { Server } = require("${nodeModulesPath}/@modelcontextprotocol/sdk/dist/cjs/server/index.js");
const { StdioServerTransport } = require("${nodeModulesPath}/@modelcontextprotocol/sdk/dist/cjs/server/stdio.js");
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} = require("${nodeModulesPath}/@modelcontextprotocol/sdk/dist/cjs/types.js");

async function main() {
  const server = new Server(
    { name: "test", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "doit",
        description: "Do the thing",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: "text", text: "done" }],
  }));

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      { uri: "skill://test/SKILL.md", name: "test", mimeType: "text/markdown" },
      { uri: "skill://test/reference", name: "test-reference", mimeType: "text/markdown" },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri === "skill://test/SKILL.md") {
      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: "text/markdown",
            text: ${JSON.stringify(SKILL_BODY)},
          },
        ],
      };
    }
    if (request.params.uri === "skill://test/reference") {
      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: "text/markdown",
            text: "# Reference. Detailed tool catalog and error recovery.",
          },
        ],
      };
    }
    throw new Error("Resource not found: " + request.params.uri);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
main();
`;
  writeFileSync(join(dir, "server.cjs"), serverCode);
  return dir;
}

// Captures the prompt the model receives so the test can assert on the assembled
// system prompt (the <app-guide> reference hint), which no event carries.
let lastPrompt: LanguageModelV3CallOptions["prompt"] | undefined;

function createCapturingModel(): LanguageModelV3 {
  const echo = createEchoModel();
  return {
    ...echo,
    doStream: (options: LanguageModelV3CallOptions) => {
      lastPrompt = options.prompt;
      return echo.doStream(options);
    },
  };
}

/** All text across every message in the last captured prompt. */
function lastPromptText(): string {
  if (!lastPrompt) return "";
  return lastPrompt
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : m.content.map((p) => ("text" in p ? p.text : "")).join(" "),
    )
    .join("\n");
}

const testDir = join(tmpdir(), `nimblebrain-bundle-skills-${Date.now()}`);
let runtime: Runtime;
let testSource: McpSource;

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });

  runtime = await Runtime.start({
    model: { provider: "custom", adapter: createCapturingModel() },
    noDefaultBundles: true,
    logging: { disabled: true },
    workDir: testDir,
    telemetry: { enabled: false },
  });
  await provisionTestWorkspace(runtime);

  const bundleDir = createSkillFixtureBundle(join(testDir, "bundle"));
  testSource = new McpSource(
    "ai-nimblebrain-test-mcp",
    {
      type: "stdio",
      spawn: {
        command: "node",
        args: [join(bundleDir, "server.cjs")],
        env: process.env as Record<string, string>,
      },
    },
    new NoopEventSink(),
  );
  await testSource.start();
  runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID).addSource(testSource);
});

afterAll(async () => {
  try {
    await testSource.stop();
  } catch {
    // already stopped
  }
  await runtime.shutdown();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

describe("bundle-skill adapter — end-to-end", () => {
  it("loads bundle skill via Layer 3 tool_affined selection when tools are active (no appContext)", async () => {
    // Run a chat WITHOUT appContext, with the slug-prefixed tool visible.
    const chat = await runtime.chat({
      workspaceId: TEST_WORKSPACE_ID,
      message: "hello",
      // Critical: NO appContext. This is the failing-prod case.
      allowedTools: ["ai-nimblebrain-test-mcp__doit"],
    });

    // Pull the conversation store and read the skills.loaded event.
    const store = await runtime.resolveConversationStore(chat.conversationId);
    const events = await store!.readEvents(chat.conversationId);
    const skillsLoaded = events.find((e) => e.type === "skills.loaded");
    expect(skillsLoaded).toBeDefined();

    const payload = skillsLoaded as unknown as {
      skills: Array<{
        id: string;
        scope: string;
        loadedBy: string;
        reason: string;
      }>;
    };
    expect(payload.skills.length).toBeGreaterThan(0);

    const bundleEntry = payload.skills.find(
      (s) => s.id === "skill://test/SKILL.md",
    );
    expect(bundleEntry).toBeDefined();
    expect(bundleEntry?.scope).toBe("bundle");
    expect(bundleEntry?.loadedBy).toBe("tool_affinity");
    expect(bundleEntry?.reason).toContain("ai-nimblebrain-test-mcp__*");
  });

  it("does NOT synthesize a Layer 3 skill when the bundle is already on the appContext path", async () => {
    // When `appContext.serverName` is the server, its `skill://<name>/SKILL.md`
    // body is already injected via `<app-guide>` by `discoverServerSkills` on
    // the focused-app path. The Layer 3 adapter must skip that source or the
    // same content lands in the prompt twice under two different framings.
    const chat = await runtime.chat({
      workspaceId: TEST_WORKSPACE_ID,
      message: "scoped chat",
      appContext: { appName: "test", serverName: "ai-nimblebrain-test-mcp" },
      allowedTools: ["ai-nimblebrain-test-mcp__doit"],
    });

    const store = await runtime.resolveConversationStore(chat.conversationId);
    const events = await store!.readEvents(chat.conversationId);
    const skillsLoaded = events.find((e) => e.type === "skills.loaded");
    expect(skillsLoaded).toBeDefined();

    const payload = skillsLoaded as unknown as {
      skills: Array<{ id: string }>;
    };
    const bundleEntry = payload.skills.find((s) => s.id === "skill://test/SKILL.md");
    // The skill is gone from Layer 3 — `<app-guide>` is now its only home.
    expect(bundleEntry).toBeUndefined();
  });

  it("derives the companion reference URI from the discovered skill path, not the source slug", async () => {
    // The server (slug `ai-nimblebrain-test-mcp`) publishes both its skill and its
    // reference under the SHORT `skill://test/…` path. The focused-app briefing must
    // derive the reference from the discovered SKILL.md URI (`skill://test/reference`),
    // never from the source slug.
    lastPrompt = undefined;
    await runtime.chat({
      workspaceId: TEST_WORKSPACE_ID,
      message: "scoped chat with reference",
      appContext: { appName: "test", serverName: "ai-nimblebrain-test-mcp" },
      allowedTools: ["ai-nimblebrain-test-mcp__doit"],
    });
    // compose.ts renders "read the `skill://test/reference` resource" into <app-guide>.
    const prompt = lastPromptText();
    expect(prompt).toContain("skill://test/reference");
    // The old slug-based guess must NOT appear.
    expect(prompt).not.toContain("ai-nimblebrain-test-mcp/reference");
  });

  it("does NOT load the bundle skill when none of its tools are active", async () => {
    // No tools allowed → activeTools is empty after surfaceTools filters.
    // Bundle skill is `tool_affined` to ai-nimblebrain-test-mcp__* and must NOT load.
    const chat = await runtime.chat({
      workspaceId: TEST_WORKSPACE_ID,
      message: "hi without tools",
      allowedTools: [],
    });

    const store = await runtime.resolveConversationStore(chat.conversationId);
    const events = await store!.readEvents(chat.conversationId);
    const skillsLoaded = events.find((e) => e.type === "skills.loaded");
    expect(skillsLoaded).toBeDefined();

    const payload = skillsLoaded as unknown as {
      skills: Array<{ id: string }>;
    };
    const bundleEntry = payload.skills.find(
      (s) => s.id === "skill://test/SKILL.md",
    );
    expect(bundleEntry).toBeUndefined();
  });
});

/**
 * Mid-turn promotion path.
 *
 * Turn-start Layer-3 selection only matches the tools active at turn start, so a
 * server whose tool is behind PROGRESSIVE DISCLOSURE — activated mid-turn via
 * `nb__manage_tools` — never matches, and its bundle skill never loads. The fix
 * feeds bundle skills into the surface-once connector-skill channel and fires it
 * on tool PROMOTION, so the guidance arrives the moment the tool goes live.
 *
 * This uses its own Runtime with a SCRIPTED model (the shared capturing model
 * has no response queue): turn 1 promotes the fixture tool, turn 2 finishes
 * WITHOUT calling it — proving the skill surfaces on promotion, before any
 * tool.start.
 */
const promoDir = join(tmpdir(), `nimblebrain-bundle-skills-promo-${Date.now()}`);
let promoRuntime: Runtime;
let promoSource: McpSource;

// The fixture tool is not in the turn-start active set (behind progressive
// disclosure); the model promotes it by its workspace-namespaced name.
const PROMOTED_TOOL = namespacedToolName(TEST_WORKSPACE_ID, "ai-nimblebrain-test-mcp__doit");
const MANAGE_TOOLS = namespacedToolName(TEST_WORKSPACE_ID, "nb__manage_tools");

describe("bundle-skill adapter — mid-turn tool promotion", () => {
  beforeAll(async () => {
    mkdirSync(promoDir, { recursive: true });

    const model = createEchoModel({
      responses: [
        // Turn 1: promote the fixture tool mid-turn. Its tools are NOT in the
        // turn-start active set, so turn-start Layer-3 selection missed the skill.
        {
          toolCalls: [
            {
              toolCallId: "call-promote",
              toolName: MANAGE_TOOLS,
              input: JSON.stringify({ add: [PROMOTED_TOOL] }),
            },
          ],
        },
        // Turn 2: finish WITHOUT calling the promoted tool — the skill must
        // already have surfaced on promotion (not at a later tool.start).
        { text: "done" },
      ],
    });

    promoRuntime = await Runtime.start({
      model: { provider: "custom", adapter: model },
      noDefaultBundles: true,
      logging: { disabled: true },
      workDir: promoDir,
      telemetry: { enabled: false },
    });
    await provisionTestWorkspace(promoRuntime);

    const bundleDir = createSkillFixtureBundle(join(promoDir, "bundle"));
    promoSource = new McpSource(
      "ai-nimblebrain-test-mcp",
      {
        type: "stdio",
        spawn: {
          command: "node",
          args: [join(bundleDir, "server.cjs")],
          env: process.env as Record<string, string>,
        },
      },
      new NoopEventSink(),
    );
    await promoSource.start();
    promoRuntime.getRegistryForWorkspace(TEST_WORKSPACE_ID).addSource(promoSource);
  });

  afterAll(async () => {
    try {
      await promoSource.stop();
    } catch {
      // already stopped
    }
    await promoRuntime.shutdown();
    if (existsSync(promoDir)) rmSync(promoDir, { recursive: true });
  });

  it("surfaces the bundle skill when its tool is promoted mid-turn (not in the turn-start set)", async () => {
    const chat = await promoRuntime.chat({
      workspaceId: TEST_WORKSPACE_ID,
      message: "do the thing",
      // Pre-filter the turn-start active set down to system tools only: the
      // fixture tool is excluded, so it's behind progressive disclosure. It stays
      // in the workspace registry, so `nb__manage_tools` can still promote it.
      allowedTools: ["nb__manage_tools"],
    });

    const store = await promoRuntime.resolveConversationStore(chat.conversationId);
    const events = await store!.readEvents(chat.conversationId);

    // Regression precondition: the bundle skill did NOT load at turn start — its
    // tool wasn't active, so turn-start Layer-3 selection couldn't match it.
    const skillsLoaded = events.find((e) => e.type === "skills.loaded") as unknown as
      | { skills: Array<{ id: string }> }
      | undefined;
    const turnStartBundle = skillsLoaded?.skills.find((s) => s.id === "skill://test/SKILL.md");
    expect(turnStartBundle).toBeUndefined();

    // The fixture tool was promoted mid-turn via nb__manage_tools (tool.promoted
    // itself is transient telemetry the store doesn't persist; the manage_tools
    // result is the persisted proof it went live).
    const manageDone = events.find(
      (e) => e.type === "tool.done" && (e as unknown as { name?: string }).name === MANAGE_TOOLS,
    ) as unknown as { output?: string } | undefined;
    expect(manageDone?.output).toContain("Promoted 1/1");

    // The bundle skill surfaced via the connector-skill channel ON PROMOTION —
    // this is the exact regression the fix closes.
    const injected = events.find((e) => e.type === "connector.skill.injected") as unknown as
      | { skillName: string; skillBody: string; scope: string; toolName: string }
      | undefined;
    expect(injected).toBeDefined();
    expect(injected?.skillName).toBe("bundle:ai-nimblebrain-test-mcp:test");
    expect(injected?.skillBody).toContain("How to use the test server");

    // And it rides the conversation history as a `<connector-skill>` block —
    // the surface-once channel, never the cached system prefix.
    const historyText = reconstructMessages(events)
      .flatMap((m) => m.content)
      .map((p) => ("text" in p ? p.text : ""))
      .join("\n");
    expect(historyText).toContain("<connector-skill");
  });
});

/**
 * Declared loading-strategy is honored end-to-end.
 *
 * A server exposes TWO skill resources whose only difference is the strategy
 * they declare in `metadata.nimblebrain.loading-strategy`:
 *   - `skill://always-guide/SKILL.md` → `always`
 *   - `skill://dynamic-usage/SKILL.md` → declares nothing (defaults to `dynamic`)
 *
 * The `always` skill must compose into context EVERY turn, even when none of the
 * server's tools are in the active set (the exact case turn-start Layer-3
 * selection can't cover). The `dynamic` skill must stay tool-gated. Both must be
 * discovered from the same `resources/list`.
 */
const ALWAYS_SKILL_BODY = `---
name: always-guide
description: The always-on workflow for the multi server.
metadata:
  nimblebrain:
    loading-strategy: always
---

# Always-on workflow

ALWAYS_ON_WORKFLOW_MARKER — read this every turn.`;

const DYNAMIC_SKILL_BODY = `---
name: dynamic-usage
description: How to call the multi server's tools.
---

# Tool usage

DYNAMIC_USAGE_MARKER — call multi__doit correctly.`;

function createMultiSkillFixtureBundle(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const nodeModulesPath = join(import.meta.dir, "../..", "node_modules");
  const serverCode = `
const { Server } = require("${nodeModulesPath}/@modelcontextprotocol/sdk/dist/cjs/server/index.js");
const { StdioServerTransport } = require("${nodeModulesPath}/@modelcontextprotocol/sdk/dist/cjs/server/stdio.js");
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} = require("${nodeModulesPath}/@modelcontextprotocol/sdk/dist/cjs/types.js");

async function main() {
  const server = new Server(
    { name: "multi", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: "doit", description: "Do the thing", inputSchema: { type: "object", properties: {} } },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: "text", text: "done" }],
  }));

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      { uri: "skill://always-guide/SKILL.md", name: "always-guide", mimeType: "text/markdown" },
      { uri: "skill://dynamic-usage/SKILL.md", name: "dynamic-usage", mimeType: "text/markdown" },
    ],
  }));

  const bodies = {
    "skill://always-guide/SKILL.md": ${JSON.stringify(ALWAYS_SKILL_BODY)},
    "skill://dynamic-usage/SKILL.md": ${JSON.stringify(DYNAMIC_SKILL_BODY)},
  };
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const text = bodies[request.params.uri];
    if (text === undefined) throw new Error("Resource not found: " + request.params.uri);
    return { contents: [{ uri: request.params.uri, mimeType: "text/markdown", text }] };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
main();
`;
  writeFileSync(join(dir, "server.cjs"), serverCode);
  return dir;
}

const multiDir = join(tmpdir(), `nimblebrain-bundle-skills-multi-${Date.now()}`);
let multiRuntime: Runtime;
let multiSource: McpSource;
// Captures the composed prompt for the multi-skill runtime.
let multiPrompt: LanguageModelV3CallOptions["prompt"] | undefined;

function multiPromptText(): string {
  if (!multiPrompt) return "";
  return multiPrompt
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : m.content.map((p) => ("text" in p ? p.text : "")).join(" "),
    )
    .join("\n");
}

describe("bundle-skill adapter — honors declared loading-strategy", () => {
  beforeAll(async () => {
    mkdirSync(multiDir, { recursive: true });
    const echo = createEchoModel();
    const capturing: LanguageModelV3 = {
      ...echo,
      doStream: (options: LanguageModelV3CallOptions) => {
        multiPrompt = options.prompt;
        return echo.doStream(options);
      },
    };

    multiRuntime = await Runtime.start({
      model: { provider: "custom", adapter: capturing },
      noDefaultBundles: true,
      logging: { disabled: true },
      workDir: multiDir,
      telemetry: { enabled: false },
    });
    await provisionTestWorkspace(multiRuntime);

    const bundleDir = createMultiSkillFixtureBundle(join(multiDir, "bundle"));
    multiSource = new McpSource(
      "ai-nimblebrain-multi-mcp",
      {
        type: "stdio",
        spawn: {
          command: "node",
          args: [join(bundleDir, "server.cjs")],
          env: process.env as Record<string, string>,
        },
      },
      new NoopEventSink(),
    );
    await multiSource.start();
    multiRuntime.getRegistryForWorkspace(TEST_WORKSPACE_ID).addSource(multiSource);
  });

  afterAll(async () => {
    try {
      await multiSource.stop();
    } catch {
      // already stopped
    }
    await multiRuntime.shutdown();
    if (existsSync(multiDir)) rmSync(multiDir, { recursive: true });
  });

  it("composes the `always` skill into context even when the server's tools are NOT active", async () => {
    multiPrompt = undefined;
    // No server tools active — the case turn-start Layer-3 selection can't cover.
    const chat = await multiRuntime.chat({
      workspaceId: TEST_WORKSPACE_ID,
      message: "hello",
      allowedTools: [],
    });

    const prompt = multiPromptText();
    // The `always` skill is unconditionally in context.
    expect(prompt).toContain("ALWAYS_ON_WORKFLOW_MARKER");
    // The `dynamic` skill is tool-gated and its tool isn't active — absent.
    expect(prompt).not.toContain("DYNAMIC_USAGE_MARKER");

    // It rides the always-on context channel, so it is NOT reported as a Layer-3
    // (tool-affinity) selection in `skills.loaded`.
    const store = await multiRuntime.resolveConversationStore(chat.conversationId);
    const events = await store!.readEvents(chat.conversationId);
    const skillsLoaded = events.find((e) => e.type === "skills.loaded") as unknown as
      | { skills: Array<{ id: string }> }
      | undefined;
    const layer3Always = skillsLoaded?.skills.find((s) => s.id === "skill://always-guide/SKILL.md");
    expect(layer3Always).toBeUndefined();
  });

  it("loads the `dynamic` skill via Layer 3 when its tool is active, alongside the always skill in context", async () => {
    multiPrompt = undefined;
    const chat = await multiRuntime.chat({
      workspaceId: TEST_WORKSPACE_ID,
      message: "do it",
      allowedTools: ["ai-nimblebrain-multi-mcp__doit"],
    });

    const prompt = multiPromptText();
    // Both skills are now discovered and present in the prompt: the always one in
    // context, the dynamic one via Layer-3 tool-affinity.
    expect(prompt).toContain("ALWAYS_ON_WORKFLOW_MARKER");
    expect(prompt).toContain("DYNAMIC_USAGE_MARKER");

    const store = await multiRuntime.resolveConversationStore(chat.conversationId);
    const events = await store!.readEvents(chat.conversationId);
    const skillsLoaded = events.find((e) => e.type === "skills.loaded") as unknown as
      | { skills: Array<{ id: string; scope: string; loadedBy: string }> }
      | undefined;
    // The dynamic skill is the Layer-3 selection; the always skill is not.
    const dynamicEntry = skillsLoaded?.skills.find(
      (s) => s.id === "skill://dynamic-usage/SKILL.md",
    );
    expect(dynamicEntry?.scope).toBe("bundle");
    expect(dynamicEntry?.loadedBy).toBe("tool_affinity");
    const alwaysEntry = skillsLoaded?.skills.find((s) => s.id === "skill://always-guide/SKILL.md");
    expect(alwaysEntry).toBeUndefined();
  });
});
