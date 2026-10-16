/**
 * The compose app's tools driven through its MCP source, so each success
 * result passes the SDK client's check against the tool's output schema.
 *
 * Both tools read a conversation's recorded events, which keep the shape they
 * were written in. The fixtures hold what a stored log can: a skill recorded
 * under a tier name this build no longer uses, a run with no recorded
 * `modelMaxContext`, and a conversation with no telemetry yet.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../../../src/adapters/noop-events.ts";
import type { EventSourcedConversationStore } from "../../../../src/conversation/event-sourced-store.ts";
import type { Conversation, ConversationEvent } from "../../../../src/conversation/types.ts";
import type { ToolResult, ToolSchema } from "../../../../src/engine/types.ts";
import { ADMIT_ALL } from "../../../../src/permissions/admin-tools.ts";
import { createComposeSource } from "../../../../src/platform/compose/source.ts";
import type {
  ComposeAssembledContextOutput,
  ComposeEffectiveContextOutput,
} from "../../../../src/platform/schemas/compose.ts";
import type { PromptAppInfo } from "../../../../src/prompt/compose.ts";
import { runWithRequestContext } from "../../../../src/runtime/request-context.ts";
import type { Runtime } from "../../../../src/runtime/runtime.ts";
import { hashSkillBody } from "../../../../src/runtime/skills-loaded-payload.ts";
import type { Skill } from "../../../../src/skills/types.ts";
import type { McpSource } from "../../../../src/tools/mcp-source.ts";
import type { ToolRegistry } from "../../../../src/tools/registry.ts";
import type { WorkspaceStore } from "../../../../src/workspace/workspace-store.ts";
import { makeIdentity } from "../../../helpers/identity.ts";
import { stub } from "../../../helpers/stub.ts";
import { resultText, structuredOutput } from "../../../helpers/tool-result.ts";

const WS_ID = "ws_00859aff6f095b0e";
const CONV_ID = "conv_0123456789abcdef";
const EMPTY_CONV_ID = "conv_fedcba9876543210";
const RUN_ID = "run_recorded";
const SKILL_BODY = "Draft in short sentences.";

let workDir: string;
let skillPath: string;
let source: McpSource;

function recordedEvents(): ConversationEvent[] {
  return [
    {
      ts: "2026-09-01T00:00:00.000Z",
      type: "skills.loaded",
      runId: RUN_ID,
      totalTokens: 12,
      skills: [
        {
          id: skillPath,
          name: "draft-rules",
          layer: 3,
          scope: "workspace",
          version: "1.0.0",
          tokens: 7,
          contentHash: hashSkillBody(SKILL_BODY),
          loadedBy: "tool_affinity",
          reason: "tool-affinity matched nb__*",
        },
        {
          id: "skill://acme-mcp/usage/SKILL.md",
          name: "usage",
          connector: "acme-mcp",
          layer: 0,
          // A tier name a run recorded before the vocabulary moved on. The
          // record keeps it, and the reader passes it through.
          // biome-ignore lint/plugin/double-cast: a stored event holds a tier outside today's union
          scope: "bundle" as unknown as "provided",
          version: "1.0.0",
          tokens: 5,
          contentHash: "0".repeat(64),
          loadedBy: "always",
          reason: "always-on",
        },
      ],
    },
    {
      ts: "2026-09-01T00:00:00.001Z",
      type: "context.assembled",
      runId: RUN_ID,
      sources: [
        { kind: "system_prompt", tokens: 400 },
        { kind: "tool_descriptions", tokens: 300, count: 4 },
        { kind: "skills", tokens: 12, count: 2 },
        { kind: "history", tokens: 50, messages: 3, compacted: false },
      ],
      excluded: [],
      totalTokens: 762,
    },
  ];
}

/** What the workspace holds in live mode: none by default, or one app with a skill that loads for it. */
interface LiveWorkspace {
  apps: PromptAppInfo[];
  skills: Skill[];
  tools: ToolSchema[];
}

const EMPTY_WORKSPACE: LiveWorkspace = { apps: [], skills: [], tools: [] };

function makeRuntime(live: LiveWorkspace = EMPTY_WORKSPACE): Runtime {
  const store = stub<EventSourcedConversationStore>({
    load: async (id: string) => stub<Conversation>({ id }),
    readEvents: async (id: string) => (id === CONV_ID ? recordedEvents() : []),
  });
  return stub<Runtime>({
    getCurrentIdentity: () => makeIdentity({ id: "usr_test" }),
    requireWorkspaceId: () => WS_ID,
    resolveConversationStore: async () => store,
    getWorkspaceStore: () => stub<WorkspaceStore>({ get: async () => null }),
    loadConversationSkills: () => live.skills,
    loadConnectorSkillCandidates: () => [],
    buildAppsList: async () => live.apps,
    getRegistryForWorkspace: () => stub<ToolRegistry>({ availableTools: async () => live.tools }),
    connectorAdmission: async () => ADMIT_ALL,
  });
}

function exec(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
  return runWithRequestContext({ identity: null, workspaceId: WS_ID }, () =>
    source.execute(tool, args),
  );
}

/** A success's typed payload; a failure throws with its text, which names a schema mismatch. */
function succeeded<T extends object>(result: ToolResult): T {
  if (result.isError) throw new Error(resultText(result));
  return structuredOutput<T>(result);
}

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), "nb-compose-test-"));
  skillPath = join(workDir, "draft-rules.md");
  writeFileSync(skillPath, `---\nname: draft-rules\ndescription: Drafting\n---\n\n${SKILL_BODY}\n`);
  source = createComposeSource(makeRuntime(), new NoopEventSink());
  await source.start();
  // List first, as the engine does: the SDK client validates a result against
  // its tool's output schema only once it holds the `tools/list` that declares it.
  await source.tools();
});

afterEach(async () => {
  await source.stop();
  rmSync(workDir, { recursive: true, force: true });
});

describe("compose__assembled_context", () => {
  test("projects the recorded run, keeping a tier name the union no longer lists", async () => {
    const result = await exec("assembled_context", { conversation_id: CONV_ID });
    const digest = succeeded<ComposeAssembledContextOutput>(result);
    expect(digest.runId).toBe(RUN_ID);
    expect(digest.windowTokens).toBe(750);
    expect(digest.sources.find((s) => s.kind === "skills")?.annotation).toBe(true);
    expect(digest.skills.map((s) => s.scope)).toEqual(["workspace", "bundle"]);
    expect(digest.modelMaxContext).toBeUndefined();
    expect(resultText(result)).toContain("750 tok in the window");
  });

  test("returns the empty digest for a conversation with no recorded run", async () => {
    const result = await exec("assembled_context", { conversation_id: EMPTY_CONV_ID });
    const digest = succeeded<ComposeAssembledContextOutput>(result);
    expect(digest.runId).toBeNull();
    expect(digest.ts).toBeNull();
    expect(digest.skills).toEqual([]);
  });
});

describe("compose__effective_context", () => {
  test("live mode returns the composed layers", async () => {
    const result = await exec("effective_context", { conversation_id: CONV_ID });
    const composed = succeeded<ComposeEffectiveContextOutput>(result);
    expect(composed.mode).toBe("live");
    expect(composed.layers.length).toBeGreaterThan(0);
    expect(composed.text.length).toBeGreaterThan(0);
    expect(composed.runId).toBeUndefined();
  });

  test("live mode returns an installed app and a tool-affinity skill as sub-items", async () => {
    await source.stop();
    source = createComposeSource(
      makeRuntime({
        apps: [{ name: "acme", description: "Acme CRM", ui: null }],
        tools: [
          {
            name: "acme__find",
            description: "Find a record.",
            inputSchema: { type: "object", properties: {} },
          },
        ],
        skills: [
          {
            manifest: {
              name: "acme-rules",
              description: "How to use Acme",
              loadingStrategy: "dynamic",
              priority: 60,
              status: "active",
              scope: "workspace",
              toolAffinity: ["acme__*"],
            },
            body: "Search before you create.",
            sourcePath: skillPath,
          },
        ],
      }),
      new NoopEventSink(),
    );
    await source.start();
    await source.tools();

    const result = await exec("effective_context", { conversation_id: CONV_ID });
    const composed = succeeded<ComposeEffectiveContextOutput>(result);
    const subItems = composed.layers.flatMap((l) => l.subItems ?? []);
    expect(subItems.map((s) => s.kind).sort()).toEqual(["app", "layer3_skill"]);
  });

  test("historical mode returns the recorded skills layer with its sub-items", async () => {
    const result = await exec("effective_context", { conversation_id: CONV_ID, run_id: RUN_ID });
    const composed = succeeded<ComposeEffectiveContextOutput>(result);
    expect(composed.mode).toBe("historical");
    expect(composed.runId).toBe(RUN_ID);
    expect(composed.totalTokens).toBe(400);
    const [layer] = composed.layers;
    expect(layer?.subItems?.map((s) => s.metadata?.hashStatus)).toEqual(["match", "missing"]);
  });

  test("historical mode keeps a connector's recorded skills under its filter", async () => {
    const result = await exec("effective_context", {
      conversation_id: CONV_ID,
      run_id: RUN_ID,
      connector: "acme-mcp",
    });
    const composed = succeeded<ComposeEffectiveContextOutput>(result);
    expect(composed.layers.map((l) => l.kind)).toEqual(["layer3_skills"]);
    const subItems = composed.layers[0]?.subItems ?? [];
    expect(subItems.map((s) => [s.id, s.connector])).toEqual([
      ["skill://acme-mcp/usage/SKILL.md", "acme-mcp"],
    ]);
  });

  test("a connector filter that matches nothing still returns a result the schema accepts", async () => {
    const result = await exec("effective_context", {
      conversation_id: CONV_ID,
      run_id: RUN_ID,
      connector: "no-such-connector",
    });
    const composed = succeeded<ComposeEffectiveContextOutput>(result);
    expect(composed.layers).toEqual([]);
    expect(composed.totalTokens).toBe(0);
  });
});
