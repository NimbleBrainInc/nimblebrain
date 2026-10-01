/**
 * Typed engine-event builders and readers for tests.
 *
 * Every event a test builds goes through `engineEvent`, so its payload is
 * checked against the catalog (`EngineEventPayloads`) exactly as an emit site
 * is. The `*Payload` builders fill a complete payload with neutral values and
 * take the fields a test cares about as overrides.
 */

import type {
  EngineEventPayloads,
  LlmDonePayload,
  RunStartPayload,
  ToolDonePayload,
} from "../../src/engine/schemas/events.ts";
import type { EngineEvent, EngineEventOf, EngineEventType } from "../../src/engine/types.ts";

/** An event of type `K` with its catalog payload. */
export function engineEvent<K extends EngineEventType>(
  type: K,
  data: EngineEventPayloads[K],
): EngineEventOf<K> {
  return { type, data } as EngineEventOf<K>;
}

/** The payloads of every collected event of type `K`, in order. */
export function payloadsOf<K extends EngineEventType>(
  events: readonly EngineEvent[],
  type: K,
): EngineEventPayloads[K][] {
  return events
    .filter((e): e is EngineEventOf<K> => e.type === type)
    .map((e) => e.data as EngineEventPayloads[K]);
}

/** The payload of the first collected event of type `K`, or undefined. */
export function firstPayloadOf<K extends EngineEventType>(
  events: readonly EngineEvent[],
  type: K,
): EngineEventPayloads[K] | undefined {
  return payloadsOf(events, type)[0];
}

/** A complete `run.start` payload. */
export function runStartPayload(overrides: Partial<RunStartPayload> = {}): RunStartPayload {
  return {
    runId: "run_1",
    model: "test-model",
    maxIterations: 10,
    maxOutputTokens: 4096,
    maxInputTokens: 100_000,
    toolCount: 0,
    toolNames: [],
    systemPromptLength: 0,
    systemPrompt: "",
    messageCount: 1,
    messageRoles: ["user"],
    estimatedMessageTokens: 0,
    ...overrides,
  };
}

/** A complete `llm.done` payload. */
export function llmDonePayload(overrides: Partial<LlmDonePayload> = {}): LlmDonePayload {
  return {
    runId: "run_1",
    model: "test-model",
    content: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    llmMs: 0,
    estimatedInputTokens: 0,
    finishReason: "stop",
    ...overrides,
  };
}

/** A complete `tool.done` payload. */
export function toolDonePayload(overrides: Partial<ToolDonePayload> = {}): ToolDonePayload {
  return {
    runId: "run_1",
    name: "test__tool",
    id: "call_1",
    ok: true,
    ms: 0,
    output: "",
    ...overrides,
  };
}
