/**
 * Muting a skill steers ONE conversation and edits nothing.
 *
 * `skills__deactivate` used to write `status: disabled` into the skill's file.
 * That file is read by every conversation the user has, in every workspace, so
 * one chat's "not right now" silently reconfigured all the others — an operator
 * disabled a skill in one campaign and found it back on in another, because a
 * third conversation had flipped it. Nothing told them.
 *
 * The first test here is the whole point: deactivate in A, compose in B, assert
 * B is unchanged. The rest pin that the mute survives a resume of its own
 * conversation, that a new conversation starts clean, and that the durable file
 * is untouched.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { extractText } from "../../src/engine/content-helpers.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { runWithRequestContext } from "../../src/runtime/request-context.ts";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";
import { createMockModel } from "../helpers/mock-model.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";

const SKILL_NAME = "house-voice";
const BUNDLE_SERVER = "ai-nimblebrain-guide-mcp";
const BUNDLE_SKILL = `bundle:${BUNDLE_SERVER}:guide`;
const BUNDLE_MARKER = "BUNDLE-MARKER-XRAY";
const MARKER = "VOICE-MARKER-WHISKEY";
const CONNECTOR_SERVER = "gmail";
const CONNECTOR_SKILL = "gmail-threading";

function createGuideBundle(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const nm = join(import.meta.dir, "../..", "node_modules");
  const body = `---\nname: guide\ndescription: Bundle guidance.\nmetadata:\n  nimblebrain:\n    loading-strategy: always\n---\n\n# guide\n\n${BUNDLE_MARKER} — always applies.`;
  writeFileSync(
    join(dir, "server.cjs"),
    `
const { Server } = require("${nm}/@modelcontextprotocol/sdk/dist/cjs/server/index.js");
const { StdioServerTransport } = require("${nm}/@modelcontextprotocol/sdk/dist/cjs/server/stdio.js");
const { ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } =
  require("${nm}/@modelcontextprotocol/sdk/dist/cjs/types.js");
async function main() {
  const server = new Server({ name: "guide", version: "0.1.0" }, { capabilities: { tools: {}, resources: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "go", description: "Go", inputSchema: { type: "object", properties: {} } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "ok" }] }));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ uri: "skill://guide/SKILL.md", name: "guide", mimeType: "text/markdown" }],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => ({
    contents: [{ uri: req.params.uri, mimeType: "text/markdown", text: ${JSON.stringify(body)} }],
  }));
  await server.connect(new StdioServerTransport());
}
main();
`,
  );
  return dir;
}

const testDir = join(tmpdir(), `nimblebrain-skill-mute-${Date.now()}`);
let runtime: Runtime;
let lastPrompt: LanguageModelV3CallOptions["prompt"] | undefined;
let skillPath = "";

/**
 * Model that captures the composed prompt, and — when the user message names a
 * tool — issues that tool call. Driving the mute through a real engine run is
 * required, not incidental: the handler returns a `_meta` marker and the ENGINE
 * turns it into the conversation event. A registry call made outside a run
 * would never persist anything.
 */
function capturingModel(): LanguageModelV3 {
  return createMockModel((options) => {
    const system = options.prompt.find((m) => m.role === "system");
    const isTitle =
      typeof system?.content === "string" && system.content.includes("Generate a 3-6 word title");
    if (!isTitle) lastPrompt = options.prompt;

    const text = options.prompt
      .filter((m) => m.role === "user")
      .map((m) =>
        typeof m.content === "string"
          ? m.content
          : m.content.map((p) => ("text" in p ? p.text : "")).join(" "),
      )
      .join("\n");
    const last = text.split("\n").pop() ?? "";

    if (!isTitle && pendingCall && last.includes(pendingCall.trigger)) {
      const call = pendingCall;
      pendingCall = null;
      return {
        content: [
          {
            type: "tool-call" as const,
            toolCallId: `tc-${Math.random().toString(36).slice(2)}`,
            toolName: call.tool,
            input: JSON.stringify({ id: pendingName ?? SKILL_NAME }),
          },
        ],
        finishReason: "tool-calls" as const,
        inputTokens: 10,
        outputTokens: 5,
      };
    }
    return { content: [{ type: "text" as const, text: "ok" }], inputTokens: 10, outputTokens: 5 };
  });
}

/** Set before a chat turn to make the model issue that tool call on it. */
let pendingCall: { trigger: string; tool: string } | null = null;
/** Skill name for that call; defaults to the filesystem fixture. */
let pendingName: string | null = null;

function promptText(): string {
  if (!lastPrompt) return "";
  return lastPrompt
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : m.content.map((p) => ("text" in p ? p.text : "")).join(" "),
    )
    .join("\n");
}

async function callTool(name: string, input: Record<string, unknown>) {
  const registry = runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID);
  const result = await runWithRequestContext(
    { identity: null, workspaceId: TEST_WORKSPACE_ID },
    () => registry.execute({ id: `t-${Math.random()}`, name, input }),
  );
  return { content: extractText(result.content), isError: result.isError ?? false };
}

/** Drive a mute/un-mute the way the agent does: a tool call inside a run. */
async function muteViaAgent(
  tool: "skills__deactivate" | "skills__activate",
  conversationId?: string,
): Promise<string> {
  pendingCall = { trigger: "PLEASE-TOGGLE", tool };
  const id = await chat("PLEASE-TOGGLE", conversationId);
  pendingCall = null;
  return id;
}

/** Send a turn, returning the conversation id. */
async function chat(message: string, conversationId?: string): Promise<string> {
  const res = await runtime.chat({
    workspaceId: TEST_WORKSPACE_ID,
    message,
    ...(conversationId ? { conversationId } : {}),
  });
  return res.conversationId;
}

beforeAll(async () => {
  runtime = await Runtime.start({
    model: { provider: "custom", adapter: capturingModel() },
    noDefaultBundles: true,
    logging: { disabled: true },
    workDir: testDir,
    telemetry: { enabled: false },
  });
  await provisionTestWorkspace(runtime);

  const created = await callTool("skills__create", {
    scope: "workspace",
    manifest: { name: SKILL_NAME, description: "House voice", loadingStrategy: "always" },
    body: `${MARKER} — always speak in the house voice.`,
  });
  expect(created.isError).toBe(false);
  const guide = new McpSource(
    BUNDLE_SERVER,
    {
      type: "stdio",
      spawn: {
        command: "node",
        args: [join(createGuideBundle(join(testDir, "guide")), "server.cjs")],
        env: process.env as Record<string, string>,
      },
    },
    new NoopEventSink(),
  );
  await guide.start();
  runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID).addSource(guide);

  // A materialized connector overlay — the third pool the mute filters. Written
  // straight to the workspace's `connector-skills/` store, which is what
  // `loadConnectorSkillCandidates` reads (per turn, so no restart needed).
  const overlayDir = join(
    runtime.getWorkspaceContext(TEST_WORKSPACE_ID).getDataPath("connector-skills"),
    CONNECTOR_SERVER,
  );
  mkdirSync(overlayDir, { recursive: true });
  writeFileSync(
    join(overlayDir, `${CONNECTOR_SKILL}.md`),
    `---\nname: ${CONNECTOR_SKILL}\ndescription: How this connector threads replies.\n---\n\nThread replies by references header.`,
  );

  const listed = await callTool("skills__list", {});
  const m = /(\/\S*house-voice\.md)/.exec(listed.content);
  skillPath = m?.[1] ?? "";
});

afterAll(async () => {
  await runtime.shutdown();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

describe("muting a skill is conversation-scoped", () => {
  it("composes the skill in a fresh conversation (baseline)", async () => {
    await chat("hello");
    expect(promptText()).toContain(MARKER);
  });

  it("deactivating in conversation A leaves conversation B untouched", async () => {
    const convA = await chat("first turn in A");
    await muteViaAgent("skills__deactivate", convA);

    // A is muted from the next turn.
    await chat("second turn in A", convA);
    expect(promptText()).not.toContain(MARKER);

    // B — a different conversation — still gets it. This is the regression.
    const convB = await chat("first turn in B");
    expect(promptText()).toContain(MARKER);
    expect(convB).not.toBe(convA);
  });

  it("the mute survives a resume of its own conversation", async () => {
    const conv = await chat("turn one");
    await muteViaAgent("skills__deactivate", conv);
    await chat("turn two", conv);
    expect(promptText()).not.toContain(MARKER);
    // Resume again later in the same conversation.
    await chat("turn three", conv);
    expect(promptText()).not.toContain(MARKER);
  });

  it("activate un-mutes the same conversation", async () => {
    const conv = await chat("start");
    await muteViaAgent("skills__deactivate", conv);
    await chat("now muted", conv);
    expect(promptText()).not.toContain(MARKER);

    await muteViaAgent("skills__activate", conv);
    await chat("now restored", conv);
    expect(promptText()).toContain(MARKER);
  });

  it("writes nothing to the skill file — the durable status is untouched", async () => {
    const conv = await chat("a turn");
    const before = readFileSync(skillPath, "utf-8");
    await muteViaAgent("skills__deactivate", conv);
    expect(readFileSync(skillPath, "utf-8")).toBe(before);
    expect(before).toContain("status: active");
  });

  it("refuses a mute with no conversation in scope", async () => {
    // The marker only becomes an event inside a run, so out-of-band the call
    // would report success having changed nothing.
    const res = await callTool("skills__deactivate", { id: SKILL_NAME });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("only works inside a chat");
  });

  it("rejects an unknown name instead of silently muting nothing", async () => {
    // Reached only from inside a run — the no-conversation guard runs first,
    // so an out-of-band call never gets as far as the name lookup.
    const conv = await chat("a turn");
    pendingCall = { trigger: "PLEASE-TOGGLE", tool: "skills__deactivate" };
    pendingName = "no-such-skill";
    await chat("PLEASE-TOGGLE", conv);
    pendingCall = null;
    pendingName = null;

    // The skill is untouched, and the failure named the reason.
    await chat("after", conv);
    expect(promptText()).toContain(MARKER);
    const events = await (await runtime.resolveConversationStore(conv))?.readEvents(conv);
    const errored = events?.find(
      (e) => e.type === "tool.done" && e.name === "skills__deactivate" && e.ok === false,
    );
    expect(errored).toBeDefined();
    expect(JSON.stringify(errored)).toContain("Unknown skill");
  });
});

describe("muting reaches every channel a skill can compose through", () => {
  it("mutes a bundle-published `always` skill, not just filesystem ones", async () => {
    // The tool validates names against the activatable union, which includes
    // bundle-published guidance — so the model learns these names from the
    // Skill Catalog and can name one here. If the mute only covers the
    // filesystem tiers, this reports success and the skill composes anyway:
    // the silent no-op the handler's own guard exists to refuse.
    const conv = await chat("first turn");
    expect(promptText()).toContain(BUNDLE_MARKER);

    pendingCall = { trigger: "PLEASE-TOGGLE", tool: "skills__deactivate" };
    pendingName = BUNDLE_SKILL;
    await chat("PLEASE-TOGGLE", conv);
    pendingCall = null;
    pendingName = null;

    await chat("next turn", conv);
    expect(promptText()).not.toContain(BUNDLE_MARKER);
  });

  it("mutes a connector overlay — it leaves the catalog the model reads", async () => {
    // Connector overlays never compose into the system prompt; they ride the
    // conversation history via the engine's surface-once hook. The catalog is
    // where the model learns the name, and it is built from the same filtered
    // list handed to `EngineConfig.connectorSkillCandidates` — so the catalog
    // is the prompt-visible witness that the filter ran.
    const conv = await chat("first turn");
    expect(promptText()).toContain(CONNECTOR_SKILL);
    pendingCall = { trigger: "PLEASE-TOGGLE", tool: "skills__deactivate" };
    pendingName = CONNECTOR_SKILL;
    await chat("PLEASE-TOGGLE", conv);
    pendingCall = null;
    pendingName = null;

    await chat("next turn", conv);
    expect(promptText()).not.toContain(CONNECTOR_SKILL);

    // The effective-context trace must agree. It builds its own Skill Catalog,
    // so filtering the pool there does not cover it — a trace that lists what
    // the prompt dropped is the divergence the tool exists to expose.
    // DEV_IDENTITY: the owner `runtime.chat` mints with no identity configured,
    // and the trace's event read is ownership-gated.
    const trace = await runWithRequestContext(
      { identity: DEV_IDENTITY, workspaceId: TEST_WORKSPACE_ID, conversationId: conv },
      () =>
        runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID).execute({
          id: "t-trace",
          name: "compose__effective_context",
          input: { conversation_id: conv },
        }),
    );
    // The composed prompt is in `structuredContent.text`; `content` is a short
    // summary. Assert the trace SUCCEEDED and that it really carries a catalog,
    // so neither an error nor an empty render can pass this for the wrong reason.
    const traced = (trace.structuredContent ?? {}) as { text?: string };
    expect(trace.isError ?? false).toBe(false);
    expect(traced.text).toContain("Skill Catalog");
    expect(traced.text).not.toContain(CONNECTOR_SKILL);

    // Still there for everyone else — the mute is conversation state.
    await chat("a fresh conversation");
    expect(promptText()).toContain(CONNECTOR_SKILL);
  });

  it("the status surface reports the mute, so it agrees with the prompt", async () => {
    // `describeRequestSkills` backs `nb__status scope:skills`. It exists to stop
    // the status surface and the prompt diverging; a muted skill still listed as
    // loaded is exactly that divergence.
    const conv = await chat("a turn");
    const named = async () =>
      (
        await runWithRequestContext(
          { identity: null, workspaceId: TEST_WORKSPACE_ID, conversationId: conv },
          () => runtime.describeRequestSkills(TEST_WORKSPACE_ID),
        )
      ).context.map((sk) => sk.manifest.name);

    expect(await named()).toContain(SKILL_NAME);
    await muteViaAgent("skills__deactivate", conv);
    expect(await named()).not.toContain(SKILL_NAME);

    // And the prompt agrees — the whole point of the reporter.
    await chat("after", conv);
    expect(promptText()).not.toContain(MARKER);
  });

  it("the effective-context trace reports the mute too", async () => {
    // `compose__effective_context` claims to replicate what `chat` composes.
    // A trace still carrying a muted skill's body is the same divergence the
    // status surface exists to close, one tool over. Runs under DEV_IDENTITY:
    // that is the owner `runtime.chat` mints with no identity configured, and
    // the trace's event read is ownership-gated.
    const conv = await chat("a turn");
    const trace = async () => {
      const registry = runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID);
      const res = await runWithRequestContext(
        { identity: DEV_IDENTITY, workspaceId: TEST_WORKSPACE_ID, conversationId: conv },
        () =>
          registry.execute({
            id: `c-${Math.random()}`,
            name: "compose__effective_context",
            input: { conversation_id: conv },
          }),
      );
      // The body lives in the structured trace; `content` is a one-line digest.
      return (res as { structuredContent?: { text?: string } }).structuredContent?.text ?? "";
    };

    expect(await trace()).toContain(MARKER);
    await muteViaAgent("skills__deactivate", conv);
    expect(await trace()).not.toContain(MARKER);
  });
});
