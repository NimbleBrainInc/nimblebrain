/**
 * A published skill reaches the model once, before the first call to a tool it
 * is bound to, whether or not the tool was direct at turn start.
 *
 * `connectorSkillCandidates` carries the workspace's `dynamic` published skills;
 * the engine holds the first call to a bound tool and delivers them (ADR-0053).
 * Synthesis stamps a per-SERVER `<server>__*` glob on every published skill, so
 * one call to one tool delivers every skill that server published. Each must
 * arrive exactly once, and none may sit in the system prompt at turn start.
 *
 * The model here is SCRIPTED, not the echo model: it emits a real tool call on the
 * first pass. That is the whole point. The hold fires from inside tool execution,
 * so a model that never calls a tool cannot reach this path.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { Server } from "@modelcontextprotocol/server";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createMockModel } from "../helpers/mock-model.ts";
import { type RemoteMcpFixture, startRemoteMcpServer } from "../helpers/remote-mcp-fixture.ts";
import { SKILLS_EXTENSION_CAPABILITY, serveSkills } from "../helpers/skills-server.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

/** Reverse-DNS slug, like a fleet connector — never the skills' own names. */
const SERVER = "ai-nimblebrain-surface-mcp";
const CALLED_TOOL = `${SERVER}__doit`;

/** Two skills on ONE server, so the per-server glob's blast radius is visible. */
const MARKER_A = "SURFACE-SKILL-A-MARKER";
const MARKER_B = "SURFACE-SKILL-B-MARKER";

function skillMd(name: string, marker: string): string {
  return `---\nname: ${name}\ndescription: Guidance ${name}.\n---\n\n# ${name}\n\n${marker}`;
}

function createFixtureServer(): Server {
  const bodies: Record<string, string> = {
    "skill://alpha/SKILL.md": skillMd("alpha", MARKER_A),
    "skill://beta/SKILL.md": skillMd("beta", MARKER_B),
  };

  const server = new Server(
    { name: "surface", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {}, ...SKILLS_EXTENSION_CAPABILITY } },
  );
  server.setRequestHandler("tools/list", async () => ({
    tools: [
      { name: "doit", description: "Do it", inputSchema: { type: "object", properties: {} } },
    ],
  }));
  server.setRequestHandler("tools/call", async () => ({
    content: [{ type: "text", text: "done" }],
  }));
  server.setRequestHandler("resources/list", async () => ({
    resources: [
      { uri: "skill://alpha/SKILL.md", name: "alpha", mimeType: "text/markdown" },
      { uri: "skill://beta/SKILL.md", name: "beta", mimeType: "text/markdown" },
    ],
  }));
  serveSkills(server, () => bodies);
  server.setRequestHandler("resources/read", async (r) => {
    const text = bodies[r.params.uri];
    if (!text) throw new Error(`Resource not found: ${r.params.uri}`);
    return { contents: [{ uri: r.params.uri, mimeType: "text/markdown", text }] };
  });
  return server;
}

/** Every prompt the model was called with this turn, in order. */
let prompts: LanguageModelV4CallOptions["prompt"][] = [];
let modelCalls = 0;

function promptText(p: LanguageModelV4CallOptions["prompt"]): string {
  return p
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : m.content
            .map((c) =>
              "text" in c
                ? c.text
                : c.type === "tool-result" && "value" in c.output
                  ? String(c.output.value)
                  : "",
            )
            .join(" "),
    )
    .join("\n");
}

/** Most occurrences of `marker` seen in any single prompt this turn. */
function peakOccurrences(marker: string): number {
  return Math.max(0, ...prompts.map((p) => promptText(p).split(marker).length - 1));
}

const testDir = join(tmpdir(), `nimblebrain-connector-surface-once-${Date.now()}`);
let runtime: Runtime;
let source: McpSource;
let server: RemoteMcpFixture;

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });

  runtime = await Runtime.start({
    identityProvider: devProvider,
    languageModel: createMockModel((options) => {
      prompts.push(options.prompt);
      modelCalls += 1;
      // First pass calls the server's tool — that is what fires the surface-once
      // hook. A held call is re-issued once, as a model does on reading the
      // guidance that follows it in its result. Everything after answers, so the run ends.
      const last = options.prompt.findLast((m) => m.role === "tool");
      const heldLast =
        last?.role === "tool" &&
        last.content.some(
          (p) =>
            p.type === "tool-result" &&
            "value" in p.output &&
            String(p.output.value).startsWith("Not run:"),
        );
      if (heldLast) {
        return {
          content: [
            { type: "tool-call", toolCallId: "call-2", toolName: CALLED_TOOL, input: "{}" },
          ],
          finishReason: "tool-calls",
        };
      }
      if (modelCalls === 1) {
        return {
          content: [
            { type: "tool-call", toolCallId: "call-1", toolName: CALLED_TOOL, input: "{}" },
          ],
          finishReason: "tool-calls",
        };
      }
      return { content: [{ type: "text", text: "ok" }] };
    }),
    logging: { disabled: true },
    workDir: testDir,
    telemetry: { enabled: false },
  });
  await provisionTestWorkspace(runtime);

  server = startRemoteMcpServer(createFixtureServer);
  source = new McpSource(
    SERVER,
    { type: "remote", url: new URL(server.url), allowInsecure: true },
    new NoopEventSink(),
  );
  await source.start();
  runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID).addSource(source);
});

afterAll(async () => {
  try {
    await source.stop();
  } catch {
    // already stopped
  }
  server.close();
  await runtime.shutdown();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

describe("published skills and the surface-once channel", () => {
  it("holds a direct tool's first call and delivers its bound skills once", async () => {
    prompts = [];
    modelCalls = 0;
    // The server's tool is direct from turn start. Its skills still wait for
    // its first call: the prompt carries no bound skill body.
    await runtime.chat({
      identity: DEV_IDENTITY,
      workspaceId: TEST_WORKSPACE_ID,
      message: "do the thing",
      allowedTools: [CALLED_TOOL],
    });

    // Sanity: the turn genuinely exercised the path. Without a real tool call the
    // hold never runs and this test proves nothing.
    expect(modelCalls).toBeGreaterThan(1);
    expect(promptText(prompts[0] ?? [])).not.toContain("<layer3-skill>");
    expect(promptText(prompts[0] ?? [])).not.toContain(MARKER_A);

    // The called tool's own skill: delivered once.
    expect(peakOccurrences(MARKER_A)).toBe(1);
    // Its neighbour on the same server: the affinity glob is per-SERVER, so this
    // is the one that could double without any tool of its own being called.
    expect(peakOccurrences(MARKER_B)).toBe(1);
  });

  it("delivers a promoted tool's skill before its first call runs", async () => {
    prompts = [];
    modelCalls = 0;
    // `allowedTools` excludes the server's tool, so it is not in the active set at
    // turn start. The model promotes and calls it mid-turn.
    const chat = await runtime.chat({
      identity: DEV_IDENTITY,
      workspaceId: TEST_WORKSPACE_ID,
      message: "promote and call it",
      allowedTools: ["nb__*"],
    });

    expect(modelCalls).toBeGreaterThan(1);

    // The first call is held, not run, and the re-issue after the guidance runs.
    // Read the persisted `tool.done`s rather than inferring either from the
    // injection between them.
    const store = await runtime.resolveConversationStore(chat.conversationId);
    const events = await store!.readEvents(chat.conversationId);
    const dones = events.filter(
      (e) => e.type === "tool.done" && (e as { name?: string }).name === CALLED_TOOL,
    ) as Array<{ ok?: boolean; held?: true }>;
    expect(dones.map((d) => ({ ok: d.ok, held: d.held === true }))).toEqual([
      { ok: false, held: true },
      { ok: true, held: false },
    ]);

    // Not composed at turn start...
    expect(promptText(prompts[0] ?? [])).not.toContain(MARKER_A);
    // ...but delivered before the call that ran, once.
    expect(peakOccurrences(MARKER_A)).toBe(1);
    // The per-server glob reaches the neighbour here too: `beta` has no tool of
    // its own, and one call to `doit` delivers it. Exactly once, same as `alpha`.
    expect(peakOccurrences(MARKER_B)).toBe(1);
  });

  // `executeTask` composes its own prompt and builds its own engine config, so it
  // carries a second copy of the candidate wiring rather than sharing chat's. The
  // duplication is a known deferred follow-up in runtime.ts; while it stands, an
  // exclusion applied to one call site and not the other is a live way for the two
  // to diverge, and a task run is where nobody is watching the token bill.
  it("holds on the task path too, which wires the channel separately", async () => {
    prompts = [];
    modelCalls = 0;
    await runtime.executeTask({
      identity: DEV_IDENTITY,
      workspaceId: TEST_WORKSPACE_ID,
      prompt: "do the thing",
      allowedTools: [CALLED_TOOL],
    });

    expect(modelCalls).toBeGreaterThan(1);
    expect(promptText(prompts[0] ?? [])).not.toContain(MARKER_A);
    expect(peakOccurrences(MARKER_A)).toBe(1);
    expect(peakOccurrences(MARKER_B)).toBe(1);
  });
});
