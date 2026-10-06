/**
 * Handler for conversations__fork tool.
 *
 * Fork a conversation at a message index, creating a new event-format JSONL
 * file with the turns copied from the source up to that point, written as the
 * events that read back to them. Token counts are recalculated from the copied
 * messages only.
 */

import { rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ConversationsForkOutput } from "../../schemas/conversations.ts";
import type { AccessContext, ConversationIndex } from "../index-cache.ts";
import type { DisplayMessage, DisplayToolCall, DisplayUsage } from "../jsonl-reader.ts";
import { readConversation } from "../jsonl-reader.ts";

export interface ForkInput {
  id: string;
  atMessage?: number;
}

/** Recalculated token totals across copied assistant messages. */
interface CopiedTotals {
  totalInputTokens: number;
  totalOutputTokens: number;
  lastModel: string | null;
}

/** Sum input/output tokens and track the last model across copied assistant messages. */
function sumCopiedUsage(messages: DisplayMessage[]): CopiedTotals {
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let lastModel: string | null = null;
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.usage) {
      totalInputTokens += msg.usage.inputTokens;
      totalOutputTokens += msg.usage.outputTokens;
      lastModel = msg.usage.model || lastModel;
    }
  }
  return { totalInputTokens, totalOutputTokens, lastModel };
}

/** Last copied message's timestamp, falling back to `now` when nothing was copied. */
function resolveUpdatedAt(messages: DisplayMessage[], now: string): string {
  if (messages.length === 0) return now;
  return messages[messages.length - 1]?.timestamp ?? now;
}

/** A JSONL event line, as the runtime's event-sourced store writes it. */
type EventLine = Record<string, unknown>;

/** The blocks one `llm.response` carries, in the order the reader emits them. */
interface Segment {
  reasoning?: string;
  text?: string;
  tools?: DisplayToolCall[];
}

const BLOCK_RANK = { reasoning: 0, text: 1, tool: 2 } as const;

/**
 * Split an assistant turn's blocks into the fewest `llm.response`s that
 * reproduce them. The reader emits at most one reasoning, one text, and one
 * tool block per response, in that order, so a new response starts whenever a
 * block's rank does not increase.
 */
function segmentBlocks(blocks: DisplayMessage["blocks"]): Segment[] {
  const segments: Segment[] = [];
  let current: Segment | undefined;
  let lastRank = -1;
  for (const block of blocks) {
    const rank = BLOCK_RANK[block.type];
    if (!current || rank <= lastRank) {
      current = {};
      segments.push(current);
    }
    if (block.type === "tool") current.tools = block.toolCalls;
    else current[block.type] = block.text;
    lastRank = rank;
  }
  return segments;
}

/** A turn's usage as an `llm.response` carries it, omitting undefined subtotals. */
function eventUsage(usage: DisplayUsage | undefined): Record<string, number> {
  if (!usage) return { inputTokens: 0, outputTokens: 0 };
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
    ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
  };
}

/** A tool call's `tool.start` + `tool.done` pair; the output is its result's text. */
function toolCallEvents(ts: string, runId: string, tc: DisplayToolCall): EventLine[] {
  const output = (tc.result?.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("");
  return [
    { ts, type: "tool.start", runId, name: tc.name, id: tc.id },
    {
      ts,
      type: "tool.done",
      runId,
      name: tc.name,
      id: tc.id,
      ok: tc.ok,
      ms: tc.ms,
      output,
      ...(tc.resourceUri ? { resourceUri: tc.resourceUri } : {}),
      ...(tc.resourceLinks && tc.resourceLinks.length > 0
        ? { resourceLinks: tc.resourceLinks }
        : {}),
    },
  ];
}

/** One segment's `llm.response`, followed by its tool calls' events. */
function segmentEvents(
  ts: string,
  runId: string,
  model: string,
  seg: Segment,
  usage: Record<string, number>,
  llmMs: number,
): EventLine[] {
  const content: EventLine[] = [];
  if (seg.reasoning !== undefined) content.push({ type: "reasoning", text: seg.reasoning });
  if (seg.text !== undefined) content.push({ type: "text", text: seg.text });
  for (const tc of seg.tools ?? []) {
    content.push({
      type: "tool-call",
      toolCallId: tc.id,
      toolName: tc.name,
      input: JSON.stringify(tc.input ?? {}),
    });
  }
  // A segment carrying tool calls ended to run them; anything else ended normally.
  const finishReason = seg.tools && seg.tools.length > 0 ? "tool-calls" : "stop";
  return [
    { ts, type: "llm.response", runId, model, content, usage, llmMs, finishReason },
    ...(seg.tools ?? []).flatMap((tc) => toolCallEvents(ts, runId, tc)),
  ];
}

/**
 * An assistant turn as a run: `run.start`, one `llm.response` per segment with
 * its tool events, `run.done`. The turn's usage rides the first response (the
 * rest carry zero), so the reader's per-run sum is the turn's total.
 */
function assistantEvents(msg: DisplayMessage, runId: string): EventLine[] {
  const ts = msg.timestamp;
  const model = msg.usage?.model ?? "unknown";
  const segments = segmentBlocks(msg.blocks);
  if (segments.length === 0) segments.push({});
  return [
    { ts, type: "run.start", runId, model },
    ...segments.flatMap((seg, i) =>
      i === 0
        ? segmentEvents(ts, runId, model, seg, eventUsage(msg.usage), msg.usage?.llmMs ?? 0)
        : segmentEvents(ts, runId, model, seg, eventUsage(undefined), 0),
    ),
    { ts, type: "run.done", runId, stopReason: "complete", totalMs: msg.usage?.llmMs ?? 0 },
  ];
}

/** A user turn as a `user.message` event. */
function userEvent(msg: DisplayMessage): EventLine {
  return {
    ts: msg.timestamp,
    type: "user.message",
    content: msg.content ? [{ type: "text", text: msg.content }] : [],
    ...(msg.userId ? { userId: msg.userId } : {}),
    ...(msg.files && msg.files.length > 0 ? { files: msg.files } : {}),
  };
}

/**
 * Copied display messages as the events that read back to them: what the
 * runtime's event-sourced store writes for the same turns.
 */
function messagesToEventLines(messages: DisplayMessage[]): string[] {
  let runCounter = 0;
  return messages
    .flatMap((msg) =>
      msg.role === "user" ? [userEvent(msg)] : assistantEvents(msg, `forked-${runCounter++}`),
    )
    .map((e) => JSON.stringify(e));
}

/** Derive preview from the first copied user message; "" if none was copied. */
function derivePreview(messages: DisplayMessage[]): string {
  for (const msg of messages) {
    if (msg.role === "user" && typeof msg.content === "string") {
      return msg.content;
    }
  }
  return "";
}

export async function handleFork(
  input: ForkInput,
  index: ConversationIndex,
  access?: AccessContext,
): Promise<ConversationsForkOutput> {
  const entry = index.get(input.id, access);
  if (!entry) {
    throw new Error(`Conversation not found: ${input.id}`);
  }

  const conversation = await readConversation(entry.filePath);
  if (!conversation) {
    throw new Error(`Conversation not found: ${input.id}`);
  }

  // Determine which messages to copy
  const messagesToCopy =
    input.atMessage !== undefined
      ? conversation.messages.slice(0, input.atMessage)
      : conversation.messages;

  // Generate new ID: conv_<16 random hex chars>
  const newId = `conv_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const now = new Date().toISOString();

  // Recalculate token counts from copied assistant messages
  const { totalInputTokens, totalOutputTokens, lastModel } = sumCopiedUsage(messagesToCopy);

  // Line 1 is the header the runtime's event-sourced store writes; totals are
  // not stored, every reader derives them from the events.
  const updatedAt = resolveUpdatedAt(messagesToCopy, now);
  const header = {
    id: newId,
    createdAt: now,
    updatedAt,
    title: null,
    lastModel,
    // The fork inherits the source's owner: every reader refuses a
    // conversation without one.
    ...(conversation.meta.ownerId ? { ownerId: conversation.meta.ownerId } : {}),
    format: "events",
    // A fork continues the source conversation, so it inherits the model
    // binding along with the owner. Re-resolving would move the copy onto the
    // current default and replay the source's history to a different provider.
    model: conversation.meta.model,
  };
  const lines = [JSON.stringify(header), ...messagesToEventLines(messagesToCopy)];

  // Write new file via temp+rename for atomicity
  const dir = dirname(entry.filePath);
  const newPath = join(dir, `${newId}.jsonl`);
  const tmpPath = `${newPath}.tmp.${Date.now()}`;
  await writeFile(tmpPath, lines.map((l) => `${l}\n`).join(""));
  await rename(tmpPath, newPath);

  // As in `handleUpdate`: this handler writes the file itself, so the store's
  // `onMutate` never fires. The fork is a conversation the index has never seen,
  // so unannounced it is not stale — it is absent, and stays absent. The
  // workspace comes from the source, which the copy is written alongside.
  index.invalidate({ id: newId, filePath: newPath, wsId: entry.workspaceId });

  const preview = derivePreview(messagesToCopy);

  return {
    id: newId,
    title: null,
    createdAt: now,
    updatedAt,
    messageCount: messagesToCopy.length,
    totalInputTokens,
    totalOutputTokens,
    lastModel,
    preview,
  };
}
