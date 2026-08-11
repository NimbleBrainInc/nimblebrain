/**
 * End-to-end: a server-published skill fires on a declared trigger phrase.
 *
 * A connector ships skills as `skill://…/SKILL.md` resources and can declare
 * `triggers` in frontmatter exactly like a filesystem skill. Two independent
 * blockers meant it could never fire (#977):
 *
 *   1. The discovery path parsed `loading-strategy` and `priority` only, so
 *      `triggers` never reached the synthesized manifest. Identical frontmatter
 *      behaved differently by origin, silently — the file parsed fine and the
 *      manifest carried `triggers: undefined`.
 *   2. The per-request `SkillMatcher` was loaded with the conversation pool
 *      only. Server-published skills were discovered later, in the tool-affinity
 *      selection path, and handed to nothing else.
 *
 * The load-bearing case here is `allowedTools: []`: with none of the server's
 * tools in the active set, tool-affinity CANNOT select the skill, so a hit
 * proves the trigger channel carried it and nothing else did. That is what
 * makes triggers worth having — a capture contract ("the human corrected a
 * fact") must fire whether or not the connector's tools survived progressive
 * disclosure, and the model is the party least likely to notice it should
 * activate the skill from the catalog itself.
 *
 * Every assertion here reads a real `runtime.chat()` turn: the matched name off
 * `ChatResult`, the mechanism off the persisted `skills.loaded` event, and the
 * body off the prompt the model actually received.
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

/** Reverse-DNS slug, like a real fleet connector — never the skill's own name. */
const SERVER_NAME = "ai-nimblebrain-capture-mcp";
const BUNDLE_SKILL_NAME = `bundle:${SERVER_NAME}:capture`;
const TOOL_NAME = `${SERVER_NAME}__record`;

/** Declared on the server skill. Distinctive enough that nothing else matches it. */
const CAPTURE_TRIGGER = "that is wrong";
/** Claimed by BOTH the server skill and a workspace-tier skill, to pin pool order. */
const CONTESTED_TRIGGER = "onboard a new client";

const CAPTURE_BODY_MARKER = "Record the correction before answering.";

const SKILL_MD = `---
name: capture
description: Capture corrections the human makes to stored facts.
metadata:
  nimblebrain:
    loading-strategy: dynamic
    priority: 40
    triggers:
      - "${CAPTURE_TRIGGER}"
      - "${CONTESTED_TRIGGER}"
---

# Capture

${CAPTURE_BODY_MARKER}`;

/** A second published skill that declares NO triggers — the negative control. */
const QUIET_SKILL_MD = `---
name: quiet
description: Guidance with no trigger phrases.
---

# Quiet

Nothing here should ever trigger-match.`;

const WS_SKILL_NAME = "workspace-onboarding";

function createFixtureServer(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const nodeModulesPath = join(import.meta.dir, "../..", "node_modules");
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

const BODIES = {
  "skill://capture/SKILL.md": ${JSON.stringify(SKILL_MD)},
  "skill://quiet/SKILL.md": ${JSON.stringify(QUIET_SKILL_MD)},
};

async function main() {
  const server = new Server(
    { name: "capture", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: "record", description: "Record a fact", inputSchema: { type: "object", properties: {} } },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: "text", text: "recorded" }],
  }));

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      { uri: "skill://capture/SKILL.md", name: "capture", mimeType: "text/markdown" },
      { uri: "skill://quiet/SKILL.md", name: "quiet", mimeType: "text/markdown" },
    ],
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

// Captures the prompt the model receives, so the test can assert on the
// assembled system prompt — no event carries the composed text.
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

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** The `skills.loaded` entries persisted for a conversation's latest turn. */
async function loadedSkills(
  conversationId: string,
): Promise<Array<{ id: string; loadedBy: string; reason: string; layer: number }>> {
  const store = await runtime.resolveConversationStore(conversationId);
  const events = await store!.readEvents(conversationId);
  const skillsLoaded = events.find((e) => e.type === "skills.loaded");
  expect(skillsLoaded).toBeDefined();
  return (
    skillsLoaded as unknown as {
      skills: Array<{ id: string; loadedBy: string; reason: string; layer: number }>;
    }
  ).skills;
}

const testDir = join(tmpdir(), `nimblebrain-bundle-skill-triggers-${Date.now()}`);
let runtime: Runtime;
let captureSource: McpSource;

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

  // A workspace-tier skill claiming the CONTESTED trigger. `match()` returns the
  // first hit and exactly one skill per message, so pool order decides who wins.
  const wsSkillsDir = join(testDir, "workspaces", TEST_WORKSPACE_ID, "skills");
  mkdirSync(wsSkillsDir, { recursive: true });
  writeFileSync(
    join(wsSkillsDir, `${WS_SKILL_NAME}.md`),
    `---
name: ${WS_SKILL_NAME}
description: The team's own onboarding rules.
metadata:
  nimblebrain:
    loading-strategy: dynamic
    priority: 30
    triggers:
      - "${CONTESTED_TRIGGER}"
---

Workspace onboarding rules.
`,
  );

  const serverDir = createFixtureServer(join(testDir, "capture-server"));
  captureSource = new McpSource(
    SERVER_NAME,
    {
      type: "stdio",
      spawn: {
        command: "node",
        args: [join(serverDir, "server.cjs")],
        env: process.env as Record<string, string>,
      },
    },
    new NoopEventSink(),
  );
  await captureSource.start();
  runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID).addSource(captureSource);
});

afterAll(async () => {
  try {
    await captureSource.stop();
  } catch {
    // already stopped
  }
  await runtime.shutdown();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

describe("server-published skill triggers", () => {
  it("fires on a declared phrase with NONE of the server's tools active", async () => {
    // `allowedTools: []` removes every route except the trigger: with no
    // `ai-nimblebrain-capture-mcp__*` tool in the active set, tool-affinity
    // cannot select this skill. A hit is the trigger channel or nothing.
    lastPrompt = undefined;
    const chat = await runtime.chat({
      workspaceId: TEST_WORKSPACE_ID,
      message: `Actually ${CAPTURE_TRIGGER} — we stopped doing that last year.`,
      allowedTools: [],
    });

    expect(chat.skillName).toBe(BUNDLE_SKILL_NAME);

    const entry = loadedFor(await loadedSkills(chat.conversationId), "skill://capture/SKILL.md");
    expect(entry?.loadedBy).toBe("trigger");
    expect(entry?.reason).toBe(`trigger matched "${CAPTURE_TRIGGER}"`);
    expect(entry?.layer).toBe(4);

    // The point of firing is that the guidance reaches the model.
    const prompt = lastPromptText();
    expect(prompt).toContain("<skill-instructions>");
    expect(prompt).toContain(CAPTURE_BODY_MARKER);
  });

  it("does not fire on a message naming no declared phrase", async () => {
    const chat = await runtime.chat({
      workspaceId: TEST_WORKSPACE_ID,
      message: "just a plain unrelated greeting",
      allowedTools: [],
    });
    expect(chat.skillName).toBeNull();
  });

  it("never fires a published skill that declares no triggers", async () => {
    // `quiet` is discovered and synthesized from the same server; it just has no
    // phrases. Nothing about being server-published should make it matchable.
    const chat = await runtime.chat({
      workspaceId: TEST_WORKSPACE_ID,
      message: "Nothing here should ever trigger-match, quiet skill.",
      allowedTools: [],
    });
    expect(chat.skillName).toBeNull();
  });

  it("lets a workspace-authored skill win a phrase a connector also claims", async () => {
    // `match()` returns the FIRST hit, one skill per message. Adding published
    // skills to the pool makes workspace/connector collisions possible, so the
    // order is load-bearing: the conversation pool goes first, and the tenant's
    // own authoring beats a vendor's.
    const chat = await runtime.chat({
      workspaceId: TEST_WORKSPACE_ID,
      message: `Help me ${CONTESTED_TRIGGER} today.`,
      allowedTools: [],
    });
    expect(chat.skillName).toBe(WS_SKILL_NAME);
  });

  it("composes the skill ONCE when both tool-affinity and a trigger reach it", async () => {
    // With the server's tool active, tool-affinity selects the skill into
    // <layer3-skill> AND the phrase matches. Synthesis stamps
    // `toolAffinity: ["<server>__*"]` on every published skill, so this overlap
    // is the ordinary case, not a corner. The body must not be paid for twice.
    lastPrompt = undefined;
    const chat = await runtime.chat({
      workspaceId: TEST_WORKSPACE_ID,
      message: `Hold on, ${CAPTURE_TRIGGER}.`,
      allowedTools: [TOOL_NAME],
    });

    // The match still happened — it is what narrows the direct tool set.
    expect(chat.skillName).toBe(BUNDLE_SKILL_NAME);

    const prompt = lastPromptText();
    expect(countOccurrences(prompt, CAPTURE_BODY_MARKER)).toBe(1);
    // Layer 3 is the surviving channel, matching the load ledger's precedence.
    expect(prompt).not.toContain("<skill-instructions>");

    const entry = loadedFor(await loadedSkills(chat.conversationId), "skill://capture/SKILL.md");
    expect(entry?.loadedBy).toBe("tool_affinity");
  });
});

/** Find the ledger entry for a skill id. */
function loadedFor(
  skills: Array<{ id: string; loadedBy: string; reason: string; layer: number }>,
  id: string,
): { id: string; loadedBy: string; reason: string; layer: number } | undefined {
  return skills.find((s) => s.id === id);
}
