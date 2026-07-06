/**
 * Event-to-message reconstructor.
 *
 * Converts ConversationEvent[] to StoredMessage[] — the core of the
 * "derive at read time" strategy used by history(), the LLM context
 * builder, and the web client.
 */

import type { LanguageModelV3Content, LanguageModelV3ReasoningPart } from "@ai-sdk/provider";
import { boundToolResultForModel } from "../engine/content-helpers.ts";
import { CONNECTOR_SKILL_SYNTHETIC } from "../engine/types.ts";
import { normalizeForReplay } from "../model/inbound-fit.ts";
import { formatConnectorSkillBlock } from "../prompt/compose.ts";
import { estimateCost } from "../usage/cost.ts";
import { compactionSummaryMessages } from "./compaction.ts";
import type {
  ConnectorSkillInjectedEvent,
  ConversationEvent,
  HistoryCompactedEvent,
  LlmResponseEvent,
  RunStartEvent,
  StoredMessage,
  ToolDoneEvent,
  UserContentPart,
  UserMessageEvent,
} from "./types.ts";

/**
 * Per-finishReason placeholder text for empty turns. The marker becomes
 * the assistant message body so the model sees honest context on its
 * next turn ("your last attempt was cut off") and the UI has something
 * to render (the friendly banner is keyed off `metadata.finishReason`).
 */
const TRUNCATION_MARKERS: Record<string, string> = {
  length: "[Previous turn was cut off at the output-token limit before producing visible content.]",
  "content-filter": "[Previous turn was blocked by content filtering.]",
  error: "[Previous turn ended with a model error.]",
  "tool-calls": "[Previous turn declared tool calls but emitted none.]",
  other: "[Previous turn ended without producing content.]",
  stop: "[Previous turn ended without producing content.]",
};

/**
 * Marker for the case where the LLM produced tool calls but the run was
 * cut short before any of them executed (process death, abort, stalled
 * call). Without this placeholder the reconstructed history would skip
 * the turn entirely, producing two adjacent `user` messages on the next
 * append — which Anthropic rejects with
 * `"This model does not support assistant message prefill."`. The marker
 * preserves the role-alternation invariant and tells the model honestly
 * what happened.
 */
const ORPHANED_TOOL_CALLS_MARKER =
  "[Previous turn called tools but tool execution did not complete (the run was cut short before any tool returned). The tool calls were dropped on reload.]";

/**
 * Generic marker for a run scope that emitted no messages at all (no
 * llm.response events between `run.start` and the run's terminator —
 * process died before any model call returned, or some other edge case).
 * Used by the final invariant pass to repair user→user adjacency that
 * the per-run logic didn't catch.
 */
const ABANDONED_RUN_MARKER = "[Previous turn ended without producing any response.]";

/**
 * Parse tool-call input from its persisted form.
 * The AI SDK V3 stream emits tool-call input as a JSON string, which gets
 * written to the JSONL event log as-is. When reconstructing messages for
 * the LLM API, input must be a parsed object (dictionary), not a string.
 */
function parseToolInput(input: unknown): Record<string, unknown> {
  if (typeof input === "string") {
    try {
      return JSON.parse(input) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  if (input && typeof input === "object") return input as Record<string, unknown>;
  return {};
}

/** Mutable conversation metadata derived from append-only metadata events. */
export interface DerivedConversationMeta {
  title: string | null;
}

/**
 * Derive mutable conversation metadata from metadata events.
 * Scans for `metadata.title` events; falls back to `defaults` (from line 1)
 * when none are present.
 *
 * Stage 1 simplification: the previous `metadata.visibility` and
 * `metadata.participants` event types are gone — single-owner only.
 */
export function deriveConversationMeta(
  events: readonly ConversationEvent[],
  defaults: DerivedConversationMeta,
): DerivedConversationMeta {
  let { title } = defaults;

  for (const event of events) {
    if (event.type === "metadata.title") {
      title = event.title;
    }
  }

  return { title };
}

/** Aggregate usage metrics derived from llm.response events. */
export interface UsageMetrics {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  lastModel: string | null;
}

/**
 * Reconstruct StoredMessage[] from a chronological list of ConversationEvents.
 *
 * Algorithm:
 * 1. Walk events in order.
 * 2. `user.message` → emit a user-role StoredMessage.
 * 3. For each `run.start`→`run.done` span, process inner events:
 *    - `llm.response` with tool-call content → assistant message (tool calls in metadata)
 *    - `tool.done` events → tool-result messages (role: "tool")
 *    - `llm.response` with text content → assistant message with text
 * 4. Per-run metrics accumulate into assistant message metadata.
 */
export function reconstructMessages(
  events: readonly ConversationEvent[],
  opts?: { ignoreCompaction?: boolean },
): StoredMessage[] {
  // `ignoreCompaction` reconstructs the FULL verbatim history, replaying every
  // turn and skipping the summary seed entirely. This is the conversation's
  // truth — what the UI/export show and what a fork must copy — as opposed to
  // the default (compacted) projection, which is a model-context optimization.
  // Callers that feed the model want the compacted view; callers that copy or
  // display the conversation want this one.
  if (!opts?.ignoreCompaction) {
    // Honor the most recent compaction: every event before its boundary is
    // represented by the summary seed; turns at or after the boundary replay
    // verbatim. The latest compaction's summary already subsumes any earlier
    // one (it was produced from the prior summary plus the turns since), so
    // only the last one matters.
    let lastCompaction: HistoryCompactedEvent | undefined;
    for (const e of events) {
      if (e.type === "history.compacted") lastCompaction = e;
    }

    if (lastCompaction) {
      const boundary = lastCompaction.compactedThroughTs;
      // Planning is index-based on the reconstructed array; replay is this
      // timestamp filter. They agree as long as event timestamps are monotonic
      // across the boundary. A same-millisecond collision on a pre-boundary
      // event would keep one extra turn verbatim (it also appears in the
      // summary) — a harmless over-keep, never data loss, and absorbed by
      // ensureRoleAlternation below.
      const tail = events.filter((e) => e.type !== "history.compacted" && e.ts >= boundary);
      const messages = [
        ...compactionSummaryMessages(lastCompaction.summary, boundary),
        ...buildMessagesFromEvents(tail),
      ];
      return ensureRoleAlternation(messages);
    }
  }

  // No compaction (or ignored): replay all real turns. `history.compacted`
  // events carry no message of their own, so dropping them is a no-op for the
  // un-compacted log and the correct verbatim view when compaction is ignored.
  const messages = buildMessagesFromEvents(events.filter((e) => e.type !== "history.compacted"));
  return ensureRoleAlternation(messages);
}

/** One executed tool-call block from an llm.response's content array. */
type ToolCallPart = LanguageModelV3Content & { type: "tool-call" };

/** The events collected within a single run span (before message shaping). */
interface RunCollections {
  llmResponses: LlmResponseEvent[];
  toolDones: Map<string, ToolDoneEvent>;
  toolInputs: Map<string, unknown>;
  connectorSkills: ConnectorSkillInjectedEvent[];
}

/** A collected run span plus the index of the first event past it. */
interface CollectedRun extends RunCollections {
  nextIndex: number;
}

function buildMessagesFromEvents(events: readonly ConversationEvent[]): StoredMessage[] {
  const messages: StoredMessage[] = [];

  for (let i = 0; i < events.length; ) {
    const event = events[i];
    if (!event) {
      i++;
      continue;
    }

    if (event.type === "user.message") {
      messages.push(buildUserMessage(event));
      i++;
      continue;
    }

    if (event.type === "run.start") {
      i = appendRunMessages(events, i, messages);
      continue;
    }

    // Skip events outside a run context (shouldn't normally happen)
    i++;
  }

  return messages;
}

/** Build a user-role StoredMessage from a `user.message` event. */
function buildUserMessage(event: UserMessageEvent): StoredMessage {
  return {
    role: "user",
    content: event.content.flatMap(toUserContentPart),
    timestamp: event.ts,
    ...(event.userId ? { userId: event.userId } : {}),
    ...(event.files ? { metadata: { files: event.files } } : {}),
  };
}

/**
 * Whether `inner` is an explicit terminator (`run.done`/`run.error`) for this
 * run. A foreign-run terminal is NOT a terminator — it is skipped like any
 * unrelated event.
 */
function isExplicitRunTerminator(inner: ConversationEvent, runId: string): boolean {
  return (inner.type === "run.done" || inner.type === "run.error") && inner.runId === runId;
}

/** Route one non-terminator run event into the run's collections (mutates `acc`). */
function accumulateRunEvent(inner: ConversationEvent, runId: string, acc: RunCollections): void {
  if (inner.type === "llm.response" && inner.runId === runId) {
    acc.llmResponses.push(inner);
  } else if (inner.type === "tool.done" && inner.runId === runId) {
    acc.toolDones.set(inner.id, inner);
  } else if (inner.type === "tool.start" && inner.runId === runId) {
    if (inner.input !== undefined) {
      acc.toolInputs.set(inner.id, inner.input);
    }
  } else if (inner.type === "connector.skill.injected") {
    acc.connectorSkills.push(inner);
  }
  // tool.progress and other events are skipped for reconstruction
}

/**
 * Collect the events of one run span, walking from `startIndex` until a
 * terminator. `run.done`/`run.error` for this run are consumed (the returned
 * `nextIndex` steps past them). An implicit terminator (`user.message`/
 * `run.start`) is left for the outer loop to reprocess — without this,
 * subsequent user messages get swallowed by the run loop and the conversation
 * appears to skip turns on reload. Running out of events without a terminator
 * still returns what was collected (handles incomplete runs).
 */
function collectRunEvents(
  events: readonly ConversationEvent[],
  startIndex: number,
  runId: string,
): CollectedRun {
  const acc: RunCollections = {
    llmResponses: [],
    toolDones: new Map(),
    toolInputs: new Map(),
    connectorSkills: [],
  };

  let i = startIndex;
  while (i < events.length) {
    const inner = events[i];
    if (!inner) {
      i++;
      continue;
    }

    if (isExplicitRunTerminator(inner, runId)) {
      i++;
      break;
    }

    // Implicit run end: a new user.message or run.start means the previous run
    // never closed cleanly. Break WITHOUT advancing `i` so the outer loop
    // processes the event itself.
    if (inner.type === "user.message" || inner.type === "run.start") {
      break;
    }

    accumulateRunEvent(inner, runId, acc);
    i++;
  }

  return { ...acc, nextIndex: i };
}

/**
 * Process a `run.start` span beginning at `runStartIndex`: collect its inner
 * events, emit the run's assistant/tool/connector messages into `messages`, and
 * return the index of the first event past the run.
 */
function appendRunMessages(
  events: readonly ConversationEvent[],
  runStartIndex: number,
  messages: StoredMessage[],
): number {
  const runStart = events[runStartIndex] as RunStartEvent;
  const run = collectRunEvents(events, runStartIndex + 1, runStart.runId);

  // Faithful replay shape: each llm.response becomes ONE assistant message whose
  // content array preserves the provider's original block ordering — text,
  // reasoning, and executed tool-calls in the exact order Anthropic returned
  // them. Unexecuted (orphaned) tool-calls are filtered out (the API rejects
  // orphans), but no other reordering happens.
  //
  // Why ordering matters: Anthropic validates the LATEST assistant message
  // byte-for-byte ("thinking blocks in the latest assistant message cannot be
  // modified"). Grouping content by category (reasoning / text / tool-call) and
  // emitting them as separate messages is a 400 on multi-iteration runs with
  // thinking enabled. The chat UI consumes its own projection from
  // src/bundles/conversations/src/jsonl-reader.ts; this function is the
  // LLM-replay projection.
  for (const llmResp of run.llmResponses) {
    for (const msg of messagesForLlmResponse(
      llmResp,
      run.toolDones,
      run.toolInputs,
      run.llmResponses.length,
    )) {
      messages.push(msg);
    }
  }

  // Connector overlays surfaced during this run. Append after the run's real
  // turns as synthetic assistant messages — the Anthropic provider merges them
  // into the preceding assistant block, and a user turn always follows on
  // replay, so they never become a trailing prefill. The `<connector-skill>`
  // containment is the per-prompt injection defense; `metadata.synthetic`/
  // `skill` let the engine detect an already-surfaced overlay and never
  // re-inject it.
  //
  // Provider note: this produces two consecutive assistant messages (the run's
  // final assistant text, then this one). Anthropic — the default, tested
  // provider, and the only one overlays ship enabled-for — merges consecutive
  // same-role messages, so the pair coalesces cleanly. A non-Anthropic provider
  // whose SDK conversion does NOT merge could reject the pair; verify
  // provider-side coalescing before enabling overlays on a non-Anthropic
  // default.
  for (const cs of run.connectorSkills) {
    messages.push(buildConnectorSkillMessage(cs));
  }

  return run.nextIndex;
}

/** Assistant-message metadata shared by every message derived from one llm.response. */
function baseResponseMetadata(llmResp: LlmResponseEvent, iterations: number) {
  return {
    usage: llmResp.usage,
    model: llmResp.model,
    llmMs: llmResp.llmMs,
    iterations,
    ...(llmResp.finishReason ? { finishReason: llmResp.finishReason } : {}),
  };
}

/**
 * Tool-call metadata for the chat UI (input/output rendering). Carried on the
 * assistant message; not part of the LLM replay.
 */
function buildToolCallMeta(
  tc: ToolCallPart,
  toolDones: Map<string, ToolDoneEvent>,
  toolInputs: Map<string, unknown>,
) {
  const done = toolDones.get(tc.toolCallId)!;
  return {
    id: tc.toolCallId,
    name: tc.toolName,
    input: (toolInputs.get(tc.toolCallId) ?? parseToolInput(tc.input)) as Record<string, unknown>,
    output: done.output ?? "",
    ok: done.ok ?? true,
    ms: done.ms ?? 0,
  };
}

/**
 * Build the tool-result message for one executed tool-call. Replays the BOUNDED
 * model view, not the full output: new events carry `modelOutput` (exactly what
 * the model saw live); legacy events without it are bounded here at read time.
 * This stops large tool results from re-entering the prompt at full size on
 * every subsequent run — the primary driver of runaway context growth and
 * cache-write churn.
 */
function buildToolResultMessage(
  tc: ToolCallPart,
  toolDones: Map<string, ToolDoneEvent>,
  fallbackTs: string,
): StoredMessage {
  const done = toolDones.get(tc.toolCallId)!;
  return {
    role: "tool",
    content: [
      {
        type: "tool-result" as const,
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        output: {
          type: "text",
          value: done.modelOutput ?? boundToolResultForModel(done.output ?? ""),
        },
      },
    ],
    timestamp: done.ts ?? fallbackTs,
  };
}

/**
 * Step 4a — replay honesty. When an llm.response emitted no real content,
 * decide whether an honesty placeholder is needed and build it. Reasons a turn
 * has no real content:
 *   1. The turn produced reasoning only (extended thinking that ran out of
 *      budget before any visible content).
 *   2. The turn produced literally nothing AND the model didn't end cleanly
 *      (length / content_filter / error).
 *   3. The turn produced tool calls that NEVER executed (process death, abort,
 *      stalled call). Without a placeholder, the next user message lands
 *      directly after the prior user message and Anthropic rejects the
 *      conversation on reload with "model does not support assistant message
 *      prefill".
 *
 * Reasoning content is ONLY usable as the placeholder body when it carries
 * provider metadata that lets it round-trip (e.g. Anthropic's signature).
 * Without that, the AI SDK provider drops the block on the next prompt →
 * content: [] → API 400. For the orphaned-tool-calls case we always use marker
 * text: the reasoning may end mid-tool-call-intent, and the marker is the
 * load-bearing signal to the model on retry.
 *
 * When a turn has both signed and unsigned reasoning blocks, only the signed
 * ones are kept in the placeholder — the reconstructed message accurately
 * reflects what the next call will actually send (the AI SDK provider drops
 * unsigned reasoning with an "unsupported reasoning metadata" warning).
 *
 * Returns null when no placeholder should be emitted.
 */
function buildPlaceholderMessage(
  llmResp: LlmResponseEvent,
  replayContent: ReturnType<typeof normalizeForReplay>,
  hasOrphanedToolCalls: boolean,
  metadata: ReturnType<typeof baseResponseMetadata>,
): StoredMessage | null {
  const reasoningWithMeta = replayContent.filter(
    (c): c is LanguageModelV3ReasoningPart => c.type === "reasoning" && c.providerOptions != null,
  );
  const hasAbnormalFinish = llmResp.finishReason != null && llmResp.finishReason !== "stop";
  const hasAnyReasoning = replayContent.some((c) => c.type === "reasoning");
  const shouldEmitPlaceholder = hasOrphanedToolCalls || hasAnyReasoning || hasAbnormalFinish;

  if (!shouldEmitPlaceholder) return null;

  const placeholderText = hasOrphanedToolCalls
    ? ORPHANED_TOOL_CALLS_MARKER
    : (TRUNCATION_MARKERS[llmResp.finishReason ?? "other"] ?? TRUNCATION_MARKERS.other!);
  const reasoningRoundTrips = !hasOrphanedToolCalls && reasoningWithMeta.length > 0;
  // Inferred type: ReasoningPart[] | [{type:"text",text:string}]. Both are
  // assignable to the assistant variant's content union; an explicit
  // `LanguageModelV3Content[]` annotation here is the wrong type (stream-side,
  // doesn't include `providerOptions`).
  const placeholderContent = reasoningRoundTrips
    ? reasoningWithMeta
    : [{ type: "text" as const, text: placeholderText }];

  return {
    role: "assistant",
    content: placeholderContent,
    timestamp: llmResp.ts,
    metadata,
  };
}

/**
 * Build the messages for one llm.response: on the normal path, one assistant
 * message (original block order, orphaned tool-calls filtered out) followed by
 * one tool-result message per executed tool-call (so role alternation runs
 * assistant→tool→tool→… cleanly). When the turn produced no real content,
 * returns a single honesty placeholder (or nothing). See buildPlaceholderMessage.
 */
function messagesForLlmResponse(
  llmResp: LlmResponseEvent,
  toolDones: Map<string, ToolDoneEvent>,
  toolInputs: Map<string, unknown>,
  iterations: number,
): StoredMessage[] {
  const executedToolCalls = llmResp.content.filter(
    (c): c is ToolCallPart => c.type === "tool-call" && toolDones.has(c.toolCallId),
  );
  const totalToolCalls = llmResp.content.filter((c) => c.type === "tool-call").length;
  const hasOrphanedToolCalls = totalToolCalls > executedToolCalls.length;

  // Filter out orphaned tool-calls; preserve all other blocks in their original
  // order. normalizeForReplay then handles the stream→prompt shape mismatches
  // (reasoning providerMetadata→providerOptions, tool-call input string→object).
  const replayContent = normalizeForReplay(
    llmResp.content.filter((c) => c.type !== "tool-call" || toolDones.has(c.toolCallId)),
  );

  const metadata = baseResponseMetadata(llmResp, iterations);

  const hasRealContent =
    replayContent.some((c) => c.type === "text") || executedToolCalls.length > 0;

  if (!hasRealContent) {
    // Orphaned tool-calls (if any) were already filtered out of replayContent;
    // text alongside them would count as real content above, so reaching here
    // means the turn is genuinely empty.
    const placeholder = buildPlaceholderMessage(
      llmResp,
      replayContent,
      hasOrphanedToolCalls,
      metadata,
    );
    return placeholder ? [placeholder] : [];
  }

  const toolCallsMeta = executedToolCalls.map((tc) => buildToolCallMeta(tc, toolDones, toolInputs));
  const messages: StoredMessage[] = [
    {
      role: "assistant",
      content: replayContent,
      timestamp: llmResp.ts,
      metadata: {
        ...metadata,
        ...(toolCallsMeta.length > 0 ? { toolCalls: toolCallsMeta } : {}),
      },
    },
  ];

  for (const tc of executedToolCalls) {
    messages.push(buildToolResultMessage(tc, toolDones, llmResp.ts));
  }

  return messages;
}

/**
 * Synthesize the assistant message for a connector-skill overlay: the overlay
 * body wrapped in `<connector-skill>` containment, tagged with
 * `metadata.synthetic`/`skill` so the engine detects an already-surfaced
 * overlay and never re-injects it.
 */
function buildConnectorSkillMessage(cs: ConnectorSkillInjectedEvent): StoredMessage {
  return {
    role: "assistant",
    content: [
      { type: "text", text: formatConnectorSkillBlock(cs.skillName, cs.scope, cs.skillBody) },
    ],
    timestamp: cs.ts,
    metadata: { synthetic: CONNECTOR_SKILL_SYNTHETIC, skill: cs.skillName },
  };
}

/**
 * Defense-in-depth invariant pass: ensure the reconstructed message list
 * never has two adjacent `user` messages. Anthropic rejects such a
 * sequence on the next append with
 * `"This model does not support assistant message prefill."`.
 *
 * The per-run step-4a handler covers the cases we've seen in production
 * (orphaned tool-calls, length-truncated empty turns). This pass catches
 * anything we haven't enumerated — e.g. a run scope that emitted zero
 * `llm.response` events because the process died before the model
 * returned. Cheap O(n) scan; never fires on healthy data.
 */
function ensureRoleAlternation(messages: StoredMessage[]): StoredMessage[] {
  if (messages.length < 2) return messages;

  const result: StoredMessage[] = [];
  for (const msg of messages) {
    const prev = result[result.length - 1];
    if (prev?.role === "user" && msg.role === "user") {
      // Place the synthetic turn 1ms after the previous user message so it
      // sorts between the two user turns instead of collapsing onto the
      // next user's timestamp (the UI sorts strictly by `timestamp`, and a
      // tied-timestamp placeholder rendered after the user it precedes
      // looks like the user replied to themselves). Clamp to the next
      // message's timestamp when it's already <1ms ahead — clock skew or
      // tight bursts can produce equal/backwards timestamps.
      const prevTime = Date.parse(prev.timestamp);
      const msgTime = Date.parse(msg.timestamp);
      const placeholderTs =
        Number.isFinite(prevTime) && Number.isFinite(msgTime)
          ? new Date(Math.min(prevTime + 1, msgTime)).toISOString()
          : msg.timestamp;
      result.push({
        role: "assistant",
        content: [{ type: "text" as const, text: ABANDONED_RUN_MARKER }],
        timestamp: placeholderTs,
        // Carry minimal metadata so the chat UI can render the same
        // truncation banner it uses for length / content-filter cases.
        // `finishReason: "other"` is the closest enum value — there was no
        // real LLM call, so the categorical reasons (length, error, etc.)
        // don't apply.
        metadata: {
          finishReason: "other",
          usage: { inputTokens: 0, outputTokens: 0 },
          llmMs: 0,
          iterations: 0,
        },
      });
    }
    result.push(msg);
  }
  return result;
}

/**
 * Derive aggregate usage metrics from a list of conversation events.
 * Scans all `llm.response` events and sums tokens, computes total cost.
 */
export function deriveUsageMetrics(events: readonly ConversationEvent[]): UsageMetrics {
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;
  let lastModel: string | null = null;

  for (const event of events) {
    // Pre-unification events stored token counts as flat fields and have
    // no `usage` struct. We deliberately do not migrate them — they
    // contribute zero to derived totals — but we must not crash on them.
    if (event.type === "llm.response" && event.usage) {
      totalInputTokens += event.usage.inputTokens;
      totalOutputTokens += event.usage.outputTokens;
      lastModel = event.model;
      totalCostUsd += estimateCost(event.model, event.usage);
    }
  }

  return { totalInputTokens, totalOutputTokens, totalCostUsd, lastModel };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Pass-through projection for user-message content. Preserves text and
 * MCP `resource_link` blocks; drops anything else (defensive — the
 * persisted shape is `UserContentPart[]`, but JSONL is forgiving and a
 * future schema migration shouldn't crash old logs).
 */
function toUserContentPart(c: UserContentPart): UserContentPart[] {
  if (c.type === "text") return [{ type: "text", text: c.text }];
  if (c.type === "resource_link") {
    return [
      {
        type: "resource_link",
        uri: c.uri,
        mimeType: c.mimeType,
        name: c.name,
      },
    ];
  }
  return [];
}
