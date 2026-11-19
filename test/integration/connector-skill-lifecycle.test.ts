import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { extractText, textContent } from "../../src/engine/content-helpers.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { runWithRequestContext } from "../../src/runtime/request-context.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { makeInProcessSource } from "../helpers/in-process-source.ts";
import { createMockModel } from "../helpers/mock-model.ts";
import { buildCatalog, TEST_CATALOG_URL } from "../helpers/plugin-catalog.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

/**
 * Connector-skill binding lifecycle, through the real Runtime — hermetic (a
 * fixture plugin catalog served by an injected fetch, no network):
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
  delete process.env.NB_PLUGIN_CATALOG_URL;
  delete process.env.NB_PLUGIN_CATALOG_SHA256;
});

const OVERLAY = `---
name: gmail-usage
description: Gmail connector guidance
metadata:
  nimblebrain:
    loading-strategy: dynamic
    priority: 40
    server: gmail
---

Confirm the recipient before calling gmail__send.
`;

function fixtureModel(): LanguageModelV4 {
  return createMockModel(() => ({ content: [{ type: "text", text: "ok" }] }));
}

/**
 * A catalog whose `gmail` plugin binds OVERLAY to `com.google/gmail`, and whose
 * `mytool` plugin binds it to `com.test/mytool`; the runtime is pinned to it.
 */
function fixtureFetch(): typeof fetch {
  const catalog = buildCatalog([
    { name: "gmail", servers: { gmail: "com.google/gmail" }, skills: { "gmail-usage": OVERLAY } },
    {
      name: "mytool",
      servers: { gmail: "com.test/mytool" },
      skills: { "gmail-usage": OVERLAY },
    },
  ]);
  process.env.NB_PLUGIN_CATALOG_URL = TEST_CATALOG_URL;
  process.env.NB_PLUGIN_CATALOG_SHA256 = catalog.pin;
  return catalog.fetch;
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
      workspaceId: TEST_WORKSPACE_ID,
    },
    () => registry.execute({ id: `t-${Date.now()}`, name: toolName, input }),
  );
  return { content: extractText(result.content), isError: result.isError ?? false };
}

describe("connector-skill binding lifecycle (runtime wiring)", () => {
  it("binds at install, loads as a candidate, lists, hides from skills__list, removes on uninstall", async () => {
    const workDir = join(testDir, "bind-cycle");
    const runtime = await Runtime.start({
      identityProvider: devProvider,
      languageModel: fixtureModel(),
      workDir,
      logging: { disabled: true },
      telemetry: { enabled: false },
    });
    await provisionTestWorkspace(runtime);

    const lifecycle = runtime.getLifecycle();
    lifecycle.setConnectorSkillFetch(fixtureFetch());

    // --- Install: bind the catalog skill for a Composio gmail connector. ---
    const lock = await lifecycle.syncBoundSkills(
      "com.google/gmail",
      "gmail",
      TEST_WORKSPACE_ID,
      runtime.getWorkDir(),
    );
    expect(lock).toHaveLength(1);
    expect(lock[0]!.plugin).toBe("gmail@nimblebrain");

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
    expect(overlays[0]!.source).toBe("plugin:gmail@nimblebrain:gmail-usage");

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

  it("surfaces a bound overlay exactly once across turns on the real chat path", async () => {
    // Regression: cross-run dedup keys on the synthetic message's `metadata`
    // marker, but `rehydrateUserResources` strips metadata from non-user
    // messages before the engine sees them — so the engine's history scan
    // alone re-injected every turn. The runtime now computes the
    // already-injected set from the UN-rehydrated history and passes it via
    // `alreadyInjectedConnectorSkills`. This drives TWO real `runtime.chat`
    // turns (each calling a matching connector tool) and asserts the
    // `connector.skill.injected` event fired exactly once — it fired twice
    // before the fix.
    const workDir = join(testDir, "dedup-chat");

    // Stateful tool-calling model: at each turn's first step it calls the
    // registered `mytool` tool (found by name in the active set, so it works
    // whether the active name is bare or `ws_<id>-`-namespaced); after the
    // tool result it answers with text.
    let counter = 0;
    const model = createMockModel((opts) => {
      const last = opts.prompt[opts.prompt.length - 1];
      if (last?.role === "tool") return { content: [{ type: "text", text: "done" }] };
      const tool = (opts.tools ?? []).find((t) => t.name.includes("mytool__"));
      if (!tool) return { content: [{ type: "text", text: "no tool" }] };
      counter += 1;
      return {
        content: [
          { type: "tool-call", toolCallId: `c${counter}`, toolName: tool.name, input: "{}" },
        ],
      };
    });

    const runtime = await Runtime.start({
      identityProvider: devProvider,
      languageModel: model,
      workDir,
      logging: { disabled: true },
      telemetry: { enabled: false },
    });
    await provisionTestWorkspace(runtime);

    // Real, executable tool so the call routes + succeeds (injection fires
    // before execution either way, but a clean run keeps the test honest).
    const source = await makeInProcessSource("mytool", [
      {
        name: "ping",
        description: "Ping",
        inputSchema: { type: "object", properties: {} },
        handler: async () => ({ content: textContent("pong"), isError: false }),
      },
    ]);
    runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID).addSource(source);

    // Bind a curated overlay for server "mytool" (tool-affinity `mytool__*`).
    runtime.getLifecycle().setConnectorSkillFetch(fixtureFetch());
    const lock = await runtime
      .getLifecycle()
      .syncBoundSkills("com.test/mytool", "mytool", TEST_WORKSPACE_ID, runtime.getWorkDir());
    expect(lock).toHaveLength(1);

    const t1 = await runtime.chat({
      identity: DEV_IDENTITY,
      workspaceId: TEST_WORKSPACE_ID,
      message: "go",
      allowedTools: ["mytool__ping"],
    });
    const t2 = await runtime.chat({
      identity: DEV_IDENTITY,
      workspaceId: TEST_WORKSPACE_ID,
      conversationId: t1.conversationId,
      message: "again",
      allowedTools: ["mytool__ping"],
    });
    expect(t2.conversationId).toBe(t1.conversationId);

    const store = await runtime.resolveConversationStore(t1.conversationId);
    const events = await store!.readEvents(t1.conversationId);
    const injected = events.filter((e) => e.type === "connector.skill.injected");
    // Exactly once across both turns — re-injection (length 2) is the bug.
    expect(injected).toHaveLength(1);

    await source.stop().catch(() => {});
    await runtime.shutdown();
  });
});
