/**
 * What `nb__status` tells the agent about the model it is running on.
 *
 * A conversation is bound to one model for its life, so "what am I running on"
 * and "what is the configured default" are different questions with different
 * answers the moment anyone changes a model. Reporting only the configuration
 * makes the agent describe a setting while claiming to describe itself — the
 * observed failure was an assistant answering with the workspace default while
 * the turn ran on the pinned model, and then reporting a *different* model
 * after the default changed mid-conversation, though nothing about the turn
 * had changed.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineEvent, EventSink } from "../../src/engine/types.ts";
import type { UserIdentity } from "../../src/identity/provider.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";

/** Auto-title generation is async and shares the model queue; wait it out. */
async function waitForTitle(runtime: Runtime, conversationId: string, timeoutMs = 5000) {
  const store = await runtime.resolveConversationStore(conversationId);
  if (!store) throw new Error(`no conversation store for ${conversationId}`);
  const start = Date.now();
  for (;;) {
    const events = await store.readEvents(conversationId);
    if (events.some((e) => e.type === "aux.usage" || e.type === "metadata.title")) return;
    if (Date.now() - start > timeoutMs) throw new Error("no title generated in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const PINNED = "anthropic:claude-sonnet-5";
const RETARGETED = "nebius:moonshotai/Kimi-K2.6";

const USER: UserIdentity = {
  id: "usr_status",
  email: "status@example.com",
  displayName: "Status",
  orgRole: "member",
};

const testDir = join(tmpdir(), `nimblebrain-status-model-${Date.now()}`);

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

/** One `nb__status` call, then a plain reply once the result comes back. */
function statusThenReply(id: string) {
  return [
    {
      text: "checking",
      toolCalls: [
        { toolCallId: id, toolName: "nb__status", input: JSON.stringify({ scope: "config" }) },
      ],
    },
    { text: "answered" },
  ];
}

/**
 * The `nb__status` result for one tool call, by its id.
 *
 * By id rather than by position: the auto-title generation draws from the same
 * model queue, so anything that changes how many slots it takes would silently
 * shift array indices and re-point every assertion at the wrong turn.
 */
function statusOutput(events: EngineEvent[], callId: string): string {
  const done = events.find(
    (e) => e.type === "tool.done" && e.data.name === "nb__status" && e.data.id === callId,
  );
  if (!done) throw new Error(`no nb__status result for call "${callId}"`);
  return String((done.data as { output?: unknown }).output ?? "");
}

describe("what nb__status reports about the running model", () => {
  it("names the turn's model, and keeps naming it after the default moves", async () => {
    const workDir = join(testDir, "status-turn-model");
    mkdirSync(workDir, { recursive: true });

    const events: EngineEvent[] = [];
    const sink: EventSink = { emit: (e) => events.push(e) };

    const runtime = await Runtime.start({
      events: [sink],
      model: {
        provider: "custom",
        adapter: createEchoModel({
          responses: [
            ...statusThenReply("call_1"),
            // The auto-title call lands between the two turns and draws from
            // this same queue; without a slot of its own it would eat turn 2's
            // tool call.
            { text: "A title" },
            ...statusThenReply("call_2"),
          ],
        }),
      },
      noDefaultBundles: true,
      logging: { disabled: true },
      workDir,
      models: { default: PINNED, fast: PINNED },
    });
    await provisionTestWorkspace(runtime);
    await runtime.getWorkspaceStore().addMember(TEST_WORKSPACE_ID, USER.id, "member");

    try {
      const conv = await runtime.chat({
        message: "what model are you?",
        workspaceId: TEST_WORKSPACE_ID,
        identity: USER,
      });

      const first = statusOutput(events, "call_1");
      expect(first).toContain(`Running on: ${PINNED}`);

      // Let the title generation take its queue slot before turn 2, so the
      // second turn's tool call is not racing it.
      await waitForTitle(runtime, conv.conversationId);

      // The scenario that produced the wrong answer: the default moves while
      // the conversation is open, and the same question is asked again.
      runtime.updateConfig({ models: { default: RETARGETED } });

      await runtime.chat({
        message: "check your model again",
        conversationId: conv.conversationId,
        workspaceId: TEST_WORKSPACE_ID,
        identity: USER,
      });

      const second = statusOutput(events, "call_2");
      // Still the pin: the turn did not change, so the answer must not either.
      expect(second).toContain(`Running on: ${PINNED}`);
      // The new default is still reported — as configuration, under a heading
      // that says what it applies to, so it cannot be read as the answer.
      expect(second).toContain(`Default model: ${RETARGETED}`);
      expect(second).toContain("New conversations are created with");
    } finally {
      await runtime.shutdown();
    }
  });
  it("a sub-agent names its own model, not the parent's", async () => {
    // The child runs on the profile's model while its tools inherit the
    // parent's context, so without a restamp it would report the parent's.
    const workDir = join(testDir, "status-delegate-model");
    mkdirSync(workDir, { recursive: true });

    const events: EngineEvent[] = [];
    const sink: EventSink = { emit: (e) => events.push(e) };

    const runtime = await Runtime.start({
      events: [sink],
      model: {
        provider: "custom",
        adapter: createEchoModel({
          responses: [
            {
              text: "delegating",
              toolCalls: [
                {
                  toolCallId: "d_1",
                  toolName: "nb__delegate",
                  input: JSON.stringify({ task: "check your model", agent: "scout" }),
                },
              ],
            },
            // The child's first call: ask what it is running on.
            {
              text: "checking",
              toolCalls: [
                {
                  toolCallId: "c_1",
                  toolName: "nb__status",
                  input: JSON.stringify({ scope: "config" }),
                },
              ],
            },
            { text: "child done" },
            { text: "parent done" },
          ],
        }),
      },
      noDefaultBundles: true,
      logging: { disabled: true },
      workDir,
      models: { default: PINNED, fast: PINNED },
      agents: {
        scout: {
          description: "Scout",
          systemPrompt: "You scout.",
          tools: [],
          model: RETARGETED,
        },
      },
    });
    await provisionTestWorkspace(runtime);
    await runtime.getWorkspaceStore().addMember(TEST_WORKSPACE_ID, USER.id, "member");

    try {
      await runtime.chat({
        message: "delegate please",
        workspaceId: TEST_WORKSPACE_ID,
        identity: USER,
      });

      const output = statusOutput(events, "c_1");
      expect(output).toContain(`Running on: ${RETARGETED}`);
      expect(output).not.toContain(`Running on: ${PINNED}`);
    } finally {
      await runtime.shutdown();
    }
  });
  it("an automation run names its own model, and there is no conversation to bind it to", async () => {
    // `executeTask` stamps the context too. Nothing is pinned — there is no
    // conversation — so the report has to be true without appealing to one.
    const workDir = join(testDir, "status-task-model");
    mkdirSync(workDir, { recursive: true });

    const events: EngineEvent[] = [];
    const sink: EventSink = { emit: (e) => events.push(e) };

    const runtime = await Runtime.start({
      events: [sink],
      model: {
        provider: "custom",
        adapter: createEchoModel({ responses: statusThenReply("t_1") }),
      },
      noDefaultBundles: true,
      logging: { disabled: true },
      workDir,
      // Default deliberately differs from what the run is told to use, or the
      // assertion cannot tell a turn-derived answer from a config-derived one.
      models: { default: PINNED, fast: PINNED },
    });
    await provisionTestWorkspace(runtime);
    await runtime.getWorkspaceStore().addMember(TEST_WORKSPACE_ID, USER.id, "member");

    try {
      await runtime.executeTask({
        prompt: "what model are you?",
        workspaceId: TEST_WORKSPACE_ID,
        identity: USER,
        model: RETARGETED,
      });

      const out = statusOutput(events, "t_1");
      expect(out).toContain(`Running on: ${RETARGETED}`);
      expect(out).not.toContain(`Running on: ${PINNED}`);
      // The output ceiling is derived from the model's own limits, so it has to
      // follow the running model too — reported against the default slot it
      // would name a cap the engine never applied.
      expect(out).toContain(`Max output tokens: ${runtime.getMaxOutputTokens(RETARGETED).toLocaleString()}`);
      expect(runtime.getMaxOutputTokens(RETARGETED)).not.toBe(runtime.getMaxOutputTokens(PINNED));
      // The binding sentence must hold here too: an automation has no
      // conversation, so it cannot claim one.
      expect(out).toContain("Fixed for this turn");
      expect(out).not.toContain("conversation was created");
    } finally {
      await runtime.shutdown();
    }
  });

  it("the overview scope names the running model rather than the default", async () => {
    const workDir = join(testDir, "status-overview-model");
    mkdirSync(workDir, { recursive: true });

    const events: EngineEvent[] = [];
    const sink: EventSink = { emit: (e) => events.push(e) };

    const runtime = await Runtime.start({
      events: [sink],
      model: {
        provider: "custom",
        adapter: createEchoModel({
          responses: [
            // Turn 1 binds the conversation, before the default moves.
            { text: "hello" },
            // Auto-title takes the next slot.
            { text: "A title" },
            // Turn 2 asks, after the default has moved away from the pin.
            {
              text: "checking",
              toolCalls: [
                {
                  toolCallId: "o_1",
                  toolName: "nb__status",
                  input: JSON.stringify({ scope: "overview" }),
                },
              ],
            },
            { text: "answered" },
          ],
        }),
      },
      noDefaultBundles: true,
      logging: { disabled: true },
      workDir,
      models: { default: PINNED, fast: PINNED },
    });
    await provisionTestWorkspace(runtime);
    await runtime.getWorkspaceStore().addMember(TEST_WORKSPACE_ID, USER.id, "member");

    try {
      const conv = await runtime.chat({
        message: "hello",
        workspaceId: TEST_WORKSPACE_ID,
        identity: USER,
      });
      await waitForTitle(runtime, conv.conversationId);

      // The default must differ from the pin, or the assertion passes whether
      // the line reports the turn or the configuration.
      runtime.updateConfig({ models: { default: RETARGETED } });

      await runtime.chat({
        message: "status please",
        conversationId: conv.conversationId,
        workspaceId: TEST_WORKSPACE_ID,
        identity: USER,
      });

      const out = statusOutput(events, "o_1");
      // Inside a run the overview line is the turn's model, not the config's.
      expect(out).toContain(`Model: ${PINNED}`);
      expect(out).not.toContain(`Model: ${RETARGETED}`);
    } finally {
      await runtime.shutdown();
    }
  });
});
