import type { LanguageModelV3, LanguageModelV3Message } from "@ai-sdk/provider";
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StaticToolRouter } from "../../src/adapters/static-router.ts";
import { EventSourcedConversationStore } from "../../src/conversation/event-sourced-store.ts";
import type { Conversation } from "../../src/conversation/types.ts";
import { textContent } from "../../src/engine/content-helpers.ts";
import { AgentEngine } from "../../src/engine/engine.ts";
import type { EngineConfig, EngineEvent, EventSink, ToolSchema } from "../../src/engine/types.ts";
import { createMockModel } from "../helpers/mock-model.ts";
import { recordingModel } from "../helpers/recording-model.ts";

/**
 * Surface-once-into-history mechanism (P4), end-to-end against a real
 * event-sourced conversation store and a recording model.
 *
 * This is the engine-level proof of the centerpiece: a connector overlay is
 * surfaced into the conversation history exactly once on the first matching
 * tool call (never into the system prefix), persisted as a
 * `connector.skill.injected` event, reconstructed into a synthetic history
 * message, and NOT re-injected on a subsequent turn whose history already
 * carries it. The full install → materialize → uninstall path is exercised by
 * the lifecycle integration test that drives `Runtime.chat`.
 */

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function freshStore(): EventSourcedConversationStore {
  const dir = mkdtempSync(join(tmpdir(), "nb-connector-skill-"));
  dirs.push(dir);
  return new EventSourcedConversationStore({ dir });
}

const SYSTEM = "You are a test assistant.";
const OVERLAY_BODY = "Always confirm the recipient before calling gmail__send.";
const SEND_TOOL: ToolSchema = { name: "gmail__send", description: "Send an email", inputSchema: {} };

function config(): EngineConfig {
  return {
    model: "test-model",
    maxIterations: 10,
    maxInputTokens: 500_000,
    maxOutputTokens: 16_384,
    connectorSkillCandidates: [
      { name: "composio/gmail", body: OVERLAY_BODY, scope: "connector", toolAffinity: ["gmail__*"] },
    ],
  };
}

/** Model that calls `gmail__send` on the first iteration, then answers. */
function sendThenAnswer(): LanguageModelV3 {
  let n = 0;
  return createMockModel(() => {
    n++;
    if (n === 1) {
      return {
        content: [{ type: "tool-call", toolCallId: `c${n}`, toolName: "gmail__send", input: "{}" }],
      };
    }
    return { content: [{ type: "text", text: "Email sent." }] };
  });
}

function router(): StaticToolRouter {
  return new StaticToolRouter([SEND_TOOL], () => ({ content: textContent("sent"), isError: false }));
}

async function appendUser(
  store: EventSourcedConversationStore,
  conv: Conversation,
  text: string,
): Promise<void> {
  await store.append(conv, {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: new Date().toISOString(),
  });
}

function systemContent(prompt: LanguageModelV3Message[]): string {
  const sys = prompt.find((m) => m.role === "system");
  return sys && typeof sys.content === "string" ? sys.content : "";
}

function messagesContainOverlay(prompt: LanguageModelV3Message[]): boolean {
  return prompt.some(
    (m) =>
      m.role !== "system" &&
      Array.isArray(m.content) &&
      m.content.some((p) => p.type === "text" && p.text.includes(OVERLAY_BODY)),
  );
}

describe("connector-skill surface-once (engine + event store)", () => {
  it("surfaces the overlay into history once, never into the system prefix, and rides the next turn", async () => {
    const store = freshStore();
    const conv = await store.create({ ownerId: "u1" });
    store.setActiveConversation(conv.id);

    // --- Turn 1: user asks; model calls gmail__send then answers. ---
    await appendUser(store, conv, "send an email to a@b.com");
    const rec1 = recordingModel(sendThenAnswer());
    const engine1 = new AgentEngine(rec1.model, router(), store);
    await engine1.run(config(), SYSTEM, await store.history(conv), [SEND_TOOL]);

    // The overlay was surfaced into the conversation history as a synthetic
    // assistant message — reconstructed from the persisted event.
    const afterTurn1 = await store.history(conv);
    const synthetic = afterTurn1.find((m) => m.metadata?.synthetic === "connector_skill_injected");
    expect(synthetic).toBeDefined();
    expect(synthetic!.role).toBe("assistant");
    expect(synthetic!.metadata?.skill).toBe("composio/gmail");

    // It NEVER entered the cached system prefix on any turn-1 model call.
    for (const call of rec1.calls) {
      expect(systemContent(call.prompt)).not.toContain(OVERLAY_BODY);
    }

    // --- Turn 2: a fresh user turn; history already carries the overlay. ---
    await appendUser(store, conv, "now send another");
    const history2 = await store.history(conv);
    expect(messagesContainOverlay(history2)).toBe(true);

    const injected2: EngineEvent[] = [];
    const sink2: EventSink = {
      emit(e) {
        if (e.type === "connector.skill.injected") injected2.push(e);
        store.emit(e);
      },
    };
    const rec2 = recordingModel(sendThenAnswer());
    const engine2 = new AgentEngine(rec2.model, router(), sink2);
    await engine2.run(config(), SYSTEM, history2, [SEND_TOOL]);

    // Calling the same connector tool again does NOT re-surface the overlay —
    // the engine sees it already in history (cross-run dedup).
    expect(injected2).toHaveLength(0);

    // The model saw the overlay in the message history, not the system prefix.
    const firstCall2 = rec2.calls[0]!;
    expect(systemContent(firstCall2.prompt)).not.toContain(OVERLAY_BODY);
    expect(messagesContainOverlay(firstCall2.prompt)).toBe(true);
  });

  it("never surfaces a connector overlay when no candidate's affinity matches the called tool", async () => {
    const store = freshStore();
    const conv = await store.create({ ownerId: "u1" });
    store.setActiveConversation(conv.id);

    const calendarTool: ToolSchema = {
      name: "calendar__list",
      description: "List events",
      inputSchema: {},
    };
    let n = 0;
    const model = createMockModel(() => {
      n++;
      if (n === 1) {
        return {
          content: [
            { type: "tool-call", toolCallId: "c1", toolName: "calendar__list", input: "{}" },
          ],
        };
      }
      return { content: [{ type: "text", text: "Here are your events." }] };
    });

    await appendUser(store, conv, "list my events");
    const engine = new AgentEngine(
      model,
      new StaticToolRouter([calendarTool], () => ({ content: textContent("[]"), isError: false })),
      store,
    );
    await engine.run(config(), SYSTEM, await store.history(conv), [calendarTool]);

    const messages = await store.history(conv);
    expect(messages.some((m) => m.metadata?.synthetic === "connector_skill_injected")).toBe(false);
  });
});
