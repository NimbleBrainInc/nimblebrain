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
const SECOND_BODY = "Keep the subject line under ten words.";
const SEND_TOOL: ToolSchema = { name: "gmail__send", description: "Send an email", inputSchema: {} };

function config(): EngineConfig {
  return {
    model: "test-model",
    maxIterations: 10,
    maxInputTokens: 500_000,
    maxOutputTokens: 16_384,
    connectorSkillCandidates: [
      { name: "gmail", body: OVERLAY_BODY, scope: "connector", toolAffinity: ["gmail__*"] },
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

function containsOverlay(m: LanguageModelV3Message): boolean {
  return (
    m.role !== "system" &&
    Array.isArray(m.content) &&
    m.content.some((p) => p.type === "text" && p.text.includes(OVERLAY_BODY))
  );
}

function messagesContainOverlay(prompt: LanguageModelV3Message[]): boolean {
  return prompt.some(containsOverlay);
}

describe("connector-skill surface-once (engine + event store)", () => {
  it("delivers the overlay in the SAME run, before the model's next action", async () => {
    // The point of surfacing on first use: the guidance has to arrive before
    // the calls it governs. It used to be emitted as an event only, so the
    // body first appeared on the NEXT turn's rehydration — after the writes it
    // was meant to govern, and never at all for a conversation that ends in
    // one run.
    const store = freshStore();
    const conv = await store.create({ ownerId: "u1" });
    store.setActiveConversation(conv.id);

    await appendUser(store, conv, "send an email to a@b.com");
    const rec = recordingModel(sendThenAnswer());
    const engine = new AgentEngine(rec.model, router(), store);
    await engine.run(config(), SYSTEM, await store.history(conv), [SEND_TOOL]);

    // Two model calls: the one that emitted the tool call, then the one after
    // the tool ran. The overlay fired during the first, so the second must
    // already carry it.
    expect(rec.calls.length).toBeGreaterThanOrEqual(2);
    expect(messagesContainOverlay(rec.calls[0]!.prompt)).toBe(false);
    expect(messagesContainOverlay(rec.calls[1]!.prompt)).toBe(true);
    // Still never the cached system prefix, on any call.
    for (const call of rec.calls) {
      expect(systemContent(call.prompt)).not.toContain(OVERLAY_BODY);
    }
  });

  it("puts the overlay in the same position live and on replay", async () => {
    // The invariant the same-run delivery rests on. The live run appends the
    // overlay after the triggering iteration's tool results; reconstruction
    // derives that position from event order. If the two disagreed, the next
    // turn would rebuild a history the model never actually ran against — a
    // silent prefix divergence, not a visible failure.
    const store = freshStore();
    const conv = await store.create({ ownerId: "u1" });
    store.setActiveConversation(conv.id);

    await appendUser(store, conv, "send an email to a@b.com");
    const rec = recordingModel(sendThenAnswer());
    const engine = new AgentEngine(rec.model, router(), store);
    await engine.run(config(), SYSTEM, await store.history(conv), [SEND_TOOL]);

    // What the model actually saw on its final call, minus the system message.
    const liveShape = rec.calls[rec.calls.length - 1]!.prompt.filter((m) => m.role !== "system").map(
      (m) => (containsOverlay(m) ? "OVERLAY" : m.role),
    );
    // What replay reconstructs from the recorded events. It runs one message
    // longer — it includes the final assistant response, which had not been
    // produced yet when that last call was sent — so the live shape is a
    // PREFIX of it. Prefix equality is also the property that matters: it is
    // the cached span the next turn reuses.
    const replayShape = (await store.history(conv)).map((m) =>
      containsOverlay(m as unknown as LanguageModelV3Message) ? "OVERLAY" : m.role,
    );

    expect(liveShape).toContain("OVERLAY");
    expect(replayShape.slice(0, liveShape.length)).toEqual(liveShape);
    expect(replayShape.length).toBe(liveShape.length + 1);
  });

  it("never ends a model call on an assistant message it would be asked to continue", async () => {
    // A trailing assistant message is an Anthropic prefill: the model continues
    // the block instead of starting its turn, and that continuation is its real
    // user-visible output. The overlay lands last in the run that triggers it,
    // so its role decides whether that happens.
    const store = freshStore();
    const conv = await store.create({ ownerId: "u1" });
    store.setActiveConversation(conv.id);

    await appendUser(store, conv, "send an email to a@b.com");
    const rec = recordingModel(sendThenAnswer());
    await new AgentEngine(rec.model, router(), store).run(
      config(),
      SYSTEM,
      await store.history(conv),
      [SEND_TOOL],
    );

    for (const call of rec.calls) {
      const last = call.prompt[call.prompt.length - 1]!;
      expect(last.role).not.toBe("assistant");
    }
  });

  it("agrees live-vs-replay when two overlays fire in one iteration", async () => {
    // Two candidates match the same tool, so both surface in one iteration and
    // land adjacent. Replay runs a role-alternation repair pass that the live
    // path does not, so this is where the two could silently drift apart.
    const store = freshStore();
    const conv = await store.create({ ownerId: "u1" });
    store.setActiveConversation(conv.id);

    const twoCandidates: EngineConfig = {
      ...config(),
      connectorSkillCandidates: [
        { name: "gmail", body: OVERLAY_BODY, scope: "connector", toolAffinity: ["gmail__*"] },
        { name: "gmail-etiquette", body: SECOND_BODY, scope: "connector", toolAffinity: ["gmail__*"] },
      ],
    };

    await appendUser(store, conv, "send an email to a@b.com");
    const rec = recordingModel(sendThenAnswer());
    await new AgentEngine(rec.model, router(), store).run(
      twoCandidates,
      SYSTEM,
      await store.history(conv),
      [SEND_TOOL],
    );

    const liveShape = rec.calls[rec.calls.length - 1]!.prompt
      .filter((m) => m.role !== "system")
      .map((m) => m.role);
    const replayShape = (await store.history(conv)).map((m) => m.role);

    expect(replayShape.slice(0, liveShape.length)).toEqual(liveShape);
    // Both bodies actually reached the model.
    const lastPrompt = rec.calls[rec.calls.length - 1]!.prompt;
    expect(messagesContainOverlay(lastPrompt)).toBe(true);
    expect(
      lastPrompt.some(
        (m) =>
          Array.isArray(m.content) &&
          m.content.some((p) => p.type === "text" && p.text.includes(SECOND_BODY)),
      ),
    ).toBe(true);
  });

  it("surfaces the overlay into history once, never into the system prefix, and holds across turns", async () => {
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
    expect(synthetic!.role).toBe("user");
    expect(synthetic!.metadata?.skill).toBe("gmail");

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
