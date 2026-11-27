/**
 * What a conversation stores: the events an engine event and a stored message
 * persist as. The kernel writes a conversation only through the conversations
 * contract (`contract-store.ts`), and these are the events it appends.
 */

import type {
  ConnectorSkillInjectedPayload,
  EngineEventPayloads,
  LlmDonePayload,
  RunDonePayload,
  RunErrorPayload,
  RunStartPayload,
  SkillActivatedPayload,
  SkillSuppressionPayload,
  ToolDonePayload,
  ToolProgressPayload,
  ToolStartPayload,
} from "../engine/schemas/events.ts";
import type { EngineEvent } from "../engine/types.ts";
import type {
  ConnectorSkillInjectedEvent,
  ContextAssembledEvent,
  ConversationEvent,
  LlmResponseEvent,
  RunDoneEvent,
  RunErrorEvent,
  RunStartEvent,
  SkillActivatedEvent,
  SkillSuppressionEvent,
  SkillsLoadedEvent,
  StoredMessage,
  ToolDoneEvent,
  ToolStartEvent,
} from "./types.ts";

/** Map an engine `llm.done` to a persisted `llm.response`. */
function mapLlmDone(ts: string, d: LlmDonePayload): LlmResponseEvent {
  return {
    ts,
    type: "llm.response",
    runId: d.runId,
    model: d.model,
    content: d.content,
    usage: d.usage,
    llmMs: d.llmMs,
    finishReason: d.finishReason,
    // The engine omits an empty raw reason, so a present string is a real one.
    ...(d.finishReasonRaw !== undefined ? { finishReasonRaw: d.finishReasonRaw } : {}),
  };
}

/** Map an engine `skill.suppression` to a persisted event, or null when unnamed. */
function mapSkillSuppression(ts: string, d: SkillSuppressionPayload): ConversationEvent | null {
  if (!d.skillName) return null;
  const e: SkillSuppressionEvent = {
    ts,
    type: "skill.suppression",
    runId: d.runId,
    skillName: d.skillName,
    suppressed: d.suppressed,
  };
  return e;
}

/** Conversation events that are persisted (non-workspace, non-ephemeral). */
const CONVERSATION_EVENT_TYPES = new Set([
  "run.start",
  "llm.done",
  "tool.start",
  "tool.done",
  "tool.progress",
  "run.done",
  "run.error",
  "execution.bound",
  "skills.loaded",
  "context.assembled",
  "connector.skill.injected",
  "skill.activated",
  "skill.not_delivered",
  "skill.suppression",
]);

/**
 * The finish reason for an `llm.response` synthesized from a stored assistant
 * message: the one its metadata recorded, else what its content implies — a
 * message carrying tool calls ended to run them, anything else ended normally.
 * `messageEvents` goes through this so no `llm.response` is written without one.
 */
function synthesizedFinishReason(msg: StoredMessage): LlmResponseEvent["finishReason"] {
  if (msg.metadata?.finishReason) return msg.metadata.finishReason;
  const content = Array.isArray(msg.content) ? msg.content : [];
  return content.some((c) => c.type === "tool-call") ? "tool-calls" : "stop";
}

// ---------------------------------------------------------------------------
// Engine event → conversation event mappers
// ---------------------------------------------------------------------------

/** Map an engine `run.start` to a persisted `run.start` event. */
function mapRunStart(ts: string, d: RunStartPayload, debug: boolean): RunStartEvent {
  return {
    ts,
    type: "run.start",
    runId: d.runId,
    model: d.model,
    ...(debug && d.systemPrompt ? { systemPrompt: d.systemPrompt } : {}),
    ...(debug ? { messages: d.messageRoles, toolSchemas: d.toolNames } : {}),
  };
}

/** Map an engine `tool.start` to a persisted `tool.start` event. */
function mapToolStart(ts: string, d: ToolStartPayload, debug: boolean): ToolStartEvent {
  return {
    ts,
    type: "tool.start",
    runId: d.runId,
    name: d.name,
    id: d.id,
    ...(debug ? { input: d.input } : {}),
  };
}

/** Map an engine `tool.done` to a persisted `tool.done` event. */
function mapToolDone(ts: string, d: ToolDonePayload): ToolDoneEvent {
  return {
    ts,
    type: "tool.done",
    runId: d.runId,
    name: d.name,
    id: d.id,
    ok: d.ok,
    ms: d.ms,
    // Always persisted: history reconstruction reads it.
    output: d.output,
    // Bounded model-view text, present only when the result exceeded the
    // model-context bound. Replay uses it verbatim so the replayed prompt
    // matches what the model saw live. See boundToolResultForModel.
    ...(d.modelOutput !== undefined ? { modelOutput: d.modelOutput } : {}),
    // UI-binding resource references, persisted so a reopened conversation
    // rehydrates its artifact viewers (the panel a tool's `artifact://` resource
    // link renders into). They are small references, not bytes — the body is
    // fetched on view.
    ...(d.resourceUri !== undefined ? { resourceUri: d.resourceUri } : {}),
    ...(d.resourceLinks && d.resourceLinks.length > 0 ? { resourceLinks: d.resourceLinks } : {}),
    ...(d.held ? { held: d.held } : {}),
  };
}

/** Map an engine `tool.progress` to a persisted `tool.progress` event. */
function mapToolProgress(ts: string, d: ToolProgressPayload): ConversationEvent {
  return { ts, type: "tool.progress", runId: d.runId, id: d.id, message: d.message };
}

/** Map an engine `run.done` to a persisted `run.done` event. */
function mapRunDone(ts: string, d: RunDonePayload): RunDoneEvent {
  // The engine's stopReason, verbatim: it derives the real reason from the
  // final LLM call's finishReason, so length-truncation and other model-driven
  // exits are recorded as themselves.
  return { ts, type: "run.done", runId: d.runId, stopReason: d.stopReason, totalMs: d.totalMs };
}

/** Map an engine `run.error` to a persisted `run.error` event. */
function mapRunError(ts: string, d: RunErrorPayload): RunErrorEvent {
  return { ts, type: "run.error", runId: d.runId, error: d.error, errorType: d.type };
}

/** Map an engine `skills.loaded` to a persisted `skills.loaded` event. */
function mapSkillsLoaded(ts: string, d: EngineEventPayloads["skills.loaded"]): SkillsLoadedEvent {
  return {
    ts,
    type: "skills.loaded",
    runId: d.runId,
    skills: d.skills,
    totalTokens: d.totalTokens,
  };
}

/** Map an engine `context.assembled` to a persisted `context.assembled` event. */
function mapContextAssembled(
  ts: string,
  d: EngineEventPayloads["context.assembled"],
): ContextAssembledEvent {
  return {
    ts,
    type: "context.assembled",
    runId: d.runId,
    sources: d.sources,
    excluded: d.excluded,
    totalTokens: d.totalTokens,
    ...(d.modelMaxContext !== undefined ? { modelMaxContext: d.modelMaxContext } : {}),
    ...(d.headroomTokens !== undefined ? { headroomTokens: d.headroomTokens } : {}),
  };
}

/** Map an engine `connector.skill.injected` to a persisted event, or null when the body is empty. */
function mapConnectorSkillInjected(
  ts: string,
  d: ConnectorSkillInjectedPayload,
): ConversationEvent | null {
  // The body is persisted verbatim; the reconstructor wraps it in
  // `<connector-skill>` containment when it rebuilds the message. An empty
  // body would surface an empty guidance block, so drop the event rather than
  // persist a useless one.
  if (!d.skillBody) return null;
  const e: ConnectorSkillInjectedEvent = {
    ts,
    type: "connector.skill.injected",
    toolName: d.toolName,
    skillName: d.skillName,
    skillBody: d.skillBody,
    scope: d.scope,
    ...(d.heldToolCallId !== undefined ? { heldToolCallId: d.heldToolCallId } : {}),
  };
  return e;
}

/** Map an engine `skill.activated` to a persisted event, or null when the name is empty. */
function mapSkillActivated(ts: string, d: SkillActivatedPayload): ConversationEvent | null {
  // A nameless activation can neither dedup nor stamp a reconstruction
  // marker, so drop it rather than persist a useless record.
  if (!d.skillName) return null;
  const e: SkillActivatedEvent = {
    ts,
    type: "skill.activated",
    runId: d.runId,
    toolCallId: d.toolCallId,
    skillName: d.skillName,
    scope: d.scope,
    tokens: d.tokens,
  };
  return e;
}

/**
 * The conversation event an engine event persists as, or null when it persists
 * as none. `debug` keeps the full request data (`logging.level: "debug"`).
 * The kernel maps every engine event through this one function.
 */
export function conversationEventOf(event: EngineEvent, debug: boolean): ConversationEvent | null {
  if (!CONVERSATION_EVENT_TYPES.has(event.type)) return null;
  const ts = new Date().toISOString();
  switch (event.type) {
    case "run.start":
      return mapRunStart(ts, event.data, debug);
    case "llm.done":
      return mapLlmDone(ts, event.data);
    case "tool.start":
      return mapToolStart(ts, event.data, debug);
    case "tool.done":
      return mapToolDone(ts, event.data);
    case "tool.progress":
      return mapToolProgress(ts, event.data);
    case "run.done":
      return mapRunDone(ts, event.data);
    case "run.error":
      return mapRunError(ts, event.data);
    case "execution.bound":
      return { ts, type: "execution.bound", ...event.data };
    case "skills.loaded":
      return mapSkillsLoaded(ts, event.data);
    case "context.assembled":
      return mapContextAssembled(ts, event.data);
    case "connector.skill.injected":
      return mapConnectorSkillInjected(ts, event.data);
    case "skill.activated":
      return mapSkillActivated(ts, event.data);
    case "skill.not_delivered":
      return { ts, type: "skill.not_delivered", ...event.data };
    case "skill.suppression":
      return mapSkillSuppression(ts, event.data);
    default:
      return null;
  }
}

/**
 * The events a stored message persists as: a user message is one
 * `user.message`, carrying its attachments' references (`files`); an assistant message with metadata is a synthetic run
 * (`run.start`, `llm.response`, `run.done`); anything else is none.
 */
export function messageEvents(message: StoredMessage): ConversationEvent[] {
  if (message.role === "user") {
    return [
      {
        ts: message.timestamp,
        type: "user.message",
        content: message.content as ConversationEvent extends { content: infer C } ? C : never,
        ...(message.userId ? { userId: message.userId } : {}),
        ...(message.metadata?.files?.length ? { files: message.metadata.files } : {}),
        ...(message.metadata?.pluginRequestAnswer
          ? { pluginRequestAnswer: message.metadata.pluginRequestAnswer }
          : {}),
      } as ConversationEvent,
    ];
  }
  if (message.role !== "assistant" || !message.metadata) return [];
  const runId = `append_${Date.now()}`;
  const model = message.metadata.model ?? "unknown";
  const llmResponse: LlmResponseEvent = {
    ts: message.timestamp,
    type: "llm.response",
    runId,
    model,
    content: message.content as LlmResponseEvent["content"],
    usage: message.metadata.usage ?? { inputTokens: 0, outputTokens: 0 },
    llmMs: message.metadata.llmMs ?? 0,
    finishReason: synthesizedFinishReason(message),
  };
  return [
    { ts: message.timestamp, type: "run.start", runId, model } as ConversationEvent,
    llmResponse,
    {
      ts: message.timestamp,
      type: "run.done",
      runId,
      stopReason: "complete",
      totalMs: message.metadata.llmMs ?? 0,
    } as ConversationEvent,
  ];
}
