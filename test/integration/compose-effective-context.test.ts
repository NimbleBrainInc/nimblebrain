/**
 * Integration tests for `nb__compose__compose_effective_context`.
 *
 * Exercises the full path: real `Runtime.start()` + workspace + identity +
 * skill files on disk + the actual platform-tool registration. Verifies:
 *
 *   - Live mode returns the traced layers, with paths and bundle
 *     attribution as expected.
 *   - Historical mode reads `skills.loaded` events from the conv jsonl
 *     and verifies recorded `contentHash` against current source.
 *   - Bundle filter narrows layers + subItems.
 *   - The conversation_id default falls through RequestContext.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { EventSourcedConversationStore } from "../../src/conversation/event-sourced-store.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWithRequestContext } from "../../src/runtime/request-context.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { hashSkillBody } from "../../src/runtime/skills-loaded-payload.ts";
import { extractText } from "../../src/engine/content-helpers.ts";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { createMockModel } from "../helpers/mock-model.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";

const testDir = join(tmpdir(), `nimblebrain-compose-${Date.now()}`);

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

interface ComposeResponse {
  mode: "live" | "historical";
  conversationId: string;
  runId?: string;
  totalTokens: number;
  text: string;
  layers: Array<{
    kind: string;
    id: string;
    source: string;
    text: string;
    tokens: number;
    bundle?: string;
    subItems?: Array<{
      kind: string;
      id: string;
      source: string;
      bundle?: string;
      metadata?: Record<string, unknown>;
    }>;
  }>;
  warnings: string[];
}

/**
 * Extract the most recent runId from a conversation's persisted events.
 * `runtime.chat()` doesn't return the runId on `ChatResult`, so the test
 * reads it from the conv jsonl after the chat completes.
 */
async function getLatestRunId(
  runtime: Runtime,
  convId: string,
): Promise<string | null> {
  return runWithRequestContext(
    {
      identity: null,
      workspaceId: TEST_WORKSPACE_ID,
      workspaceAgents: null,
      workspaceModelOverride: null,
    },
    async () => {
      const store = runtime.findConversationStore();
      if (!(store instanceof EventSourcedConversationStore)) return null;
      const events = await store.readEvents(convId);
      for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i];
        if (ev?.type === "run.start") {
          return (ev as { runId: string }).runId;
        }
      }
      return null;
    },
  );
}

async function callCompose(
  runtime: Runtime,
  args: Record<string, unknown>,
  ctxConvId?: string,
): Promise<{ structured: ComposeResponse | null; isError: boolean; text: string }> {
  const registry = runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID);
  const result = await runWithRequestContext(
    {
      identity: null,
      workspaceId: TEST_WORKSPACE_ID,
      workspaceAgents: null,
      workspaceModelOverride: null,
      ...(ctxConvId ? { conversationId: ctxConvId } : {}),
    },
    () =>
      registry.execute({
        id: `test-${Date.now()}`,
        name: "compose__effective_context",
        input: args,
      }),
  );
  const sc = (result as { structuredContent?: unknown }).structuredContent;
  return {
    structured: sc ? (sc as ComposeResponse) : null,
    isError: result.isError ?? false,
    text: extractText(result.content),
  };
}

describe("compose_effective_context — live mode", () => {
  it("returns traced layers with paths for every operator-authored skill", async () => {
    const workDir = join(testDir, "live-basic");
    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: makeModel() },
      noDefaultBundles: true,
      workDir,
      logging: { disabled: true },
      telemetry: { enabled: false },
    });
    await provisionTestWorkspace(runtime);

    // Plant an org-tier skill the agent should see in its prompt.
    mkdirSync(join(workDir, "skills"), { recursive: true });
    const skillBody = "Always answer in plain English. Avoid em-dashes.";
    writeFileSync(
      join(workDir, "skills", "voice-rules.md"),
      `---\nname: voice-rules\ndescription: Voice\nversion: 1.0.0\ntype: context\npriority: 30\nloading_strategy: always\n---\n\n${skillBody}\n`,
    );
    await runtime.reloadSkills();

    const res = await callCompose(runtime, {}, "conv_aaaaaaaaaaaaaaaa");
    expect(res.isError).toBe(false);
    expect(res.structured).not.toBeNull();
    const r = res.structured!;
    expect(r.mode).toBe("live");
    expect(r.conversationId).toBe("conv_aaaaaaaaaaaaaaaa");
    expect(r.warnings).toEqual([]);

    // The skill body is composed into one of the layer texts, NOT necessarily
    // its own row (always-on context skills with priority > 10 are user_context_skill).
    const fullText = r.layers.map((l) => l.text).join("\n");
    expect(fullText).toContain(skillBody);

    // The user_context_skill row points at the file we wrote.
    const userCtxRow = r.layers.find(
      (l) => l.kind === "user_context_skill" && l.id.endsWith("voice-rules.md"),
    );
    expect(userCtxRow).toBeDefined();
    expect(userCtxRow!.text).toContain(skillBody);

    // totalTokens = sum of per-layer tokens (lossless trace).
    const sum = r.layers.reduce((s, l) => s + l.tokens, 0);
    expect(r.totalTokens).toBe(sum);

    // Joining layer texts reconstructs the prompt — the trace is non-lossy.
    expect(r.layers.map((l) => l.text).join("\n\n---\n\n")).toBe(r.text);

    await runtime.shutdown();
  });

  it("includes the workspace identity override as a core_skill row", async () => {
    // Regression: composeLive used to pass `runtime.getContextSkills()`
    // directly, which is the global static set. `runtime.chat()` augments
    // it per-request with `makeIdentitySkill(workspace.identity)` at
    // priority 1 (core context). Without the override, the trace would
    // report DEFAULT_IDENTITY for any workspace operating under a custom
    // identity — the exact case the tool exists to expose.
    const workDir = join(testDir, "live-workspace-identity");
    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: makeModel() },
      noDefaultBundles: true,
      workDir,
      logging: { disabled: true },
      telemetry: { enabled: false },
    });
    await provisionTestWorkspace(runtime);

    // Set the workspace identity directly on the workspace store. The
    // test helper doesn't expose this — `update` is the public API.
    const wsStore = runtime.getWorkspaceStore();
    const overrideText =
      "You are LegalBot. Be precise. Cite sources. Defer to qualified counsel.";
    await wsStore.update(TEST_WORKSPACE_ID, { identity: overrideText });

    const res = await callCompose(runtime, {}, "conv_aaaaaaaaaaaaaaaa");
    expect(res.isError).toBe(false);

    // The override has priority 1, so it lands in the `core_skill` band.
    // It's appended to the contextSkills list, so it becomes ONE OF the
    // core_skill rows (not necessarily the only one).
    const coreSkills = res.structured!.layers.filter((l) => l.kind === "core_skill");
    const overrideRow = coreSkills.find((l) => l.text === overrideText);
    expect(overrideRow).toBeDefined();

    // And DEFAULT_IDENTITY must NOT appear when an override is present —
    // the fallback only fires if there's nothing else in the core band.
    expect(res.structured!.layers.find((l) => l.kind === "default_identity")).toBeUndefined();

    await runtime.shutdown();
  });

  it("returns the workspace_context layer with the workspace id", async () => {
    const workDir = join(testDir, "live-ws");
    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: makeModel() },
      noDefaultBundles: true,
      workDir,
      logging: { disabled: true },
      telemetry: { enabled: false },
    });
    await provisionTestWorkspace(runtime);

    const res = await callCompose(runtime, {}, "conv_bbbbbbbbbbbbbbbb");
    expect(res.isError).toBe(false);
    const wsRow = res.structured!.layers.find((l) => l.kind === "workspace_context");
    expect(wsRow).toBeDefined();
    expect(wsRow!.text).toContain(TEST_WORKSPACE_ID);

    await runtime.shutdown();
  });

  it("errors when called without a conversation_id and no current conversation in scope", async () => {
    const workDir = join(testDir, "no-conv");
    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: makeModel() },
      noDefaultBundles: true,
      workDir,
      logging: { disabled: true },
      telemetry: { enabled: false },
    });
    await provisionTestWorkspace(runtime);

    // No ctxConvId; no input.conversation_id either.
    const res = await callCompose(runtime, {});
    expect(res.isError).toBe(true);
    expect(res.text).toContain("conversation_id is required");

    await runtime.shutdown();
  });
});

describe("compose_effective_context — historical mode", () => {
  it("returns layer3 skills for a recorded run with hash status 'match' when the body is unchanged", async () => {
    const workDir = join(testDir, "historical-match");
    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: makeModel() },
      noDefaultBundles: true,
      workDir,
      logging: { disabled: true },
      telemetry: { enabled: false },
    });
    await provisionTestWorkspace(runtime);

    mkdirSync(join(workDir, "skills"), { recursive: true });
    const skillBody = "Use patch_source for all revisions.";
    const skillPath = join(workDir, "skills", "collateral-rules.md");
    writeFileSync(
      skillPath,
      `---\nname: collateral-rules\ndescription: Routing\nversion: 1.0.0\ntype: context\npriority: 30\nloading_strategy: always\n---\n\n${skillBody}\n`,
    );
    await runtime.reloadSkills();

    // Run a chat to record skills.loaded with the contentHash.
    const result = await runtime.chat({
      workspaceId: TEST_WORKSPACE_ID,
      message: "test message",
    });
    const convId = result.conversationId;
    const runId = await getLatestRunId(runtime, convId);
    expect(runId).not.toBeNull();

    const res = await callCompose(runtime, { run_id: runId }, convId);
    expect(res.isError).toBe(false);
    const r = res.structured!;
    expect(r.mode).toBe("historical");
    expect(r.runId).toBe(runId);

    const l3 = r.layers.find((l) => l.kind === "layer3_skills");
    expect(l3).toBeDefined();
    const sub = l3!.subItems!.find((s) => s.id === skillPath);
    expect(sub).toBeDefined();
    expect((sub!.metadata as { hashStatus: string }).hashStatus).toBe("match");
    expect((sub!.metadata as { recordedHash: string }).recordedHash).toBe(
      hashSkillBody(skillBody),
    );

    await runtime.shutdown();
  });

  it("flags 'drift' when the skill body has been edited since the run", async () => {
    const workDir = join(testDir, "historical-drift");
    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: makeModel() },
      noDefaultBundles: true,
      workDir,
      logging: { disabled: true },
      telemetry: { enabled: false },
    });
    await provisionTestWorkspace(runtime);

    mkdirSync(join(workDir, "skills"), { recursive: true });
    const originalBody = "Original rule: use patch_source.";
    const skillPath = join(workDir, "skills", "drift-rules.md");
    writeFileSync(
      skillPath,
      `---\nname: drift-rules\ndescription: Test\nversion: 1.0.0\ntype: context\npriority: 30\nloading_strategy: always\n---\n\n${originalBody}\n`,
    );
    await runtime.reloadSkills();

    const result = await runtime.chat({
      workspaceId: TEST_WORKSPACE_ID,
      message: "test message",
    });
    const runId = await getLatestRunId(runtime, result.conversationId);
    expect(runId).not.toBeNull();

    // Edit the skill AFTER the run was recorded — mutation simulation.
    // No `_versions/` snapshot is created here (we're bypassing skills__update),
    // so the audit should report `drift` rather than `recovered`.
    const editedBody = "Edited rule: use set_source instead.";
    writeFileSync(
      skillPath,
      `---\nname: drift-rules\ndescription: Test\nversion: 1.0.0\ntype: context\npriority: 30\nloading_strategy: always\n---\n\n${editedBody}\n`,
    );
    await runtime.reloadSkills();

    const res = await callCompose(
      runtime,
      { run_id: runId },
      result.conversationId,
    );
    expect(res.isError).toBe(false);
    const sub = res
      .structured!.layers.find((l) => l.kind === "layer3_skills")!
      .subItems!.find((s) => s.id === skillPath);
    expect((sub!.metadata as { hashStatus: string }).hashStatus).toBe("drift");
    // The warnings list mentions the affected path.
    expect(res.structured!.warnings.some((w) => w.includes(skillPath))).toBe(true);

    await runtime.shutdown();
  });

  it("recovers the loaded body from a _versions/ snapshot when the live file has drifted", async () => {
    // The headline value of historical mode: "I edited a skill — what was
    // it before?" If a `_versions/<basename>.<ts>.md` snapshot's body
    // hashes to the recorded contentHash, the audit returns the snapshot
    // body verbatim with hashStatus="recovered".
    const workDir = join(testDir, "historical-recovered");
    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: makeModel() },
      noDefaultBundles: true,
      workDir,
      logging: { disabled: true },
      telemetry: { enabled: false },
    });
    await provisionTestWorkspace(runtime);

    mkdirSync(join(workDir, "skills"), { recursive: true });
    const originalBody = "Recoverable rule: vintage instruction.";
    const skillPath = join(workDir, "skills", "recoverable.md");
    const frontmatter =
      "---\nname: recoverable\ndescription: Test\nversion: 1.0.0\ntype: context\npriority: 30\nloading_strategy: always\n---\n";
    writeFileSync(skillPath, `${frontmatter}\n${originalBody}\n`);
    await runtime.reloadSkills();

    // Run a chat — records `skills.loaded` with the original body's hash.
    const result = await runtime.chat({
      workspaceId: TEST_WORKSPACE_ID,
      message: "test",
    });
    const runId = await getLatestRunId(runtime, result.conversationId);
    expect(runId).not.toBeNull();

    // Plant a `_versions/` snapshot whose body hashes to the recorded value.
    // The naming convention is `<basename>.<utc-iso>.md` — see
    // `src/skills/writer.ts::snapshotVersion`. The audit walks the dir
    // newest-first and matches by hash, so any timestamp suffix works.
    const versionsDir = join(workDir, "skills", "_versions");
    mkdirSync(versionsDir, { recursive: true });
    const snapshotPath = join(versionsDir, "recoverable.2026-04-28T12-00-00.000Z.md");
    writeFileSync(snapshotPath, `${frontmatter}\n${originalBody}\n`);

    // Now drift the live file. The snapshot still holds the original body.
    const editedBody = "Edited rule: brand new instruction.";
    writeFileSync(skillPath, `${frontmatter}\n${editedBody}\n`);

    const res = await callCompose(runtime, { run_id: runId }, result.conversationId);
    expect(res.isError).toBe(false);
    const sub = res
      .structured!.layers.find((l) => l.kind === "layer3_skills")!
      .subItems!.find((s) => s.id === skillPath);
    expect(sub).toBeDefined();
    const meta = sub!.metadata as { hashStatus: string; snapshotPath?: string };
    expect(meta.hashStatus).toBe("recovered");
    expect(meta.snapshotPath).toBe(snapshotPath);

    // The warning list mentions both the live path and the snapshot path
    // so a reader knows where the recovered body came from.
    expect(
      res.structured!.warnings.some((w) => w.includes(skillPath) && w.includes(snapshotPath)),
    ).toBe(true);

    await runtime.shutdown();
  });
});

describe("compose_effective_context — bundle filter", () => {
  it("narrows layers and subItems to the filtered bundle", async () => {
    const workDir = join(testDir, "bundle-filter");
    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: makeModel() },
      noDefaultBundles: true,
      workDir,
      logging: { disabled: true },
      telemetry: { enabled: false },
    });
    await provisionTestWorkspace(runtime);

    // Plant two skills under bundle-affined directories so the bundle
    // attribution heuristic kicks in.
    const collateralDir = join(workDir, "skills", "bundles", "synapse-collateral");
    const crmDir = join(workDir, "skills", "bundles", "synapse-crm");
    mkdirSync(collateralDir, { recursive: true });
    mkdirSync(crmDir, { recursive: true });
    writeFileSync(
      join(collateralDir, "rules.md"),
      `---\nname: collateral-rules\ndescription: CR\nversion: 1.0.0\ntype: context\npriority: 30\nloading_strategy: always\n---\n\nCollateral content.\n`,
    );
    writeFileSync(
      join(crmDir, "rules.md"),
      `---\nname: crm-rules\ndescription: CR\nversion: 1.0.0\ntype: context\npriority: 30\nloading_strategy: always\n---\n\nCRM content.\n`,
    );
    await runtime.reloadSkills();

    // Both planted skills appear in the unfiltered L3 section. Other L3
    // skills (e.g. the bundled authoring-guide if its tool-affinity matches
    // the platform's own tools) may also be present — the test asserts our
    // two skills made it in, not exact count.
    const unfiltered = await callCompose(runtime, {}, "conv_cccccccccccccccc");
    const l3Section = unfiltered.structured!.layers.find((l) => l.kind === "layer3_skills");
    expect(l3Section).toBeDefined();
    const unfilteredBundles = (l3Section!.subItems ?? [])
      .map((s) => s.bundle)
      .filter((b): b is string => b !== undefined);
    expect(unfilteredBundles).toContain("synapse-collateral");
    expect(unfilteredBundles).toContain("synapse-crm");

    // With bundle=synapse-collateral, only the collateral skill survives.
    // Non-bundle subItems get dropped (their `bundle` is undefined, not
    // matching the filter), so the section's subItems should be exactly
    // [{bundle: "synapse-collateral", ...}] — anything else would be a
    // bug in the filter.
    const filtered = await callCompose(
      runtime,
      { bundle: "synapse-collateral" },
      "conv_cccccccccccccccc",
    );
    expect(filtered.isError).toBe(false);
    const l3Filtered = filtered.structured!.layers.find((l) => l.kind === "layer3_skills");
    expect(l3Filtered).toBeDefined();
    expect(l3Filtered!.subItems!.length).toBe(1);
    expect(l3Filtered!.subItems![0]!.bundle).toBe("synapse-collateral");

    await runtime.shutdown();
  });
});

describe("compose_effective_context — conversation_id resolution", () => {
  it("falls back to RequestContext.conversationId when input omits the id", async () => {
    const workDir = join(testDir, "ctx-fallback");
    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: makeModel() },
      noDefaultBundles: true,
      workDir,
      logging: { disabled: true },
      telemetry: { enabled: false },
    });
    await provisionTestWorkspace(runtime);

    const res = await callCompose(runtime, {}, "conv_dddddddddddddddd");
    expect(res.isError).toBe(false);
    expect(res.structured!.conversationId).toBe("conv_dddddddddddddddd");

    await runtime.shutdown();
  });

  it("explicit conversation_id wins over RequestContext", async () => {
    const workDir = join(testDir, "explicit-wins");
    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: makeModel() },
      noDefaultBundles: true,
      workDir,
      logging: { disabled: true },
      telemetry: { enabled: false },
    });
    await provisionTestWorkspace(runtime);

    const res = await callCompose(
      runtime,
      { conversation_id: "conv_eeeeeeeeeeeeeeee" },
      "conv_dddddddddddddddd",
    );
    expect(res.isError).toBe(false);
    expect(res.structured!.conversationId).toBe("conv_eeeeeeeeeeeeeeee");

    await runtime.shutdown();
  });
});
