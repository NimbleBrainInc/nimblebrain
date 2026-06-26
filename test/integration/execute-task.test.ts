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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { textContent } from "../../src/engine/content-helpers.ts";
import type { EngineEvent, EventSink } from "../../src/engine/types.ts";
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
    const store = await runtime.resolveConversationStore(result.conversationId);
    const convo = await store!.load(result.conversationId);
    expect(convo).not.toBeNull();
    const history = await store!.history(convo!);
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

  it("with workspaceId omitted, a cross-workspace tool call is walled (bounded to the session workspace)", async () => {
    const probe = buildProbeSource();
    await probe.source.start();

    // The wall for the task path: an unscoped task is bounded to the session
    // (personal) workspace. A call namespaced to ANOTHER workspace is denied
    // even though the identity is a member of it — a task reaches exactly one
    // workspace plus identity tools, never a cross-workspace union. The echo
    // model is scripted to emit the namespaced cross-workspace call directly;
    // the test pins that the wall refuses it.
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
      // No workspaceId — unscoped task bounded to the session (personal) ws.
    });

    expect(result.toolCalls.length).toBeGreaterThan(0);
    expect(result.toolCalls[0]?.name).toBe(namespacedPing);
    // Walled: a task bounded to its session workspace cannot reach another.
    expect(result.toolCalls[0]?.ok).toBe(false);
    expect(result.toolCalls[0]?.output).toMatch(/not a member|denied|access|bounded/i);
  });

  it("returns partial usage + conversationId tagged 'aborted' when the run is aborted mid-flight", async () => {
    // Pins the event-shape contract the per-run usage accumulator in
    // runtime.executeTask depends on. The accumulator reads `data.usage`
    // off `llm.done` and counts `tool.done`; if either shape drifts it
    // silently captures zeros — reverting automations to the exact 0/0/0/0
    // regression this whole change exists to kill, with the suite still
    // green. This test boots a REAL engine + echo model, aborts after the
    // first tool turn completes, and asserts the abort-return path carries
    // the real work done before the abort instead of zeros.
    const probe = buildProbeSource();
    await probe.source.start();

    const namespacedPing = namespacedToolName(SHARED_WS_ID, "probe__ping");
    runtime = await bootRuntime({
      responses: [
        // Turn 1: text (so the echo model reports nonzero usage) + a tool
        // call (so the loop continues past this turn to a second
        // iteration-boundary check, where the abort is observed).
        {
          text: "pinging the probe",
          toolCalls: [
            { toolCallId: "call_abort", toolName: namespacedPing, input: JSON.stringify({}) },
          ],
        },
        // Turn 2 is never reached — the abort fires after turn 1's tool.done.
        { text: "done" },
      ],
    });
    await provisionWorkspaces(runtime);
    const reg = await runtime.ensureWorkspaceRegistry(SHARED_WS_ID);
    reg.addSource(probe.source);

    // Abort once the first tool call has completed: by tool.done, both the
    // turn's llm.done (usage) and the tool.done (toolCall) have been
    // accumulated. The engine throws at the next iteration boundary; the
    // executeTask catch returns the partial result instead of rethrowing.
    const controller = new AbortController();
    const abortAfterFirstTool: EventSink = {
      emit(event: EngineEvent): void {
        if (event.type === "tool.done") controller.abort();
      },
    };

    const result = await runtime.executeTask(
      {
        prompt: "ping the probe, then keep going",
        identity: { id: TEST_USER_ID, displayName: TEST_USER_DISPLAY },
        workspaceId: SHARED_WS_ID,
        signal: controller.signal,
      },
      abortAfterFirstTool,
    );

    expect(result.stopReason).toBe("aborted");
    // The real work done before the abort — NOT 0/0/0/0.
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    expect(result.usage.iterations).toBeGreaterThan(0);
    expect(result.toolCalls.length).toBeGreaterThan(0);
    expect(result.toolCalls[0]?.name).toBe(namespacedPing);
    // A real conversation anchor for post-mortem (the gap the synthesized
    // 0/0/0/0 record left behind).
    expect(result.conversationId).toMatch(/^[a-z0-9_-]+$/i);
  });

  it("stamps source: 'task' on the conversation metadata", async () => {
    runtime = await bootRuntime(undefined);
    await provisionWorkspaces(runtime);

    const result = await runtime.executeTask({
      prompt: "tag check",
      identity: { id: TEST_USER_ID, displayName: TEST_USER_DISPLAY },
      metadata: { automationId: "auto_test_123" },
    });

    const store = await runtime.resolveConversationStore(result.conversationId);
    const convo = await store!.load(result.conversationId);
    expect(convo).not.toBeNull();
    expect(convo!.metadata?.source).toBe("task");
    // Caller's metadata passes through alongside the source tag.
    expect(convo!.metadata?.automationId).toBe("auto_test_123");
  });

  it("loads the focused workspace's `always` skill into Layer 3 (parity with chat path)", async () => {
    // Regression guard for the executeTask analog of the chat-path bug
    // PR #315 fixed in `_chatInner`. Before this fix,
    // `loadConversationSkills(sessionWsId, ...)` at runtime.ts:1703
    // pulled workspace-tier skills from the user's personal workspace,
    // so any scheduled task focused on a shared workspace silently
    // dropped that workspace's `loading_strategy: always` skills.
    //
    // Fix: `loadConversationSkills(focusedWsId ?? sessionWsId, ...)`.
    // This test plants a workspace-tier skill in the SHARED workspace
    // (different dir than the personal workspace), runs an
    // executeTask focused on the shared workspace, and asserts the
    // skill lands in the recorded `skills.loaded` event.
    runtime = await bootRuntime(undefined);
    const { personalWsId } = await provisionWorkspaces(runtime);
    expect(personalWsId).not.toBe(SHARED_WS_ID);

    const SKILL_NAME = "shared-task-voice";
    const sharedSkillsDir = join(workDir, "workspaces", SHARED_WS_ID, "skills");
    mkdirSync(sharedSkillsDir, { recursive: true });
    writeFileSync(
      join(sharedSkillsDir, `${SKILL_NAME}.md`),
      // dynamic + tool-affinity (nb__* is always surfaced) → Layer 3, where this
      // asserts task/chat parity for focused-workspace skill loading.
      `---\nname: ${SKILL_NAME}\ndescription: workflow for the shared workspace\nmetadata:\n  nimblebrain:\n    loading-strategy: dynamic\n    tool-affinity: ["nb__*"]\n    priority: 30\n---\n\nAlways answer in plain English.\n`,
    );

    const result = await runtime.executeTask({
      prompt: "do a thing",
      identity: { id: TEST_USER_ID, displayName: TEST_USER_DISPLAY },
      workspaceId: SHARED_WS_ID,
    });

    const store = await runtime.resolveConversationStore(result.conversationId);
    const events = await store!.readEvents(result.conversationId);
    const skillsLoaded = events.find((e) => e.type === "skills.loaded");
    expect(skillsLoaded).toBeDefined();

    const payload = skillsLoaded as unknown as {
      skills: Array<{ id: string; scope: string; loadedBy: string }>;
    };
    const expectedPath = join(sharedSkillsDir, `${SKILL_NAME}.md`);
    const entry = payload.skills.find((s) => s.id === expectedPath);
    expect(entry).toBeDefined();
    expect(entry?.scope).toBe("workspace");
    expect(entry?.loadedBy).toBe("tool_affinity");
  });
});
