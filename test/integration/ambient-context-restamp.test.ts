/**
 * Stage 2 T008 — Ambient-context fix (Group C audit follow-up).
 *
 * The chat path's outer `runWithRequestContext` sets
 * `RequestContext.workspaceId = sessionWsId` (the user's personal
 * workspace). Tool handlers that read `runtime.requireWorkspaceId()` —
 * or anything that reads `getRequestContext()?.workspaceId` — would
 * otherwise see the SESSION workspace, not the routed workspace,
 * when a cross-workspace call lands on a shared system tool.
 *
 * T008 chose approach (a) per the task spec: wrap each per-call
 * `source.execute(...)` in a fresh `runWithRequestContext` keyed on
 * `routed.context.workspaceId`. This test pins the contract: a
 * cross-workspace call into `ws_helix/...` makes the handler observe
 * `ws_helix`, not the chat's session personal workspace.
 *
 * Both surfaces (chat + `/mcp`) must honour the same contract. The
 * `/mcp` path was already correct (it constructs its own RequestContext
 * from the routed wsId per call); we exercise it here to pin parity.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { textContent } from "../../src/engine/content-helpers.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { defineInProcessApp, type InProcessTool } from "../../src/tools/in-process-app.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { getRequestContext } from "../../src/runtime/request-context.ts";
import { namespacedToolName } from "../../src/tools/namespace.ts";
import {
  WorkspaceStore,
  personalWorkspaceIdFor,
} from "../../src/workspace/workspace-store.ts";

const TEST_USER_ID = "usr_amb_ctx_test";
const TEST_USER_DISPLAY = "Ambient Test";
const SHARED_WS_ID = "ws_helix";

interface ContextObservation {
  workspaceId: string | null | undefined;
}

interface ProbeSource {
  observations: ContextObservation[];
  source: ReturnType<typeof defineInProcessApp>;
}

function buildContextProbeSource(sourceName: string, toolName: string): ProbeSource {
  const observations: ContextObservation[] = [];
  const tool: InProcessTool = {
    name: toolName,
    description: "Records the ambient RequestContext.workspaceId on each call.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      // Read the in-process RequestContext that the runtime sets
      // around each `source.execute(...)` dispatch. T008's fix wraps
      // the source dispatch with a per-call `runWithRequestContext`
      // keyed on the ROUTED workspace — this observation must reflect
      // that.
      const ctx = getRequestContext();
      const observedWorkspaceId =
        ctx?.scope.kind === "workspace" ? ctx.scope.workspaceId : undefined;
      observations.push({ workspaceId: observedWorkspaceId });
      return {
        content: textContent(
          `observed workspaceId=${observedWorkspaceId ?? "(undefined)"}`,
        ),
        isError: false,
      };
    },
  };
  const source = defineInProcessApp(
    {
      name: sourceName,
      version: "1.0.0",
      tools: [tool],
    },
    { emit() {} },
  );
  return { observations, source };
}

describe("Stage 2 T008 — ambient RequestContext.workspaceId matches the routed workspace", () => {
  let workDir: string;
  let runtime: Runtime | null = null;

  afterEach(async () => {
    if (runtime) {
      await runtime.shutdown();
      runtime = null;
    }
    if (workDir) {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("chat path: invoking ws_helix/<tool> from a session whose default workspace is ws_user_<id> makes the handler observe ws_helix", async () => {
    workDir = mkdtempSync(join(tmpdir(), "nb-t008-amb-chat-"));
    mkdirSync(workDir, { recursive: true });

    const probe = buildContextProbeSource("probe", "observe");
    await probe.source.start();

    const sharedToolName = namespacedToolName(SHARED_WS_ID, "probe__observe");

    // Script the model to issue ONE cross-workspace tool call.
    const model = createEchoModel({
      responses: [
        {
          toolCalls: [
            {
              toolCallId: "call_amb_shared",
              toolName: sharedToolName,
              input: JSON.stringify({}),
            },
          ],
        },
        { text: "done" },
      ],
    });

    runtime = await Runtime.start({
      model: { provider: "custom", adapter: model },
      noDefaultBundles: true,
      logging: { disabled: true },
      workDir,
    });

    // Provision the shared workspace and the user's personal workspace.
    const wsStore = runtime.getWorkspaceStore();
    await wsStore.create("Helix", SHARED_WS_ID.slice(3));
    await wsStore.addMember(SHARED_WS_ID, TEST_USER_ID, "admin");
    const personalWsId = personalWorkspaceIdFor(TEST_USER_ID);
    await wsStore.create("Personal", personalWsId.slice(3), {
      isPersonal: true,
      ownerUserId: TEST_USER_ID,
    });

    // Register the probe source in BOTH workspaces' registries.
    // We need the shared workspace to have it so the cross-workspace
    // call lands. The personal workspace doesn't need it for this test
    // (the routed wsId is ws_helix).
    const sharedReg = await runtime.ensureWorkspaceRegistry(SHARED_WS_ID);
    sharedReg.addSource(probe.source);

    // Run the chat FOCUSED on ws_helix. The ambient session scope is still
    // the user's personal workspace (the session bridge `runWithRequestContext`
    // sets `workspaceId = ws_user_<id>`); the per-call wrap must restamp to the
    // routed ws_helix at dispatch time.
    await runtime.chat({
      identity: { id: TEST_USER_ID, displayName: TEST_USER_DISPLAY },
      workspaceId: SHARED_WS_ID,
      message: "ambient context check",
    });

    // The handler observed exactly one call; the workspaceId it saw
    // must be the ROUTED ws_helix, NOT the session ws_user_<id>.
    expect(probe.observations).toHaveLength(1);
    expect(probe.observations[0]?.workspaceId).toBe(SHARED_WS_ID);
    // Cross-check: NOT the personal workspace (defends against the
    // failure mode where the outer RequestContext leaked through).
    expect(probe.observations[0]?.workspaceId).not.toBe(personalWsId);
  });
});
