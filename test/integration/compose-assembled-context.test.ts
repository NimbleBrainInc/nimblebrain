/**
 * Integration tests for `compose__assembled_context`.
 *
 * Exercises the full path: real `Runtime.start()` + workspace + identity +
 * a real chat turn that records `context.assembled` + `skills.loaded`, then
 * reads the recorded digest back. Verifies:
 *
 *   - The latest-run digest carries the per-source token breakdown
 *     (system_prompt / tool_descriptions / skills / history) and the
 *     layer-3 skills that loaded, with provenance.
 *   - An explicit run_id selects that run.
 *   - A conversation the caller doesn't own (or that doesn't exist) errors
 *     rather than leaking events.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { EventSourcedConversationStore } from "../../src/conversation/event-sourced-store.ts";
import { extractText } from "../../src/engine/content-helpers.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { runWithRequestContext } from "../../src/runtime/request-context.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import type { ComposeAssembledContextOutput } from "../../src/tools/platform/schemas/compose.ts";
import { createMockModel } from "../helpers/mock-model.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";

const testDir = join(tmpdir(), `nimblebrain-assembled-${Date.now()}`);

afterAll(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

function makeModel(): LanguageModelV3 {
  return createMockModel(() => ({
    content: [{ type: "text", text: "ok" }],
    inputTokens: 10,
    outputTokens: 5,
  }));
}

async function getLatestRunId(runtime: Runtime, convId: string): Promise<string | null> {
  return runWithRequestContext(
    {
      identity: DEV_IDENTITY,
      scope: {
        kind: "workspace",
        workspaceId: TEST_WORKSPACE_ID,
        workspaceAgents: null,
        workspaceModelOverride: null,
      },
    },
    async () => {
      const store = await runtime.resolveConversationStore(convId);
      if (!(store instanceof EventSourcedConversationStore)) return null;
      const events = await store.readEvents(convId);
      for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i];
        if (ev?.type === "run.start") return (ev as { runId: string }).runId;
      }
      return null;
    },
  );
}

async function callAssembled(
  runtime: Runtime,
  args: Record<string, unknown>,
  ctxConvId?: string,
): Promise<{ structured: ComposeAssembledContextOutput | null; isError: boolean; text: string }> {
  const registry = runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID);
  const result = await runWithRequestContext(
    {
      identity: DEV_IDENTITY,
      scope: {
        kind: "workspace",
        workspaceId: TEST_WORKSPACE_ID,
        workspaceAgents: null,
        workspaceModelOverride: null,
      },
      ...(ctxConvId ? { conversationId: ctxConvId } : {}),
    },
    () =>
      registry.execute({
        id: `test-${Date.now()}`,
        name: "compose__assembled_context",
        input: args,
      }),
  );
  const sc = (result as { structuredContent?: unknown }).structuredContent;
  return {
    structured: sc ? (sc as ComposeAssembledContextOutput) : null,
    isError: result.isError ?? false,
    text: extractText(result.content),
  };
}

/** Start a runtime with one dynamic tool-affinity skill and run a chat that records telemetry. */
async function runtimeWithRecordedRun(
  subdir: string,
  skillBody: string,
): Promise<{ runtime: Runtime; convId: string; runId: string; skillPath: string }> {
  const workDir = join(testDir, subdir);
  const runtime = await Runtime.start({
    model: { provider: "custom", adapter: makeModel() },
    noDefaultBundles: true,
    workDir,
    logging: { disabled: true },
    telemetry: { enabled: false },
  });
  await provisionTestWorkspace(runtime);

  mkdirSync(join(workDir, "skills"), { recursive: true });
  const skillPath = join(workDir, "skills", "draft-rules.md");
  // dynamic + tool-affinity on `nb__*` so it deterministically loads into
  // Layer 3 (and thus into skills.loaded) on any turn.
  writeFileSync(
    skillPath,
    `---\nname: draft-rules\ndescription: Drafting\nmetadata:\n  nimblebrain:\n    loading-strategy: dynamic\n    priority: 30\n    tool-affinity: ['nb__*']\n---\n\n${skillBody}\n`,
  );
  await runtime.reloadSkills();

  const result = await runtime.chat({ workspaceId: TEST_WORKSPACE_ID, message: "test message" });
  const convId = result.conversationId;
  const runId = await getLatestRunId(runtime, convId);
  if (!runId) throw new Error("no runId recorded");
  return { runtime, convId, runId, skillPath };
}

describe("compose__assembled_context — latest run", () => {
  it("returns the per-source token breakdown and the loaded layer-3 skills", async () => {
    const skillBody = "Always answer in plain English.";
    const { runtime, convId, runId, skillPath } = await runtimeWithRecordedRun(
      "latest",
      skillBody,
    );

    const res = await callAssembled(runtime, {}, convId);
    expect(res.isError).toBe(false);
    const d = res.structured!;
    expect(d.conversationId).toBe(convId);
    expect(d.runId).toBe(runId);
    expect(typeof d.ts).toBe("string");

    // The four source kinds the runtime records, each with a token count.
    const byKind = new Map(d.sources.map((s) => [s.kind, s]));
    expect(byKind.has("system_prompt")).toBe(true);
    expect(byKind.get("system_prompt")!.tokens).toBeGreaterThan(0);
    expect(byKind.get("tool_descriptions")!.count).toBeGreaterThan(0);
    expect(byKind.has("skills")).toBe(true);
    const history = byKind.get("history")!;
    expect(typeof history.turns).toBe("number");
    expect(history.compacted).toBe(false);

    // totalTokens is the sum of the recorded source tokens.
    const sum = d.sources.reduce((acc, s) => acc + s.tokens, 0);
    expect(d.totalTokens).toBe(sum);

    // The planted skill shows up with provenance.
    const skill = d.skills.find((s) => s.id === skillPath);
    expect(skill).toBeDefined();
    expect(skill!.scope).toBe("org");
    expect(skill!.loadedBy).toBe("tool_affinity");
    expect(skill!.reason.length).toBeGreaterThan(0);
    expect(skill!.tokens).toBeGreaterThan(0);

    // The text summary carries the headline totals.
    expect(res.text).toContain(runId);
    expect(res.text).toContain("system_prompt");

    await runtime.shutdown();
  });

  it("selects a specific run when run_id is passed", async () => {
    const { runtime, convId, runId } = await runtimeWithRecordedRun("by-run-id", "Rules.");

    const res = await callAssembled(runtime, { run_id: runId }, convId);
    expect(res.isError).toBe(false);
    expect(res.structured!.runId).toBe(runId);

    await runtime.shutdown();
  });
});

describe("compose__assembled_context — access + resolution", () => {
  it("errors for a conversation that does not exist", async () => {
    const workDir = join(testDir, "not-found");
    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: makeModel() },
      noDefaultBundles: true,
      workDir,
      logging: { disabled: true },
      telemetry: { enabled: false },
    });
    await provisionTestWorkspace(runtime);

    const res = await callAssembled(runtime, { conversation_id: "conv_ffffffffffffffff" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("Conversation not found");

    await runtime.shutdown();
  });

  it("errors when no conversation is in scope and none is passed", async () => {
    const workDir = join(testDir, "no-conv");
    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: makeModel() },
      noDefaultBundles: true,
      workDir,
      logging: { disabled: true },
      telemetry: { enabled: false },
    });
    await provisionTestWorkspace(runtime);

    const res = await callAssembled(runtime, {});
    expect(res.isError).toBe(true);
    expect(res.text).toContain("conversation_id is required");

    await runtime.shutdown();
  });
});
