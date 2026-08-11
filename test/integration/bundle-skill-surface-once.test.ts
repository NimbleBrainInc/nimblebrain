/**
 * A published skill the turn already composed is not re-delivered by the
 * surface-once channel.
 *
 * `connectorSkillCandidates` carries the workspace's `dynamic` published skills so
 * one can reach the model when its tools are promoted MID-turn — after Layer 3 has
 * already selected. The channel only makes sense for skills Layer 3 could not
 * select. A skill it did select is in `<layer3-skill>` for the turn, so delivering
 * it again as a synthetic message pays for the same body twice and leaves it in
 * history for the rest of the conversation.
 *
 * That was the behavior, and it was the ordinary case rather than a corner:
 * `selectLayer3Skills` matches the very `<server>__*` glob synthesis stamps on every
 * published skill, so both channels select on identical criteria. Because the glob
 * is per-SERVER, one tool call re-delivered every skill that server published — not
 * only the one whose tool was called.
 *
 * The model here is SCRIPTED, not the echo model: it emits a real tool call on the
 * first pass. That is the whole point. The surface-once hook fires from inside tool
 * execution, so a model that never calls a tool cannot reach this path, which is how
 * the duplication survived the existing bundle-skill suite.
 */

import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";
import { createMockModel } from "../helpers/mock-model.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";

/** Reverse-DNS slug, like a fleet connector — never the skills' own names. */
const SERVER = "ai-nimblebrain-surface-mcp";
const CALLED_TOOL = `${SERVER}__doit`;

/** Two skills on ONE server, so the per-server glob's blast radius is visible. */
const MARKER_A = "SURFACE-SKILL-A-MARKER";
const MARKER_B = "SURFACE-SKILL-B-MARKER";

function skillMd(name: string, marker: string): string {
  return `---\nname: ${name}\ndescription: Guidance ${name}.\n---\n\n# ${name}\n\n${marker}`;
}

function createFixtureServer(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const nm = join(import.meta.dir, "../..", "node_modules");
  writeFileSync(
    join(dir, "server.cjs"),
    `
const { Server } = require("${nm}/@modelcontextprotocol/sdk/dist/cjs/server/index.js");
const { StdioServerTransport } = require("${nm}/@modelcontextprotocol/sdk/dist/cjs/server/stdio.js");
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} = require("${nm}/@modelcontextprotocol/sdk/dist/cjs/types.js");

const BODIES = {
  "skill://alpha/SKILL.md": ${JSON.stringify(skillMd("alpha", MARKER_A))},
  "skill://beta/SKILL.md": ${JSON.stringify(skillMd("beta", MARKER_B))},
};

async function main() {
  const server = new Server(
    { name: "surface", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: "doit", description: "Do it", inputSchema: { type: "object", properties: {} } },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: "text", text: "done" }],
  }));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      { uri: "skill://alpha/SKILL.md", name: "alpha", mimeType: "text/markdown" },
      { uri: "skill://beta/SKILL.md", name: "beta", mimeType: "text/markdown" },
    ],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (r) => {
    const text = BODIES[r.params.uri];
    if (!text) throw new Error("Resource not found: " + r.params.uri);
    return { contents: [{ uri: r.params.uri, mimeType: "text/markdown", text }] };
  });
  await server.connect(new StdioServerTransport());
}
main();
`,
  );
  return dir;
}

/** Every prompt the model was called with this turn, in order. */
let prompts: LanguageModelV3CallOptions["prompt"][] = [];
let modelCalls = 0;

function promptText(p: LanguageModelV3CallOptions["prompt"]): string {
  return p
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : m.content.map((c) => ("text" in c ? c.text : "")).join(" "),
    )
    .join("\n");
}

/** Most occurrences of `marker` seen in any single prompt this turn. */
function peakOccurrences(marker: string): number {
  return Math.max(0, ...prompts.map((p) => promptText(p).split(marker).length - 1));
}

const testDir = join(tmpdir(), `nimblebrain-bundle-surface-once-${Date.now()}`);
let runtime: Runtime;
let source: McpSource;

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });

  runtime = await Runtime.start({
    model: {
      provider: "custom",
      adapter: createMockModel((options) => {
        prompts.push(options.prompt);
        modelCalls += 1;
        // First pass calls the server's tool — that is what fires the surface-once
        // hook. Everything after answers, so the run terminates.
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
    },
    noDefaultBundles: true,
    logging: { disabled: true },
    workDir: testDir,
    telemetry: { enabled: false },
  });
  await provisionTestWorkspace(runtime);

  source = new McpSource(
    SERVER,
    {
      type: "stdio",
      spawn: {
        command: "node",
        args: [join(createFixtureServer(join(testDir, "server")), "server.cjs")],
        env: process.env as Record<string, string>,
      },
    },
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
  await runtime.shutdown();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

describe("published skills and the surface-once channel", () => {
  it("does not re-deliver a skill Layer 3 already composed, on any pass of the turn", async () => {
    prompts = [];
    modelCalls = 0;
    // The server's tool is direct, so Layer 3 selects BOTH published skills at
    // turn start (one `<server>__*` glob covers the pair).
    await runtime.chat({
      workspaceId: TEST_WORKSPACE_ID,
      message: "do the thing",
      allowedTools: [CALLED_TOOL],
    });

    // Sanity: the turn genuinely exercised the path. Without a real tool call the
    // surface-once hook never runs and this test proves nothing.
    expect(modelCalls).toBeGreaterThan(1);
    expect(promptText(prompts[0] ?? [])).toContain("<layer3-skill>");

    // The called tool's own skill: composed once, and still once after the call.
    expect(peakOccurrences(MARKER_A)).toBe(1);
    // Its neighbour on the same server: the affinity glob is per-SERVER, so this
    // is the one that used to double without any tool of its own being called.
    expect(peakOccurrences(MARKER_B)).toBe(1);
  });

  it("still delivers a skill Layer 3 could NOT select, when its tool is promoted", async () => {
    prompts = [];
    modelCalls = 0;
    // `allowedTools` excludes the server's tool, so it is not in the active set at
    // turn start and Layer 3 selects neither skill — the exact case the channel
    // exists for. The model promotes and calls it mid-turn.
    const chat = await runtime.chat({
      workspaceId: TEST_WORKSPACE_ID,
      message: "promote and call it",
      allowedTools: ["nb__*"],
    });

    expect(modelCalls).toBeGreaterThan(1);

    // The delivery must come from a call that RAN, not merely one that was
    // attempted. `injectConnectorSkillOverlays` fires just after the `tool.start`
    // emit and before input coercion/validation, so a call that fails validation
    // injects the body too — and this case would then pass while proving nothing
    // about the promotion path. Read the persisted `tool.done` instead of
    // inferring execution from the injection it precedes.
    const store = await runtime.resolveConversationStore(chat.conversationId);
    const events = await store!.readEvents(chat.conversationId);
    const done = events.find(
      (e) => e.type === "tool.done" && (e as { name?: string }).name === CALLED_TOOL,
    ) as { ok?: boolean } | undefined;
    expect(done?.ok).toBe(true);

    // Not composed at turn start...
    expect(promptText(prompts[0] ?? [])).not.toContain(MARKER_A);
    // ...but delivered once the tool ran. Subtracting the Layer-3 selection must
    // not empty the channel it is narrowing.
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
      workspaceId: TEST_WORKSPACE_ID,
      prompt: "do the thing",
      allowedTools: [CALLED_TOOL],
    });

    expect(modelCalls).toBeGreaterThan(1);
    expect(promptText(prompts[0] ?? [])).toContain("<layer3-skill>");
    expect(peakOccurrences(MARKER_A)).toBe(1);
    expect(peakOccurrences(MARKER_B)).toBe(1);
  });
});
