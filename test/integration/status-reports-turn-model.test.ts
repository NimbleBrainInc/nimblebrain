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
  const start = Date.now();
  for (;;) {
    const events = await store!.readEvents(conversationId);
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

/** Every `nb__status` result the run produced, in order. */
function statusOutputs(events: EngineEvent[]): string[] {
  return events
    .filter((e) => e.type === "tool.done" && e.data.name === "nb__status")
    .map((e) => String((e.data as { output?: unknown }).output ?? ""));
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

      const first = statusOutputs(events)[0];
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

      const second = statusOutputs(events)[1];
      // Still the pin: the turn did not change, so the answer must not either.
      expect(second).toContain(`Running on: ${PINNED}`);
      // The new default is still reported — as configuration, under a heading
      // that says what it applies to, so it cannot be read as the answer.
      expect(second).toContain(`Default model: ${RETARGETED}`);
      expect(second).toContain("NEW conversation");
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

      const output = statusOutputs(events)[0];
      expect(output).toContain(`Running on: ${RETARGETED}`);
      expect(output).not.toContain(`Running on: ${PINNED}`);
    } finally {
      await runtime.shutdown();
    }
  });
});
