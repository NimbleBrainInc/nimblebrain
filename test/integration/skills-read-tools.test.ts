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
import { devProvider } from "../helpers/dev-provider.ts";
import { createMockModel } from "../helpers/mock-model.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

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
      // ownership gate on skills__loading_log requires
      // a real identity in the request context.
      identity: DEV_IDENTITY,
      workspaceId: wsId,
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
  it("list / read / loading_log all report a workspace skill loaded by always", async () => {
    const workDir = join(testDir, "e2e");
    mkdirSync(workDir, { recursive: true });

    // The skill loader reads from the workspace the turn runs in. We pre-stage
    // the skill in that workspace's dir so it loads the way it would in
    // production.
    const wsId = TEST_WORKSPACE_ID;
    const wsSkillsDir = join(workDir, "workspaces", wsId, "skills");
    mkdirSync(wsSkillsDir, { recursive: true });
    const skillPath = join(wsSkillsDir, "voice.md");
    writeFileSync(
      skillPath,
      [
        "---",
        "name: voice-rules",
        "description: Voice rules",
        // dynamic + tool-affinity (nb__* is always surfaced) → loads into Layer 3
        // (skills.loaded / loading_log), where this test asserts.
        "metadata:",
        "  nimblebrain:",
        "    loading-strategy: dynamic",
        "    priority: 25",
        "    tool-affinity:",
        '      - "nb__*"',
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
      identityProvider: devProvider,
      model: { provider: "custom", adapter: model },
      workDir,
      logging: { disabled: true },
      telemetry: { enabled: false },
    });
    // Creates the workspace (with the dev user as admin) and its registry.
    await provisionTestWorkspace(runtime, wsId);

    try {
      // Run a turn — this triggers Layer 3 selection and emits skills.loaded /
      // context.assembled into the conversation jsonl.
      const chat = await runtime.chat({ identity: DEV_IDENTITY, message: "hi", workspaceId: wsId });
      const convId = chat.conversationId;

      // skills__list — sees the workspace skill (and the Layer 1 vendored guide).
      const list = await callTool(runtime, "skills__list", {}, wsId);
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
      const read = await callTool(runtime, "skills__read", { id: target.id }, wsId);
      expect(read.isError).toBe(false);
      const readSC = read.structured as {
        content: string;
        scope: string;
        metadata: { name: string; loadingStrategy: string };
      };
      expect(readSC.scope).toBe("workspace");
      expect(readSC.metadata.name).toBe("voice-rules");
      expect(readSC.metadata.loadingStrategy).toBe("dynamic");
      expect(readSC.content).toContain("Speak plainly");

      // Regression (skills__read body-in-content): the engine surfaces only
      // `content` to the model, never `structuredContent`. The body and the
      // promised manifest fields must reach the MODEL-visible text, or an
      // in-agent caller sees only the one-line header and cannot read the
      // skill. `read.content` here is `extractText(result.content)` — exactly
      // what the engine feeds the model.
      expect(read.content).toContain("Speak plainly");
      expect(read.content).toContain("voice-rules");
      expect(read.content).toContain("loads: tool_affinity");

      // skills__loading_log — at least one entry for this conversation.
      const log = await callTool(runtime, "skills__loading_log", { conversation_id: convId }, wsId);
      expect(log.isError).toBe(false);
      const loads = (log.structured as { loads?: unknown[] }).loads as Array<{
        run_id?: string;
        skill: string;
        skill_id?: string;
        loaded_by: string;
      }>;
      expect(loads.length).toBeGreaterThanOrEqual(1);
      const voiceRow = loads.find((r) => r.skill_id?.endsWith("voice.md"));
      expect(voiceRow).toBeDefined();
      expect(voiceRow?.loaded_by).toBe("tool_affinity");
    } finally {
      await runtime.shutdown();
    }
  });
});
