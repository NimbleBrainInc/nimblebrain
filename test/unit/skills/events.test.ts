/**
 * Phase 2 — `skills.loaded` and `context.assembled` event tests.
 *
 * Two scopes:
 *   1. Engine-level: when `EngineConfig.runMetadata` carries skills/context
 *      payloads, the engine emits exactly one event of each type, ordered
 *      after `run.start` and before `llm.done` / `run.done`.
 *   2. Conversation-store-level: the `EventSourcedConversationStore` maps
 *      these engine events to persisted `ConversationEvent`s via
 *      `mapEngineEvent` (CONVERSATION_EVENT_TYPES).
 *
 * What we don't cover here (intentionally):
 *   - The Layer 3 selection logic itself — covered by select.test.ts.
 *   - Per-conversation-overlay merge — covered by scope-discovery.test.ts.
 *   - Resource integration — covered by skills-source.test.ts.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NoopEventSink } from "../../../src/adapters/noop-events.ts";
import { StaticToolRouter } from "../../../src/adapters/static-router.ts";
import { EventSourcedConversationStore } from "../../../src/conversation/event-sourced-store.ts";
import type {
  ContextAssembledEvent,
  ConversationEvent,
  SkillsLoadedEvent,
} from "../../../src/conversation/types.ts";
import { AgentEngine } from "../../../src/engine/engine.ts";
import { textContent } from "../../../src/engine/content-helpers.ts";
import type {
  EngineConfig,
  EngineEvent,
  EventSink,
  ToolCall,
  ToolResult,
} from "../../../src/engine/types.ts";
import { createEchoModel } from "../../helpers/echo-model.ts";

class CollectingSink implements EventSink {
  events: EngineEvent[] = [];
  emit(event: EngineEvent): void {
    this.events.push(event);
  }
}

function makeConfigWithMetadata(): EngineConfig {
  return {
    model: "test-model",
    maxIterations: 5,
    maxInputTokens: 500_000,
    maxOutputTokens: 16_384,
    runMetadata: {
      skillsLoaded: {
        skills: [
          {
            id: "/work/skills/voice-rules.md",
            layer: 3,
            scope: "platform",
            version: "2026-04-27T00:00:00.000Z",
            tokens: 240,
            loadedBy: "always",
            reason: "loading_strategy: always",
          },
          {
            id: "/work/workspaces/ws_demo/skills/proposal-followup.md",
            layer: 3,
            scope: "workspace",
            version: "2026-04-26T00:00:00.000Z",
            tokens: 890,
            loadedBy: "tool_affinity",
            reason: "applies_to_tools matched synapse-collateral__*",
          },
        ],
        totalTokens: 1130,
      },
      contextAssembled: {
        sources: [
          { kind: "system_prompt", tokens: 1100 },
          { kind: "tool_descriptions", count: 4, tokens: 420 },
          { kind: "skills", count: 2, tokens: 1130 },
          { kind: "history", turns: 0, compacted: false, tokens: 0 },
        ],
        excluded: [],
        totalTokens: 2650,
      },
    },
  };
}

function makeEngine(events: EventSink): AgentEngine {
  return new AgentEngine(
    createEchoModel(),
    new StaticToolRouter([], (_call: ToolCall): ToolResult => ({
      content: textContent(""),
      isError: false,
    })),
    events,
  );
}

describe("engine.runMetadata — skills.loaded + context.assembled emission", () => {
  test("emits both events with the engine's runId, exactly once each", async () => {
    const sink = new CollectingSink();
    const engine = makeEngine(sink);
    await engine.run(
      makeConfigWithMetadata(),
      "system",
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      [],
    );

    const skillsLoadedEvents = sink.events.filter((e) => e.type === "skills.loaded");
    const contextAssembledEvents = sink.events.filter((e) => e.type === "context.assembled");
    expect(skillsLoadedEvents).toHaveLength(1);
    expect(contextAssembledEvents).toHaveLength(1);

    const runStartEvents = sink.events.filter((e) => e.type === "run.start");
    expect(runStartEvents).toHaveLength(1);
    const runId = runStartEvents[0]!.data.runId;
    expect(skillsLoadedEvents[0]!.data.runId).toBe(runId);
    expect(contextAssembledEvents[0]!.data.runId).toBe(runId);
  });

  test("event order: run.start → skills.loaded → context.assembled → run.done", async () => {
    const sink = new CollectingSink();
    const engine = makeEngine(sink);
    await engine.run(
      makeConfigWithMetadata(),
      "system",
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      [],
    );

    const types = sink.events
      .map((e) => e.type)
      .filter((t) =>
        ["run.start", "skills.loaded", "context.assembled", "llm.done", "run.done"].includes(t),
      );
    // run.start must come before skills.loaded; skills.loaded before context.assembled;
    // both must come before any llm.done.
    const idx = (t: string) => types.indexOf(t);
    expect(idx("run.start")).toBeLessThan(idx("skills.loaded"));
    expect(idx("skills.loaded")).toBeLessThan(idx("context.assembled"));
    expect(idx("context.assembled")).toBeLessThan(idx("llm.done"));
    expect(idx("llm.done")).toBeLessThan(idx("run.done"));
  });

  test("payload preserves the runtime-supplied skills + total tokens", async () => {
    const sink = new CollectingSink();
    const engine = makeEngine(sink);
    await engine.run(
      makeConfigWithMetadata(),
      "system",
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      [],
    );

    const event = sink.events.find((e) => e.type === "skills.loaded")!;
    const payload = event.data as unknown as SkillsLoadedEvent;
    expect(payload.skills).toHaveLength(2);
    expect(payload.skills[0]!.loadedBy).toBe("always");
    expect(payload.skills[0]!.scope).toBe("platform");
    expect(payload.skills[1]!.loadedBy).toBe("tool_affinity");
    expect(payload.skills[1]!.reason).toContain("applies_to_tools matched");
    expect(payload.totalTokens).toBe(1130);
  });

  test("context.assembled carries source counts + tokens (no skill content)", async () => {
    const sink = new CollectingSink();
    const engine = makeEngine(sink);
    await engine.run(
      makeConfigWithMetadata(),
      "system",
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      [],
    );

    const event = sink.events.find((e) => e.type === "context.assembled")!;
    const payload = event.data as unknown as ContextAssembledEvent;
    const skillsSource = payload.sources.find((s) => s.kind === "skills");
    expect(skillsSource).toBeDefined();
    expect(skillsSource!.count).toBe(2);
    expect(skillsSource!.tokens).toBe(1130);
    // Snapshot must NOT carry skill body content (the rule).
    expect(JSON.stringify(payload)).not.toContain("voice-rules");
    expect(JSON.stringify(payload)).not.toContain("proposal-followup");
  });

  test("when runMetadata is omitted, no skills.loaded / context.assembled events fire", async () => {
    const sink = new CollectingSink();
    const engine = makeEngine(sink);
    await engine.run(
      {
        model: "test-model",
        maxIterations: 5,
        maxInputTokens: 500_000,
        maxOutputTokens: 16_384,
      },
      "system",
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      [],
    );

    expect(sink.events.filter((e) => e.type === "skills.loaded")).toHaveLength(0);
    expect(sink.events.filter((e) => e.type === "context.assembled")).toHaveLength(0);
  });

  test("empty selection — payload still emitted with empty array + zero total", async () => {
    const sink = new CollectingSink();
    const engine = makeEngine(sink);
    await engine.run(
      {
        model: "test-model",
        maxIterations: 5,
        maxInputTokens: 500_000,
        maxOutputTokens: 16_384,
        runMetadata: {
          skillsLoaded: { skills: [], totalTokens: 0 },
          contextAssembled: { sources: [], excluded: [], totalTokens: 0 },
        },
      },
      "system",
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      [],
    );

    const ev = sink.events.find((e) => e.type === "skills.loaded")!;
    const payload = ev.data as unknown as SkillsLoadedEvent;
    expect(payload.skills).toEqual([]);
    expect(payload.totalTokens).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Persistence — the conversation store maps these engine events to durable
// conv jsonl entries.
// ---------------------------------------------------------------------------

let convDir: string;
let store: EventSourcedConversationStore;

beforeEach(async () => {
  convDir = mkdtempSync(join(tmpdir(), "skills-events-store-"));
  store = new EventSourcedConversationStore({ dir: convDir });
});

afterEach(() => {
  rmSync(convDir, { recursive: true, force: true });
});

async function readEvents(id: string): Promise<ConversationEvent[]> {
  const raw = readFileSync(join(convDir, `${id}.jsonl`), "utf-8");
  return raw
    .split("\n")
    .filter(Boolean)
    .slice(1) // line 1 is conversation metadata
    .map((line) => JSON.parse(line) as ConversationEvent);
}

describe("EventSourcedConversationStore — persistence", () => {
  test("skills.loaded emit is mapped to a ConversationEvent in the conv jsonl", async () => {
    const conv = await store.create();
    store.setActiveConversation(conv.id);

    store.emit({
      type: "skills.loaded",
      data: {
        runId: "run_123",
        skills: [
          {
            id: "/skills/x.md",
            layer: 3,
            scope: "platform",
            version: "2026-01-01T00:00:00.000Z",
            tokens: 100,
            loadedBy: "always",
            reason: "loading_strategy: always",
          },
        ],
        totalTokens: 100,
      },
    });

    const events = await readEvents(conv.id);
    const persisted = events.find((e) => e.type === "skills.loaded") as
      | SkillsLoadedEvent
      | undefined;
    expect(persisted).toBeDefined();
    expect(persisted!.runId).toBe("run_123");
    expect(persisted!.skills).toHaveLength(1);
    expect(persisted!.totalTokens).toBe(100);
    expect(typeof persisted!.ts).toBe("string");
  });

  test("context.assembled persists with sources + total intact", async () => {
    const conv = await store.create();
    store.setActiveConversation(conv.id);

    store.emit({
      type: "context.assembled",
      data: {
        runId: "run_456",
        sources: [
          { kind: "system_prompt", tokens: 500 },
          { kind: "skills", count: 1, tokens: 100 },
        ],
        excluded: [],
        totalTokens: 600,
      },
    });

    const events = await readEvents(conv.id);
    const persisted = events.find((e) => e.type === "context.assembled") as
      | ContextAssembledEvent
      | undefined;
    expect(persisted).toBeDefined();
    expect(persisted!.runId).toBe("run_456");
    expect(persisted!.sources).toHaveLength(2);
    expect(persisted!.totalTokens).toBe(600);
  });

  test("end-to-end: engine emit → store persist preserves shape", async () => {
    const conv = await store.create();
    store.setActiveConversation(conv.id);

    const sink: EventSink = {
      emit(event) {
        // Forward to the store (matches the runtime's MultiEventSink behavior).
        store.emit(event);
      },
    };
    const engine = new AgentEngine(
      createEchoModel(),
      new StaticToolRouter([], () => ({ content: textContent(""), isError: false })),
      sink,
    );
    await engine.run(
      makeConfigWithMetadata(),
      "system",
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      [],
    );

    const events = await readEvents(conv.id);
    const skillsLoaded = events.find((e) => e.type === "skills.loaded") as
      | SkillsLoadedEvent
      | undefined;
    const contextAssembled = events.find((e) => e.type === "context.assembled") as
      | ContextAssembledEvent
      | undefined;
    expect(skillsLoaded).toBeDefined();
    expect(contextAssembled).toBeDefined();
    expect(skillsLoaded!.totalTokens).toBe(1130);
    expect(contextAssembled!.sources.find((s) => s.kind === "skills")!.tokens).toBe(1130);
  });
});

// Silence the helper's unused-import warning — included for clarity.
void NoopEventSink;
