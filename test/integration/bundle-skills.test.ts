/**
 * Integration test for the bundle-skill adapter.
 *
 * Boots a real Runtime, registers an in-process MCP source that exposes:
 *   - one tool (`test__doit`) so the bundle's tools land in the active toolset
 *   - one resource at `skill://test/usage` carrying workflow guidance
 *
 * Then runs a chat with NO `appContext` — the failing production case — and
 * verifies the synthesized bundle skill flows through `selectLayer3Skills`
 * and appears in the `skills.loaded` payload with `scope: "bundle"` and
 * `loadedBy: "tool_affinity"`.
 *
 * This is the end-to-end check that the bundle-skill adapter actually closes
 * the gap that left `synapse-collateral`'s SKILL.md invisible in workspace-
 * level chats.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";

const SKILL_BODY =
  "# How to use the test bundle\n\nAlways call test__doit before anything else.";

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
      { uri: "skill://test/usage", name: "Usage", mimeType: "text/markdown" },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri === "skill://test/usage") {
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

const testDir = join(tmpdir(), `nimblebrain-bundle-skills-${Date.now()}`);
let runtime: Runtime;
let testSource: McpSource;

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });

  runtime = await Runtime.start({
    model: { provider: "custom", adapter: createEchoModel() },
    noDefaultBundles: true,
    logging: { disabled: true },
    workDir: testDir,
    telemetry: { enabled: false },
  });
  await provisionTestWorkspace(runtime);

  const bundleDir = createSkillFixtureBundle(join(testDir, "bundle"));
  testSource = new McpSource(
    "test",
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
    // Run a chat WITHOUT appContext, with test__doit visible in the toolset.
    const chat = await runtime.chat({
      workspaceId: TEST_WORKSPACE_ID,
      message: "hello",
      // Critical: NO appContext. This is the failing-prod case.
      allowedTools: ["test__doit"],
    });

    // Pull the conversation store and read the skills.loaded event.
    const store = runtime.getStore(TEST_WORKSPACE_ID);
    const events = await store.readEvents(chat.conversationId);
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
      (s) => s.id === "skill://test/usage",
    );
    expect(bundleEntry).toBeDefined();
    expect(bundleEntry?.scope).toBe("bundle");
    expect(bundleEntry?.loadedBy).toBe("tool_affinity");
    expect(bundleEntry?.reason).toContain("test__*");
  });

  it("does NOT synthesize a Layer 3 skill when the bundle is already on the appContext path", async () => {
    // When `appContext.serverName` is the bundle, its `skill://<name>/usage`
    // body is already injected via `<app-guide>` by `getAppSkillResource` on
    // the focused-app path. The Layer 3 adapter must skip that source or the
    // same content lands in the prompt twice under two different framings.
    const chat = await runtime.chat({
      workspaceId: TEST_WORKSPACE_ID,
      message: "scoped chat",
      appContext: { appName: "test", serverName: "test" },
      allowedTools: ["test__doit"],
    });

    const store = runtime.getStore(TEST_WORKSPACE_ID);
    const events = await store.readEvents(chat.conversationId);
    const skillsLoaded = events.find((e) => e.type === "skills.loaded");
    expect(skillsLoaded).toBeDefined();

    const payload = skillsLoaded as unknown as {
      skills: Array<{ id: string }>;
    };
    const bundleEntry = payload.skills.find((s) => s.id === "skill://test/usage");
    // The skill is gone from Layer 3 — `<app-guide>` is now its only home.
    expect(bundleEntry).toBeUndefined();
  });

  it("does NOT load the bundle skill when none of its tools are active", async () => {
    // No tools allowed → activeTools is empty after surfaceTools filters.
    // Bundle skill is `tool_affined` to test__* and must NOT load.
    const chat = await runtime.chat({
      workspaceId: TEST_WORKSPACE_ID,
      message: "hi without tools",
      allowedTools: [],
    });

    const store = runtime.getStore(TEST_WORKSPACE_ID);
    const events = await store.readEvents(chat.conversationId);
    const skillsLoaded = events.find((e) => e.type === "skills.loaded");
    expect(skillsLoaded).toBeDefined();

    const payload = skillsLoaded as unknown as {
      skills: Array<{ id: string }>;
    };
    const bundleEntry = payload.skills.find(
      (s) => s.id === "skill://test/usage",
    );
    expect(bundleEntry).toBeUndefined();
  });
});
