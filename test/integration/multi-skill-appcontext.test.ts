/**
 * A server that publishes more than one `always` skill keeps ALL of them when
 * the user enters its app.
 *
 * Regression guard. `loadBundleSkills` used to skip the entered SOURCE, on the
 * premise that its guidance was recovered via `<app-guide>` — but `<app-guide>`
 * carries only the primary skill (the first `resources/list` entry). One skill
 * per server made that equivalent; six made it a five-sixths loss, silently, on
 * every turn sent from the app panel. Dedup is now per-SKILL (`excludeSkillUri`),
 * so only the body actually composed elsewhere is withheld.
 *
 * The paired signature is asserted too: entering an app promotes that server's
 * tools to direct (`surfaceTools`'s `focusedServerName`). That is intended, and
 * it is what made the skill loss look like a tool-promotion bug in production —
 * both symptoms ride one request flag.
 *
 * Both chats are otherwise identical: same workspace, same message, same
 * server. `appContext` is the only variable.
 */

import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";

const SERVER_NAME = "ai-nimblebrain-multiskill-mcp";

/** Six `always` skills, each with a unique phrase so presence is unambiguous. */
const SKILLS = [
  { slug: "orientation", phrase: "ORIENTATION-MARKER-ALPHA" },
  { slug: "consistency-gate", phrase: "CONSISTENCY-MARKER-BRAVO" },
  { slug: "signal-ethics", phrase: "ETHICS-MARKER-CHARLIE" },
  { slug: "writing", phrase: "WRITING-MARKER-DELTA" },
  { slug: "lead-quality", phrase: "LEADQUALITY-MARKER-ECHO" },
  { slug: "research-discipline", phrase: "RESEARCH-MARKER-FOXTROT" },
];

/** Tool count mirrors a real fleet bundle, so the promotion delta is visible. */
const TOOL_NAMES = ["draft_email", "reject_draft", "create_campaign", "list_campaigns"];

function skillBody(slug: string, phrase: string): string {
  return `---
name: ${slug}
description: Guidance for ${slug}.
metadata:
  nimblebrain:
    loading-strategy: always
---

# ${slug}

${phrase} — this rule must be in context on every turn.`;
}

function createMultiSkillBundle(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const nodeModulesPath = join(import.meta.dir, "../..", "node_modules");
  const resources = SKILLS.map((s) => ({
    uri: `skill://${s.slug}/SKILL.md`,
    name: s.slug,
    mimeType: "text/markdown",
  }));
  const bodies = Object.fromEntries(
    SKILLS.map((s) => [`skill://${s.slug}/SKILL.md`, skillBody(s.slug, s.phrase)]),
  );
  const tools = TOOL_NAMES.map((n) => ({
    name: n,
    description: `Do ${n}`,
    inputSchema: { type: "object", properties: {} },
  }));

  writeFileSync(
    join(dir, "server.cjs"),
    `
const { Server } = require("${nodeModulesPath}/@modelcontextprotocol/sdk/dist/cjs/server/index.js");
const { StdioServerTransport } = require("${nodeModulesPath}/@modelcontextprotocol/sdk/dist/cjs/server/stdio.js");
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} = require("${nodeModulesPath}/@modelcontextprotocol/sdk/dist/cjs/types.js");

const BODIES = ${JSON.stringify(bodies)};

async function main() {
  const server = new Server(
    { name: "multiskill", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ${JSON.stringify(tools)} }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: "text", text: "done" }],
  }));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: ${JSON.stringify(resources)},
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const text = BODIES[request.params.uri];
    if (!text) throw new Error("Resource not found: " + request.params.uri);
    return { contents: [{ uri: request.params.uri, mimeType: "text/markdown", text }] };
  });
  await server.connect(new StdioServerTransport());
}
main();
`,
  );
  return dir;
}


/**
 * A second server publishing a skill at the SAME `skill://` path as the first
 * server's primary. Skill URIs carry no publisher, so the path alone cannot
 * identify a skill — this fixture is what proves the exclusion is keyed by the
 * publisher too.
 */
const NEIGHBOUR_NAME = "ai-nimblebrain-neighbour-mcp";
const NEIGHBOUR_PHRASE = "NEIGHBOUR-MARKER-GOLF";

function createNeighbourBundle(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const nodeModulesPath = join(import.meta.dir, "../..", "node_modules");
  // Same path as SKILLS[0] — `skill://orientation/SKILL.md`.
  const uri = `skill://${SKILLS[0]?.slug}/SKILL.md`;
  writeFileSync(
    join(dir, "server.cjs"),
    `
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
    { name: "neighbour", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object", properties: {} } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: "text", text: "done" }],
  }));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ uri: ${JSON.stringify(uri)}, name: "orientation", mimeType: "text/markdown" }],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async () => ({
    contents: [{
      uri: ${JSON.stringify(uri)},
      mimeType: "text/markdown",
      text: ${JSON.stringify("---\nname: orientation\ndescription: Neighbour guidance.\nmetadata:\n  nimblebrain:\n    loading-strategy: always\n---\n\n# orientation\n\nNEIGHBOUR-MARKER-GOLF — this rule must be in context on every turn.")},
    }],
  }));
  await server.connect(new StdioServerTransport());
}
main();
`,
  );
  return dir;
}

let lastPrompt: LanguageModelV3CallOptions["prompt"] | undefined;
let lastToolCount = 0;

function createCapturingModel(): LanguageModelV3 {
  const echo = createEchoModel();
  return {
    ...echo,
    doStream: (options: LanguageModelV3CallOptions) => {
      // Ignore the auto-title call, which composes no skills.
      const isTitle = options.prompt.some(
        (m) => typeof m.content === "string" && m.content.includes("Generate a 3-6 word title"),
      );
      if (!isTitle) {
        lastPrompt = options.prompt;
        lastToolCount = options.tools?.length ?? 0;
      }
      return echo.doStream(options);
    },
  };
}

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

const testDir = join(tmpdir(), `nimblebrain-multiskill-appcontext-${Date.now()}`);
let runtime: Runtime;
let source: McpSource;
let neighbour: McpSource;

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

  const bundleDir = createMultiSkillBundle(join(testDir, "bundle"));
  source = new McpSource(
    SERVER_NAME,
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
  await source.start();
  runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID).addSource(source);

  const neighbourDir = createNeighbourBundle(join(testDir, "neighbour"));
  neighbour = new McpSource(
    NEIGHBOUR_NAME,
    {
      type: "stdio",
      spawn: {
        command: "node",
        args: [join(neighbourDir, "server.cjs")],
        env: process.env as Record<string, string>,
      },
    },
    new NoopEventSink(),
  );
  await neighbour.start();
  runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID).addSource(neighbour);
});

afterAll(async () => {
  for (const s of [source, neighbour]) {
    try {
      await s?.stop();
    } catch {
      // already stopped
    }
  }
  await runtime.shutdown();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

describe("multi-skill server + appContext", () => {
  it("composes all six `always` skills when the app is NOT entered", async () => {
    await runtime.chat({
      workspaceId: TEST_WORKSPACE_ID,
      message: "Draft an email to a prospect.",
    });
    const prompt = lastPromptText();
    for (const s of SKILLS) {
      expect(prompt).toContain(s.phrase);
    }
  });

  it("keeps all six when appContext names the server", async () => {
    await runtime.chat({
      workspaceId: TEST_WORKSPACE_ID,
      message: "Draft an email to a prospect.",
      appContext: { appName: "Multi Skill", serverName: SERVER_NAME },
    });
    const prompt = lastPromptText();
    for (const s of SKILLS) {
      expect(prompt).toContain(s.phrase);
    }
  });

  it("carries the primary exactly once — <app-guide>, not also the context channel", async () => {
    await runtime.chat({
      workspaceId: TEST_WORKSPACE_ID,
      message: "Draft an email to a prospect.",
      appContext: { appName: "Multi Skill", serverName: SERVER_NAME },
    });
    const prompt = lastPromptText();
    const primary = SKILLS[0]?.phrase ?? "";
    expect(prompt.split(primary).length - 1).toBe(1);
    expect(prompt).toContain("<app-guide>");
  });

  it("promotes the entered server's tools to direct in the same turn", async () => {
    await runtime.chat({
      workspaceId: TEST_WORKSPACE_ID,
      message: "Draft an email to a prospect.",
    });
    const withoutApp = lastToolCount;

    await runtime.chat({
      workspaceId: TEST_WORKSPACE_ID,
      message: "Draft an email to a prospect.",
      appContext: { appName: "Multi Skill", serverName: SERVER_NAME },
    });
    const withApp = lastToolCount;

    expect(withApp - withoutApp).toBe(TOOL_NAMES.length);
  });
});

describe("same skill path on two servers", () => {
  it("entering one server keeps the other's identically-pathed `always` skill", async () => {
    // Both publish `skill://orientation/SKILL.md`. Keying the exclusion on the
    // uri alone would drop the neighbour's copy the moment the first is entered
    // — the same silent drop this PR closes, one scope out.
    await runtime.chat({
      workspaceId: TEST_WORKSPACE_ID,
      message: "Draft an email to a prospect.",
    });
    expect(lastPromptText()).toContain(NEIGHBOUR_PHRASE);

    await runtime.chat({
      workspaceId: TEST_WORKSPACE_ID,
      message: "Draft an email to a prospect.",
      appContext: { appName: "Multi Skill", serverName: SERVER_NAME },
    });
    const prompt = lastPromptText();
    expect(prompt).toContain(NEIGHBOUR_PHRASE);
    // And the entered server's own primary still rides <app-guide> exactly once.
    expect(prompt.split(SKILLS[0]?.phrase ?? "").length - 1).toBe(1);
  });
});
