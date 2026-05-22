/**
 * End-to-end integration test for the Phase 2 read tools.
 *
 * Boots a real Runtime, creates a workspace, drops a Layer 3 skill into the
 * workspace skills dir, runs a turn (which triggers Layer 3 selection +
 * `skills.loaded` emission), and exercises all four read tools through the
 * runtime's tool registry.
 *
 * No mocks of the conversation store or runtime — only the model is stubbed
 * (via `createMockModel`) so the test stays fast and offline.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractText } from "../../src/engine/content-helpers.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { runWithRequestContext } from "../../src/runtime/request-context.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { ensureUserWorkspace } from "../../src/workspace/provisioning.ts";
import { personalWorkspaceIdFor } from "../../src/workspace/workspace-store.ts";
import { createMockModel } from "../helpers/mock-model.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";

const testDir = join(tmpdir(), `nimblebrain-skills-read-${Date.now()}`);

afterAll(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

async function callTool(
  runtime: Runtime,
  toolName: string,
  input: Record<string, unknown>,
  wsId: string,
): Promise<{ content: string; isError: boolean; structured?: unknown }> {
  const registry = runtime.getRegistryForWorkspace(wsId);
  const result = await runWithRequestContext(
    {
      // Match the dev-fallback ownerId minted by `runtime.chat()`
      // when no identity is passed. Stage 1's per-conversation
      // ownership gate on skills__active_for / loading_log requires
      // a real identity in the request context.
      identity: DEV_IDENTITY,
      workspaceId: wsId,
      workspaceAgents: null,
      workspaceModelOverride: null,
    },
    () =>
      registry.execute({
        id: `test-${Date.now()}-${Math.random()}`,
        name: toolName,
        input,
      }),
  );
  return {
    content: extractText(result.content),
    isError: result.isError ?? false,
    structured: result.structuredContent,
  };
}

describe("skills read tools — end-to-end", () => {
  it("list / read / active_for / loading_log all report a workspace skill loaded by always", async () => {
    const workDir = join(testDir, "e2e");
    mkdirSync(workDir, { recursive: true });

    // Stage 2 (T006): the chat surface is identity-bound; the "session
    // workspace" the skill loader reads from is the identity's personal
    // workspace, NOT a `workspaceId` on the request. We pre-stage the
    // skill in the personal workspace's dir so the skill is loaded the
    // same way it would be in production after T006.
    const personalWsId = personalWorkspaceIdFor(DEV_IDENTITY.id);
    const wsSkillsDir = join(workDir, "workspaces", personalWsId, "skills");
    mkdirSync(wsSkillsDir, { recursive: true });
    const skillPath = join(wsSkillsDir, "voice.md");
    writeFileSync(
      skillPath,
      [
        "---",
        'name: voice-rules',
        'description: Voice rules',
        'version: "1.0.0"',
        "type: context",
        "priority: 25",
        "loading-strategy: always",
        "---",
        "",
        "Speak plainly. Avoid filler.",
        "",
      ].join("\n"),
    );

    const model = createMockModel(() => ({
      content: [{ type: "text", text: "ok" }],
      inputTokens: 10,
      outputTokens: 5,
    }));

    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: model },
      noDefaultBundles: true,
      workDir,
      logging: { disabled: true },
      telemetry: { enabled: false },
    });
    await provisionTestWorkspace(runtime);

    // Stage 2 (T006): the chat surface is identity-bound. The session
    // workspace from which skills are loaded is the identity's personal
    // workspace — that's where we pre-staged `voice.md` above. Ensure
    // the personal workspace exists and its registry is initialized
    // before we run any read tools against it (the chat call below
    // does this auto-provision via `ensureUserWorkspace`, but the test
    // also exercises tools directly on the registry — so be explicit
    // here too).
    await ensureUserWorkspace(runtime.getWorkspaceStore(), {
      id: DEV_IDENTITY.id,
      displayName: DEV_IDENTITY.displayName,
    });
    await runtime.ensureWorkspaceRegistry(personalWsId);

    try {
      // Run a turn — this triggers Layer 3 selection and emits skills.loaded /
      // context.assembled into the conversation jsonl.
      const chat = await runtime.chat({ message: "hi" });
      const convId = chat.conversationId;

      // skills__list — sees the workspace skill (and the Layer 1 vendored guide).
      const list = await callTool(runtime, "skills__list", {}, personalWsId);
      expect(list.isError).toBe(false);
      const listed = (list.structured as { skills?: unknown[] }).skills as Array<{
        name: string;
        layer: number;
        scope: string;
      }>;
      const names = listed.map((s) => s.name).sort();
      expect(names).toContain("voice-rules");
      expect(names).toContain("authoring-guide");
      const ws = listed.find((s) => s.name === "voice-rules")!;
      expect(ws.scope).toBe("workspace");
      expect(ws.layer).toBe(3);

      // skills__read — using the id surfaced by list.
      const target = listed.find((s) => s.name === "voice-rules") as { id: string };
      const read = await callTool(runtime, "skills__read", { id: target.id }, personalWsId);
      expect(read.isError).toBe(false);
      const readSC = read.structured as {
        content: string;
        scope: string;
        metadata: { name: string; loadingStrategy: string };
      };
      expect(readSC.scope).toBe("workspace");
      expect(readSC.metadata.name).toBe("voice-rules");
      expect(readSC.metadata.loadingStrategy).toBe("always");
      expect(readSC.content).toContain("Speak plainly");

      // skills__active_for — the most recent skills.loaded for the conv must
      // include voice-rules (loading_strategy: always).
      const active = await callTool(
        runtime,
        "skills__active_for",
        { conversation_id: convId },
        personalWsId,
      );
      expect(active.isError).toBe(false);
      const activeList = (active.structured as { active?: unknown[] }).active as Array<{
        id: string;
        loadedBy: string;
        scope: string;
      }>;
      const activeIds = activeList.map((s) => s.id);
      expect(activeIds.some((id) => id.endsWith("voice.md"))).toBe(true);
      const voiceLoaded = activeList.find((s) => s.id.endsWith("voice.md"))!;
      expect(voiceLoaded.loadedBy).toBe("always");
      expect(voiceLoaded.scope).toBe("workspace");

      // skills__loading_log — at least one entry for this conversation.
      const log = await callTool(
        runtime,
        "skills__loading_log",
        { conversation_id: convId },
        personalWsId,
      );
      expect(log.isError).toBe(false);
      const events = (log.structured as { events?: unknown[] }).events as Array<{
        run_id: string;
        loaded: Array<{ id: string }>;
      }>;
      expect(events.length).toBeGreaterThanOrEqual(1);
      const lastLoaded = events[events.length - 1]!;
      expect(lastLoaded.loaded.some((s) => s.id.endsWith("voice.md"))).toBe(true);
    } finally {
      await runtime.shutdown();
    }
  });
});
