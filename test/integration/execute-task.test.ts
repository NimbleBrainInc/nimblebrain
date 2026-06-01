/**
 * Integration coverage for `runtime.executeTask()` — the unattended
 * agent invocation primitive that sits beside `runtime.chat()`.
 *
 * These tests pin the contract differences from chat:
 *  - Each call creates a FRESH conversation (no resume path).
 *  - The deliverable persists to the conversation (so the UI's
 *    "Open conversation →" affordance can show it).
 *  - `workspaceId` set    → focused workspace tool scope.
 *  - `workspaceId` absent → the orchestrator still routes a namespaced
 *                            cross-workspace tool call (dispatch
 *                            contract). The ACTIVE tool list shown to
 *                            the model is the personal workspace's
 *                            tools + identity tools; cross-workspace
 *                            tools are reachable via `nb__search` as
 *                            the discoverable corpus, NOT preloaded
 *                            into the active set.
 *
 * Carrying duplication with `_chatInner` is the deferred follow-up
 * captured in runtime.ts; the safety net is THIS test catching any
 * divergence in identity resolution, tool surfacing, or deliverable
 * persistence as chat() evolves.
 *
 * Mirrors the setup pattern in
 * `test/integration/ambient-context-cross-workspace.test.ts`: Runtime +
 * echo model, no HTTP server, in-process probe source.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { textContent } from "../../src/engine/content-helpers.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { defineInProcessApp, type InProcessTool } from "../../src/tools/in-process-app.ts";
import { namespacedToolName } from "../../src/tools/namespace.ts";
import { personalWorkspaceIdFor } from "../../src/workspace/workspace-store.ts";
import { createEchoModel } from "../helpers/echo-model.ts";

const TEST_USER_ID = "usr_exec_task_test";
const TEST_USER_DISPLAY = "Task Test User";
const SHARED_WS_ID = "ws_shared_tasks";

function buildProbeSource() {
  const calls: Array<{ workspaceId?: string }> = [];
  const tool: InProcessTool = {
    name: "ping",
    description: "Test probe — records that it was invoked.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => ({
      content: textContent("pong"),
      isError: false,
    }),
  };
  const source = defineInProcessApp(
    { name: "probe", version: "1.0.0", tools: [tool] },
    { emit() {} },
  );
  return { calls, source };
}

describe("runtime.executeTask", () => {
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

  async function bootRuntime(echoResponses: Parameters<typeof createEchoModel>[0]) {
    workDir = mkdtempSync(join(tmpdir(), "nb-exec-task-"));
    mkdirSync(workDir, { recursive: true });
    const r = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel(echoResponses) },
      noDefaultBundles: true,
      logging: { disabled: true },
      workDir,
    });
    return r;
  }

  async function provisionWorkspaces(r: Runtime) {
    const wsStore = r.getWorkspaceStore();
    const personalWsId = personalWorkspaceIdFor(TEST_USER_ID);
    await wsStore.create("Personal", personalWsId.slice(3), {
      isPersonal: true,
      ownerUserId: TEST_USER_ID,
    });
    await wsStore.create("Shared", SHARED_WS_ID.slice(3));
    await wsStore.addMember(SHARED_WS_ID, TEST_USER_ID, "admin");
    return { personalWsId, sharedWsId: SHARED_WS_ID };
  }

  it("returns a deliverable and a fresh conversation id on the happy path", async () => {
    // Echo model: no scripted responses → falls back to echoing the
    // last user message. The task prompt is the user message, so the
    // returned output should contain the prompt back.
    runtime = await bootRuntime(undefined);
    await provisionWorkspaces(runtime);

    const result = await runtime.executeTask({
      prompt: "summarize today's activity",
      identity: { id: TEST_USER_ID, displayName: TEST_USER_DISPLAY },
    });

    expect(result.output).toContain("summarize today's activity");
    expect(result.conversationId).toMatch(/^[a-z0-9_-]+$/i);
    expect(result.stopReason).toBe("complete");
    expect(result.usage.iterations).toBeGreaterThan(0);
  });

  it("each call writes a NEW conversation (no resume path)", async () => {
    runtime = await bootRuntime(undefined);
    await provisionWorkspaces(runtime);

    const first = await runtime.executeTask({
      prompt: "first run",
      identity: { id: TEST_USER_ID, displayName: TEST_USER_DISPLAY },
    });
    const second = await runtime.executeTask({
      prompt: "second run",
      identity: { id: TEST_USER_ID, displayName: TEST_USER_DISPLAY },
    });

    expect(first.conversationId).not.toBe(second.conversationId);
  });

  it("persists the deliverable to the backing conversation", async () => {
    runtime = await bootRuntime(undefined);
    await provisionWorkspaces(runtime);

    const result = await runtime.executeTask({
      prompt: "what's the date today?",
      identity: { id: TEST_USER_ID, displayName: TEST_USER_DISPLAY },
    });

    // The conversation is reachable via the runtime's conversation store
    // and must carry the assistant message holding the deliverable.
    const store = runtime.findConversationStore();
    const convo = await store.load(result.conversationId);
    expect(convo).not.toBeNull();
    const history = await store.history(convo!);
    const assistantMessages = history.filter((m) => m.role === "assistant");
    expect(assistantMessages.length).toBeGreaterThan(0);
    // The deliverable in result.output matches what was persisted.
    const persistedText = assistantMessages
      .flatMap((m) =>
        Array.isArray(m.content)
          ? m.content.filter((c: { type: string }) => c.type === "text")
          : [],
      )
      .map((c: { text: string }) => c.text)
      .join("");
    expect(persistedText).toContain(result.output);
  });

  it("with workspaceId set, focused workspace's tools are surfaced", async () => {
    const probe = buildProbeSource();
    await probe.source.start();

    // Script the model to call probe__ping (namespaced to the focused
    // workspace) once, then conclude.
    const namespacedPing = namespacedToolName(SHARED_WS_ID, "probe__ping");
    runtime = await bootRuntime({
      responses: [
        {
          toolCalls: [
            {
              toolCallId: "call_focused",
              toolName: namespacedPing,
              input: JSON.stringify({}),
            },
          ],
        },
        { text: "done" },
      ],
    });
    await provisionWorkspaces(runtime);
    const reg = await runtime.ensureWorkspaceRegistry(SHARED_WS_ID);
    reg.addSource(probe.source);

    const result = await runtime.executeTask({
      prompt: "ping the shared workspace probe",
      identity: { id: TEST_USER_ID, displayName: TEST_USER_DISPLAY },
      workspaceId: SHARED_WS_ID,
    });

    // The tool call landed — the namespacing chose the focused workspace.
    expect(result.toolCalls.length).toBeGreaterThan(0);
    expect(result.toolCalls[0]?.name).toBe(namespacedPing);
    expect(result.toolCalls[0]?.ok).toBe(true);
  });

  it("with workspaceId omitted, the orchestrator dispatches a namespaced cross-workspace tool call", async () => {
    const probe = buildProbeSource();
    await probe.source.start();

    // Pins the DISPATCH contract: when a task without a focused
    // workspace issues a tool call namespaced to ws_shared_tasks, the
    // orchestrator must route it to that workspace's source and execute
    // it (the identity is a member, so authorization passes).
    //
    // What this test does NOT verify, and is documented on
    // `TaskRequest.workspaceId`: that the model would DISCOVER probe__ping
    // in its active tool list without `workspaceId`. It would not. With
    // no focus, the active toolset is the personal-workspace tools +
    // identity tools (same as chat at the identity-level home). The
    // cross-workspace union is the search corpus reached via `nb__search`.
    // Here the echo model is scripted to emit the namespaced call
    // directly — the test pins what happens when one lands.
    const namespacedPing = namespacedToolName(SHARED_WS_ID, "probe__ping");
    runtime = await bootRuntime({
      responses: [
        {
          toolCalls: [
            {
              toolCallId: "call_cross",
              toolName: namespacedPing,
              input: JSON.stringify({}),
            },
          ],
        },
        { text: "done" },
      ],
    });
    await provisionWorkspaces(runtime);
    const reg = await runtime.ensureWorkspaceRegistry(SHARED_WS_ID);
    reg.addSource(probe.source);

    const result = await runtime.executeTask({
      prompt: "ping anywhere you can reach",
      identity: { id: TEST_USER_ID, displayName: TEST_USER_DISPLAY },
      // No workspaceId — unscoped task; the orchestrator's per-call
      // routing still resolves the namespaced tool to ws_shared_tasks.
    });

    expect(result.toolCalls.length).toBeGreaterThan(0);
    expect(result.toolCalls[0]?.name).toBe(namespacedPing);
    expect(result.toolCalls[0]?.ok).toBe(true);
  });

  it("stamps source: 'task' on the conversation metadata", async () => {
    runtime = await bootRuntime(undefined);
    await provisionWorkspaces(runtime);

    const result = await runtime.executeTask({
      prompt: "tag check",
      identity: { id: TEST_USER_ID, displayName: TEST_USER_DISPLAY },
      metadata: { automationId: "auto_test_123" },
    });

    const store = runtime.findConversationStore();
    const convo = await store.load(result.conversationId);
    expect(convo).not.toBeNull();
    expect(convo!.metadata?.source).toBe("task");
    // Caller's metadata passes through alongside the source tag.
    expect(convo!.metadata?.automationId).toBe("auto_test_123");
  });
});
