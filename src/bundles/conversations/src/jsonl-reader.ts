/**
 * Read-only JSONL parser for NimbleBrain conversation files.
 *
 * Types are defined locally — no imports from the runtime codebase.
 */

import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Types (mirror src/conversation/types.ts — kept independent)
// ---------------------------------------------------------------------------

export interface ConversationMeta {
  id: string;
  createdAt: string;
  updatedAt: string;
  title: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  lastModel: string | null;
  ownerId?: string;
  visibility?: "private" | "shared";
  participants?: string[];
}

export interface StoredMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  userId?: string;
  metadata?: {
    skill?: string | null;
    toolCalls?: Array<{
      id: string;
      name: string;
      input: Record<string, unknown>;
      output: string;
      ok: boolean;
      ms: number;
    }>;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    costUsd?: number;
    model?: string;
    llmMs?: number;
    iterations?: number;
  };
}

export interface ConversationFile {
  meta: ConversationMeta;
  messages: StoredMessage[];
  messageCount: number;
  preview: string;
}

// ---------------------------------------------------------------------------
// Event types (mirror src/conversation/types.ts — kept independent)
// ---------------------------------------------------------------------------

interface ContentPart {
  type: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
}

interface UserMessageEvent {
  ts: string;
  type: "user.message";
  content: ContentPart[];
  userId?: string;
}

interface RunStartEvent {
  ts: string;
  type: "run.start";
  runId: string;
}

interface LlmResponseEvent {
  ts: string;
  type: "llm.response";
  runId: string;
  model: string;
  content: ContentPart[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  llmMs: number;
}

interface ToolDoneEvent {
  ts: string;
  type: "tool.done";
  runId: string;
  id: string;
  name: string;
  ok: boolean;
  ms: number;
  output?: string;
}

interface RunDoneEvent {
  ts: string;
  type: "run.done" | "run.error";
  runId: string;
}

function isUserMessage(evt: { type: string }): evt is UserMessageEvent {
  return evt.type === "user.message";
}
function isRunStart(evt: { type: string }): evt is RunStartEvent {
  return evt.type === "run.start";
}
function isLlmResponse(evt: { type: string }): evt is LlmResponseEvent {
  return evt.type === "llm.response";
}
function isToolDone(evt: { type: string }): evt is ToolDoneEvent {
  return evt.type === "tool.done";
}
function isRunEnd(evt: { type: string }): evt is RunDoneEvent {
  return evt.type === "run.done" || evt.type === "run.error";
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse the metadata line (line 1) with backward-compat defaults.
 * Matches the defaulting behavior of JsonlConversationStore.load().
 */
function parseMeta(raw: Record<string, unknown>): ConversationMeta | null {
  if (typeof raw.id !== "string" || typeof raw.createdAt !== "string") {
    return null;
  }

  return {
    id: raw.id,
    createdAt: raw.createdAt,
    updatedAt: (raw.updatedAt as string) ?? raw.createdAt,
    title: (raw.title as string | null) ?? null,
    totalInputTokens: (raw.totalInputTokens as number) ?? 0,
    totalOutputTokens: (raw.totalOutputTokens as number) ?? 0,
    totalCostUsd: (raw.totalCostUsd as number) ?? 0,
    lastModel: (raw.lastModel as string | null) ?? null,
    ...(raw.ownerId ? { ownerId: raw.ownerId as string } : {}),
    ...(raw.visibility ? { visibility: raw.visibility as "private" | "shared" } : {}),
    ...(Array.isArray(raw.participants) ? { participants: raw.participants as string[] } : {}),
  };
}

/** Derived usage metrics from event lines. */
interface DerivedMetrics {
  totalInputTokens: number;
  totalOutputTokens: number;
  lastModel: string | null;
  lastEventTs: string | null;
}

/**
 * Scan event lines for llm.response events and derive usage metrics.
 * Returns non-zero values only if llm.response events are found.
 */
function deriveMetricsFromLines(lines: string[]): DerivedMetrics {
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let lastModel: string | null = null;
  let lastEventTs: string | null = null;

  for (const line of lines) {
    const evt = parseEvent(line);
    if (!evt) continue;
    lastEventTs = evt.ts;
    if (isLlmResponse(evt)) {
      totalInputTokens += evt.inputTokens;
      totalOutputTokens += evt.outputTokens;
      lastModel = evt.model;
    }
  }

  return { totalInputTokens, totalOutputTokens, lastModel, lastEventTs };
}

/** Parse legacy StoredMessage lines (non-event format). */
function parseMessages(lines: string[]): {
  messages: StoredMessage[];
  messageCount: number;
  preview: string;
} {
  const messages: StoredMessage[] = [];
  let preview = "";
  for (const line of lines) {
    try {
      const msg = JSON.parse(line) as StoredMessage;
      messages.push(msg);
      if (!preview && msg.role === "user") {
        preview = typeof msg.content === "string" ? msg.content : "";
      }
    } catch {
      // Skip malformed lines
    }
  }
  return { messages, messageCount: messages.length, preview };
}

/** Apply derived metrics to metadata, overriding line-1 values when events are present. */
function applyDerivedMetrics(meta: ConversationMeta, metrics: DerivedMetrics): void {
  if (metrics.totalInputTokens > 0 || metrics.totalOutputTokens > 0) {
    meta.totalInputTokens = metrics.totalInputTokens;
    meta.totalOutputTokens = metrics.totalOutputTokens;
    meta.lastModel = metrics.lastModel;
  }
  if (metrics.lastEventTs) {
    meta.updatedAt = metrics.lastEventTs;
  }
}

/** Scan event lines for metadata.title events and apply the last one to meta. */
function deriveTitleFromEvents(meta: ConversationMeta, eventLines: string[]): void {
  for (const line of eventLines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.type === "metadata.title" && typeof parsed.title === "string") {
        meta.title = parsed.title;
      }
    } catch {
      // Skip malformed lines
    }
  }
}

/** Extract plain text from a content parts array. */
function extractText(content: ContentPart[]): string {
  return content
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text!)
    .join("");
}

/** Parse a JSON line into an event object. Use type guards for narrowing. */
function parseEvent(line: string): { ts: string; type: string } | null {
  try {
    const parsed = JSON.parse(line) as { ts?: string; type?: string };
    if (!parsed.ts || !parsed.type) return null;
    return parsed as { ts: string; type: string };
  } catch {
    return null;
  }
}

/**
 * Reconstruct StoredMessage[] from event-sourced JSONL lines.
 *
 * Walks events in order:
 * - user.message → user StoredMessage (with userId)
 * - run.start..run.done span → collect llm.response + tool.done events
 * - llm.response → assistant StoredMessage (with metadata and tool calls)
 */
function reconstructFromEvents(lines: string[]): {
  messages: StoredMessage[];
  messageCount: number;
  preview: string;
} {
  const messages: StoredMessage[] = [];
  let preview = "";

  const events = lines.map(parseEvent).filter((e): e is { ts: string; type: string } => e !== null);

  for (let i = 0; i < events.length; ) {
    const evt = events[i]!;

    if (isUserMessage(evt)) {
      const text = extractText(evt.content);
      messages.push({
        role: "user",
        content: text,
        timestamp: evt.ts,
        ...(evt.userId ? { userId: evt.userId } : {}),
      });
      if (!preview) preview = text;
      i++;
      continue;
    }

    if (isRunStart(evt)) {
      const runId = evt.runId;
      i++;

      const toolDones = new Map<string, ToolDoneEvent>();
      const llmResponses: LlmResponseEvent[] = [];

      while (i < events.length) {
        const inner = events[i]!;
        if (isRunEnd(inner) && inner.runId === runId) {
          i++;
          break;
        }
        if (isLlmResponse(inner) && inner.runId === runId) {
          llmResponses.push(inner);
        } else if (isToolDone(inner) && inner.runId === runId) {
          toolDones.set(inner.id, inner);
        }
        i++;
      }

      for (const llm of llmResponses) {
        const textParts = llm.content.filter((c) => c.type === "text");
        const toolCallParts = llm.content.filter((c) => c.type === "tool-call");

        const metadata: StoredMessage["metadata"] = {
          inputTokens: llm.inputTokens,
          outputTokens: llm.outputTokens,
          cacheReadTokens: llm.cacheReadTokens,
          model: llm.model,
          llmMs: llm.llmMs,
          iterations: llmResponses.length,
        };

        if (toolCallParts.length > 0) {
          metadata.toolCalls = toolCallParts.map((tc) => {
            const done = toolDones.get(tc.toolCallId ?? "");
            return {
              id: tc.toolCallId ?? "",
              name: tc.toolName ?? "",
              input: (tc.input ?? {}) as Record<string, unknown>,
              output: done?.output ?? "",
              ok: done?.ok ?? true,
              ms: done?.ms ?? 0,
            };
          });
        }

        const text = textParts.map((t) => t.text ?? "").join("");
        messages.push({
          role: "assistant",
          content: text,
          timestamp: llm.ts,
          metadata,
        });
      }

      continue;
    }

    i++;
  }

  return { messages, messageCount: messages.length, preview };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Read and parse a single JSONL file. Returns null if file doesn't exist or is empty. */
export async function readConversation(filePath: string): Promise<ConversationFile | null> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return null;
  }

  const lines = content.split("\n").filter(Boolean);
  if (lines.length === 0) return null;

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(lines[0]!) as Record<string, unknown>;
  } catch {
    return null;
  }

  const meta = parseMeta(raw);
  if (!meta) return null;

  const eventLines = lines.slice(1);
  const isEventFormat = raw.format === "events" || eventLines.some((l) => l.includes('"type":"'));
  const { messages, messageCount, preview } = isEventFormat
    ? reconstructFromEvents(eventLines)
    : parseMessages(eventLines);
  applyDerivedMetrics(meta, deriveMetricsFromLines(eventLines));
  // Derive title from metadata.title events (title in line 1 is null at creation)
  deriveTitleFromEvents(meta, eventLines);

  return { meta, messages, messageCount, preview };
}

/** Read only the metadata (line 1) + preview from a JSONL file. Fast — doesn't parse all messages fully. */
export async function readConversationHeader(
  filePath: string,
): Promise<{ meta: ConversationMeta; preview: string; messageCount: number } | null> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return null;
  }

  const lines = content.split("\n").filter(Boolean);
  if (lines.length === 0) return null;

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(lines[0]!) as Record<string, unknown>;
  } catch {
    return null;
  }

  const meta = parseMeta(raw);
  if (!meta) return null;

  // Scan event lines for count, preview, title, and derived metrics
  const eventLines = lines.slice(1);
  let preview = "";
  let messageCount = 0;
  for (const line of eventLines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      messageCount++;
      // Event-sourced format: extract preview from user.message events
      if (!preview && parsed.type === "user.message" && Array.isArray(parsed.content)) {
        preview = extractText(parsed.content as ContentPart[]);
      }
      // Legacy format: extract preview from StoredMessage lines
      if (!preview && parsed.role === "user" && typeof parsed.content === "string") {
        preview = parsed.content;
      }
    } catch {
      // Skip malformed lines
    }
  }
  deriveTitleFromEvents(meta, eventLines);
  applyDerivedMetrics(meta, deriveMetricsFromLines(eventLines));

  return { meta, preview, messageCount };
}

/** List all .jsonl files in a directory. Returns absolute paths. */
export function listConversationFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => `${dir}/${f}`);
  } catch {
    return [];
  }
}
