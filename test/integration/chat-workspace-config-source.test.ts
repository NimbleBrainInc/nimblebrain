/**
 * Which workspace supplies a chat turn's agent profiles and model overrides.
 *
 * These are workspace configuration (`workspace.json`'s `agents` / `models`),
 * and they apply to every turn that runs in that workspace regardless of who is
 * chatting. The alternative — reading them off the caller's PERSONAL workspace
 * — is what forced a second workspace onto every request, because it made a
 * chat in a shared workspace depend on a workspace it was not bound to.
 *
 * `test/unit/runtime/chat-workspace-config.test.ts` covers the MERGE (workspace
 * over instance) against a local re-implementation, so it cannot observe which
 * workspace supplied the input and stays green either way. This test observes
 * the ambient `RequestContext` inside a real `runtime.chat()` turn, which is
 * the only place that question is answerable.
 */

import { afterEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEchoModel } from "../helpers/echo-model.ts";
import { textContent } from "../../src/engine/content-helpers.ts";
import { getRequestContext } from "../../src/runtime/request-context.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { defineInProcessApp, type InProcessTool } from "../../src/tools/in-process-app.ts";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { personalWorkspaceIdFor } from "../../src/workspace/workspace-store.ts";

const TEST_USER_ID = "usr_cfg";
const SHARED_WS_ID = "ws_cfgshared00000";

interface Observation {
  agentNames: string[];
  fastModel: string | undefined;
}

function buildProbe(): { observations: Observation[]; source: ReturnType<typeof defineInProcessApp> } {
  const observations: Observation[] = [];
  const tool: InProcessTool = {
    name: "observe",
    description: "Records the ambient workspace config on each call.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const ctx = getRequestContext();
      observations.push({
        agentNames: Object.keys(ctx?.workspaceAgents ?? {}),
        fastModel: ctx?.workspaceModelOverride?.fast,
      });
      return { content: textContent("observed"), isError: false };
    },
  };
  return {
    observations,
    source: defineInProcessApp({ name: "probe", version: "1.0.0", tools: [tool] }, new NoopEventSink()),
  };
}

let workDir: string;
let runtime: Runtime | null = null;

afterEach(async () => {
  if (runtime) {
    await runtime.shutdown();
    runtime = null;
  }
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

it("a chat in a shared workspace uses THAT workspace's agents and model overrides, not the caller's personal ones", async () => {
  workDir = mkdtempSync(join(tmpdir(), "nb-chat-cfg-"));
  mkdirSync(workDir, { recursive: true });

  const probe = buildProbe();
  await probe.source.start();

  const model = createEchoModel({
    responses: [
      { toolCalls: [{ toolCallId: "c1", toolName: "probe__observe", input: JSON.stringify({}) }] },
      { text: "done" },
    ],
  });

  runtime = await Runtime.start({
    model: { provider: "custom", adapter: model },
    noDefaultBundles: true,
    logging: { disabled: true },
    workDir,
  });

  const wsStore = runtime.getWorkspaceStore();

  // The shared workspace the chat runs in — its config is the one that must apply.
  await wsStore.create("Shared", SHARED_WS_ID.slice(3));
  await wsStore.addMember(SHARED_WS_ID, TEST_USER_ID, "admin");
  await wsStore.update(SHARED_WS_ID, {
    agents: { sharedAgent: { description: "shared", systemPrompt: "shared" } },
    models: { fast: "anthropic:shared-fast-model" },
  });

  // The caller's personal workspace, deliberately configured DIFFERENTLY. If
  // the config source regressed to the personal workspace, these names appear.
  const personalWsId = personalWorkspaceIdFor(TEST_USER_ID);
  await wsStore.create("Personal", personalWsId.slice(3), {
    isPersonal: true,
    ownerUserId: TEST_USER_ID,
  });
  await wsStore.update(personalWsId, {
    agents: { personalAgent: { description: "personal", systemPrompt: "personal" } },
    models: { fast: "anthropic:personal-fast-model" },
  });

  const sharedReg = await runtime.ensureWorkspaceRegistry(SHARED_WS_ID);
  sharedReg.addSource(probe.source);

  await runtime.chat({
    identity: { id: TEST_USER_ID, displayName: "Cfg User" },
    workspaceId: SHARED_WS_ID,
    message: "config source check",
  });

  expect(probe.observations).toHaveLength(1);
  expect(probe.observations[0]?.agentNames).toEqual(["sharedAgent"]);
  expect(probe.observations[0]?.agentNames).not.toContain("personalAgent");
  expect(probe.observations[0]?.fastModel).toBe("anthropic:shared-fast-model");
});
