import type { LanguageModelV3 } from "@ai-sdk/provider";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractText } from "../../src/engine/content-helpers.ts";
import { runWithRequestContext } from "../../src/runtime/request-context.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createMockModel } from "../helpers/mock-model.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

/**
 * Connector-skill binding lifecycle (P4), through the real Runtime — hermetic
 * (resolver fetch injected, no network):
 *   install (syncBoundSkills) → materialized + loaded as a candidate +
 *   surfaced by list_bound_skills + ABSENT from skills__list →
 *   uninstall (removeBoundSkills) → gone.
 *
 * The surface-once-into-history chat behavior is proven at the engine+store
 * level in `connector-skill-binding.test.ts`; this test covers the lifecycle +
 * runtime wiring.
 */

const testDir = join(tmpdir(), `nimblebrain-connector-skill-lifecycle-${Date.now()}`);
afterAll(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

const OVERLAY = `---
name: gmail-usage
description: Gmail connector guidance
metadata:
  nimblebrain:
    loading-strategy: dynamic
    priority: 40
---

Confirm the recipient before calling gmail__send.
`;

const GMAIL_URL =
  "https://raw.githubusercontent.com/NimbleBrainInc/connector-skills/v0.1.0/composio/gmail/SKILL.md";

function fixtureModel(): LanguageModelV3 {
  return createMockModel(() => ({ content: [{ type: "text", text: "ok" }] }));
}

function fixtureFetch(): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = typeof url === "string" ? url : url.toString();
    return u === GMAIL_URL
      ? new Response(OVERLAY, { status: 200 })
      : new Response("", { status: 404 });
  }) as unknown as typeof fetch;
}

async function callTool(
  runtime: Runtime,
  toolName: string,
  input: Record<string, unknown>,
): Promise<{ content: string; isError: boolean }> {
  const registry = runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID);
  const result = await runWithRequestContext(
    {
      identity: null,
      scope: {
        kind: "workspace",
        workspaceId: TEST_WORKSPACE_ID,
        workspaceAgents: null,
        workspaceModelOverride: null,
      },
    },
    () => registry.execute({ id: `t-${Date.now()}`, name: toolName, input }),
  );
  return { content: extractText(result.content), isError: result.isError ?? false };
}

let savedEnabled: string | undefined;
beforeEach(() => {
  savedEnabled = process.env.CONNECTOR_SKILLS_ENABLED;
  process.env.CONNECTOR_SKILLS_ENABLED = "true";
});
afterEach(() => {
  if (savedEnabled === undefined) delete process.env.CONNECTOR_SKILLS_ENABLED;
  else process.env.CONNECTOR_SKILLS_ENABLED = savedEnabled;
});

describe("connector-skill binding lifecycle (runtime wiring)", () => {
  it("binds at install, loads as a candidate, lists, hides from skills__list, removes on uninstall", async () => {
    const workDir = join(testDir, "bind-cycle");
    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: fixtureModel() },
      noDefaultBundles: true,
      workDir,
      logging: { disabled: true },
      telemetry: { enabled: false },
    });
    await provisionTestWorkspace(runtime);

    const lifecycle = runtime.getLifecycle();
    lifecycle.setConnectorSkillFetch(fixtureFetch());

    // --- Install: bind the curated overlay for a Composio gmail connector. ---
    const lock = await lifecycle.syncBoundSkills(
      "composio/gmail",
      "gmail",
      TEST_WORKSPACE_ID,
      runtime.getWorkDir(),
    );
    expect(lock).toHaveLength(1);
    expect(lock[0]!.identity).toBe("composio/gmail");

    // Loaded into the engine candidate pool with the right tool-affinity.
    const candidates = runtime.loadConnectorSkillCandidates(TEST_WORKSPACE_ID);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.name).toBe("gmail-usage");
    expect(candidates[0]!.scope).toBe("connector");
    expect(candidates[0]!.toolAffinity).toEqual(["gmail__*"]);

    // Surfaced by list_bound_skills with provenance.
    const overlays = runtime.listConnectorOverlays(TEST_WORKSPACE_ID);
    expect(overlays).toHaveLength(1);
    expect(overlays[0]!.server).toBe("gmail");
    expect(overlays[0]!.source).toBe("connector:composio/gmail@v0.1.0");

    // Absent from the authored-skill listing — a separate store, filtered out.
    const list = await callTool(runtime, "skills__list", {});
    expect(list.isError).toBe(false);
    expect(list.content).not.toContain("gmail-usage");

    // --- Uninstall: removeBoundSkills cleans up. ---
    lifecycle.removeBoundSkills("gmail", TEST_WORKSPACE_ID, runtime.getWorkDir());
    expect(runtime.loadConnectorSkillCandidates(TEST_WORKSPACE_ID)).toEqual([]);
    expect(runtime.listConnectorOverlays(TEST_WORKSPACE_ID)).toEqual([]);

    await runtime.shutdown();
  });
});
