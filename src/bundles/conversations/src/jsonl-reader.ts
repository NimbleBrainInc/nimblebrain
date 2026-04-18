/**
 * Read-only JSONL parser for NimbleBrain conversation files.
 *
 * Produces display-shaped messages (one per turn, with ordered blocks) —
 * the canonical view for any UI consumer of conversations. The LLM-replay
 * view is a separate projection in src/conversation/event-reconstructor.ts.
 *
 * Types are intentionally self-contained — no imports from the runtime
 * codebase — because this bundle is deployable independently.
 */

import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Public types — the display projection of a conversation
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

/**
 * A single chat turn as it should be rendered. One per `user.message` event
 * and one per `run.start`→`run.done` span — never split per iteration.
 */
export interface DisplayMessage {
  role: "user" | "assistant";
  /** Aggregated text across all text blocks (convenient for copy/title). */
  content: string;
  /** Ordered content blocks — the primary structure for rendering. */
  blocks: DisplayBlock[];
  timestamp: string;
  userId?: string;
  /** All tool calls flattened out of blocks — derived, for consumers that scan them. */
  toolCalls?: DisplayToolCall[];
  /** Aggregate LLM usage for the whole turn; undefined for user messages. */
  usage?: DisplayUsage;
  files?: DisplayFile[];
  /** Non-"complete" run terminations bubble up here ("max_iterations", "error"). */
  stopReason?: string;
}

export type DisplayBlock =
  | { type: "text"; text: string }
  | { type: "tool"; toolCalls: DisplayToolCall[] };

export interface DisplayToolCall {
  id: string;
  /** Full tool name (may include "server__tool" prefix). */
  name: string;
  /** Server prefix from the name (before "__"), if any — convenience for routing. */
  appName?: string;
  /** Terminal status — tool calls from history are never mid-flight. */
  status: "done" | "error";
  ok: boolean;
  ms: number;
  input: Record<string, unknown>;
  /**
   * MCP tool-result envelope — identical shape to what streaming emits, so the
   * UI consumes one type regardless of source. `content[0].text` is the tool's
   * text output; `isError` mirrors `!ok`.
   */
  result: DisplayToolResult;
  resourceUri?: string;
  resourceLinks?: DisplayResourceLink[];
}

export interface DisplayToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: Record<string, unknown>;
  isError: boolean;
}

export interface DisplayResourceLink {
  uri: string;
  name?: string;
  mimeType?: string;
  description?: string;
}

export interface DisplayUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  /** Model of the last LLM call in the run (runs can switch models mid-turn). */
  model: string;
  llmMs: number;
}

export interface DisplayFile {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  extracted: boolean;
}

export interface ConversationFile {
  meta: ConversationMeta;
  messages: DisplayMessage[];
  messageCount: number;
  preview: string;
}

// ---------------------------------------------------------------------------
// Internal event types — mirror src/conversation/types.ts, kept local
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
  files?: DisplayFile[];
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

interface ToolStartEvent {
  ts: string;
  type: "tool.start";
  runId: string;
  id: string;
  name: string;
  input?: unknown;
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
  resourceUri?: string;
  resourceLinks?: DisplayResourceLink[];
}

interface RunDoneEvent {
  ts: string;
  type: "run.done";
  runId: string;
  stopReason?: string;
}

interface RunErrorEvent {
  ts: string;
  type: "run.error";
  runId: string;
  error?: string;
}

type KnownEvent =
  | UserMessageEvent
  | RunStartEvent
  | LlmResponseEvent
  | ToolStartEvent
  | ToolDoneEvent
  | RunDoneEvent
  | RunErrorEvent;

function isUserMessage(e: { type: string }): e is UserMessageEvent {
  return e.type === "user.message";
}
function isRunStart(e: { type: string }): e is RunStartEvent {
  return e.type === "run.start";
}
function isLlmResponse(e: { type: string }): e is LlmResponseEvent {
  return e.type === "llm.response";
}
function isToolStart(e: { type: string }): e is ToolStartEvent {
  return e.type === "tool.start";
}
function isToolDone(e: { type: string }): e is ToolDoneEvent {
  return e.type === "tool.done";
}
function isRunDone(e: { type: string }): e is RunDoneEvent {
  return e.type === "run.done";
}
function isRunError(e: { type: string }): e is RunErrorEvent {
  return e.type === "run.error";
}

// ---------------------------------------------------------------------------
// Metadata parsing
// ---------------------------------------------------------------------------

function parseMeta(raw: Record<string, unknown>): ConversationMeta | null {
  if (typeof raw.id !== "string" || typeof raw.createdAt !== "string") return null;
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

interface DerivedMetrics {
  totalInputTokens: number;
  totalOutputTokens: number;
  lastModel: string | null;
  lastEventTs: string | null;
}

function deriveMetricsFromLines(lines: string[]): DerivedMetrics {
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let lastModel: string | null = null;
  let lastEventTs: string | null = null;

  for (const line of lines) {
    const evt = parseEventLine(line);
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

function applyDerivedMetrics(meta: ConversationMeta, metrics: DerivedMetrics): void {
  if (metrics.totalInputTokens > 0 || metrics.totalOutputTokens > 0) {
    meta.totalInputTokens = metrics.totalInputTokens;
    meta.totalOutputTokens = metrics.totalOutputTokens;
    meta.lastModel = metrics.lastModel;
  }
  if (metrics.lastEventTs) meta.updatedAt = metrics.lastEventTs;
}

function deriveTitleFromEvents(meta: ConversationMeta, eventLines: string[]): void {
  for (const line of eventLines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.type === "metadata.title" && typeof parsed.title === "string") {
        meta.title = parsed.title;
      }
    } catch {
      // skip malformed
    }
  }
}

/**
 * Cheap heuristic: is this line an event (not a stored message)?
 *
 * Event lines have `"ts":"…"` and one of a fixed set of `"type":"…"` strings.
 * Using the type prefix alone is too loose — `"type":"text"` appears inside
 * DisplayMessage blocks too, which tripped this before.
 */
function looksLikeEventLine(line: string): boolean {
  if (!line.includes('"ts":"')) return false;
  return (
    line.includes('"type":"user.message"') ||
    line.includes('"type":"run.start"') ||
    line.includes('"type":"run.done"') ||
    line.includes('"type":"llm.response"') ||
    line.includes('"type":"tool.start"') ||
    line.includes('"type":"tool.done"') ||
    line.includes('"type":"metadata.')
  );
}

function parseEventLine(line: string): (KnownEvent & { ts: string; type: string }) | null {
  try {
    const parsed = JSON.parse(line) as { ts?: string; type?: string };
    if (!parsed.ts || !parsed.type) return null;
    return parsed as KnownEvent & { ts: string; type: string };
  } catch {
    return null;
  }
}

function extractText(content: ContentPart[] | undefined): string {
  if (!content) return "";
  return content
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text as string)
    .join("");
}

// ---------------------------------------------------------------------------
// Event-sourced reducer — produces DisplayMessage[]
// ---------------------------------------------------------------------------

/**
 * Walk events in chronological order and project them into the display shape.
 *
 * Rules:
 * - Each `user.message` event emits one user DisplayMessage.
 * - Each `run.start`→`run.done`/`run.error` span emits one assistant DisplayMessage.
 *   Within that span, llm.response events are walked in order; their text and
 *   tool-call content becomes blocks in timeline order. Usage is summed across
 *   all llm.responses in the run.
 * - Incomplete runs (no run.done) still emit what's been seen so far, for
 *   resilient display of truncated logs.
 */
function reconstructFromEvents(lines: string[]): {
  messages: DisplayMessage[];
  messageCount: number;
  preview: string;
} {
  const messages: DisplayMessage[] = [];
  let preview = "";

  const events = lines
    .map(parseEventLine)
    .filter((e): e is KnownEvent & { ts: string; type: string } => e !== null);

  for (let i = 0; i < events.length; ) {
    const evt = events[i]!;

    if (isUserMessage(evt)) {
      const text = extractText(evt.content);
      const msg: DisplayMessage = {
        role: "user",
        content: text,
        blocks: text ? [{ type: "text", text }] : [],
        timestamp: evt.ts,
        ...(evt.userId ? { userId: evt.userId } : {}),
        ...(evt.files && evt.files.length > 0 ? { files: evt.files } : {}),
      };
      messages.push(msg);
      if (!preview) preview = text;
      i++;
      continue;
    }

    if (isRunStart(evt)) {
      const [runMsg, nextIndex] = collectRun(events, i, evt.runId);
      if (runMsg) messages.push(runMsg);
      i = nextIndex;
      continue;
    }

    i++;
  }

  return { messages, messageCount: messages.length, preview };
}

/**
 * Collect events belonging to a single run (from run.start at index `start`
 * through run.done or run.error) and build one assistant DisplayMessage.
 *
 * Returns the built message and the index at which outer iteration resumes.
 * Incomplete runs (no run.done) still produce a best-effort message.
 */
function collectRun(
  events: KnownEvent[],
  start: number,
  runId: string,
): [DisplayMessage | null, number] {
  const toolDones = new Map<string, ToolDoneEvent>();
  const toolInputs = new Map<string, unknown>();
  const llmResponses: LlmResponseEvent[] = [];

  let endTs = events[start]?.ts ?? "";
  let stopReason: string | undefined;

  let i = start + 1;
  while (i < events.length) {
    const inner = events[i]!;
    if (isRunDone(inner) && inner.runId === runId) {
      endTs = inner.ts;
      stopReason = inner.stopReason;
      i++;
      break;
    }
    if (isRunError(inner) && inner.runId === runId) {
      endTs = inner.ts;
      stopReason = "error";
      i++;
      break;
    }
    if (isLlmResponse(inner) && inner.runId === runId) {
      llmResponses.push(inner);
    } else if (isToolStart(inner) && inner.runId === runId) {
      if (inner.input !== undefined) toolInputs.set(inner.id, inner.input);
    } else if (isToolDone(inner) && inner.runId === runId) {
      toolDones.set(inner.id, inner);
    }
    i++;
  }

  if (llmResponses.length === 0) return [null, i];

  const blocks: DisplayBlock[] = [];
  const flatToolCalls: DisplayToolCall[] = [];

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let hasCacheReads = false;
  let llmMs = 0;
  let model = "";

  for (const llm of llmResponses) {
    // Text content — one text block per llm.response that has any text.
    const text = extractText(llm.content);
    if (text) blocks.push({ type: "text", text });

    // Tool-call content — one tool block per llm.response that has tool-calls.
    const toolCallParts = llm.content.filter((c) => c.type === "tool-call");
    if (toolCallParts.length > 0) {
      const tools = toolCallParts.map((tc): DisplayToolCall => {
        const toolCallId = tc.toolCallId ?? "";
        const done = toolDones.get(toolCallId);
        const inputFromStart = toolInputs.get(toolCallId);
        const input = parseToolInput(inputFromStart ?? tc.input);
        const ok = done?.ok ?? true;
        const name = tc.toolName ?? "";
        return {
          id: toolCallId,
          name,
          ...(extractAppName(name) ? { appName: extractAppName(name)! } : {}),
          status: ok ? "done" : "error",
          ok,
          ms: done?.ms ?? 0,
          input,
          result: wrapOutputAsResult(done?.output ?? "", !ok),
          ...(done?.resourceUri ? { resourceUri: done.resourceUri } : {}),
          ...(done?.resourceLinks && done.resourceLinks.length > 0
            ? { resourceLinks: done.resourceLinks }
            : {}),
        };
      });
      blocks.push({ type: "tool", toolCalls: tools });
      flatToolCalls.push(...tools);
    }

    // Usage — aggregate across all llm.responses in the run.
    inputTokens += llm.inputTokens;
    outputTokens += llm.outputTokens;
    if (typeof llm.cacheReadTokens === "number" && llm.cacheReadTokens > 0) {
      hasCacheReads = true;
      cacheReadTokens += llm.cacheReadTokens;
    }
    llmMs += llm.llmMs;
    model = llm.model;
  }

  const contentText = blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");

  const usage: DisplayUsage = {
    inputTokens,
    outputTokens,
    ...(hasCacheReads ? { cacheReadTokens } : {}),
    model,
    llmMs,
  };

  const msg: DisplayMessage = {
    role: "assistant",
    content: contentText,
    blocks,
    timestamp: endTs,
    ...(flatToolCalls.length > 0 ? { toolCalls: flatToolCalls } : {}),
    usage,
    ...(stopReason && stopReason !== "complete" ? { stopReason } : {}),
  };
  return [msg, i];
}

/** "server__tool" → "server"; undefined if no "__" separator. */
function extractAppName(name: string): string | undefined {
  const idx = name.indexOf("__");
  return idx === -1 ? undefined : name.slice(0, idx);
}

/** Wrap a plain text output string as an MCP-shaped tool result envelope. */
function wrapOutputAsResult(text: string, isError: boolean): DisplayToolResult {
  return {
    content: text ? [{ type: "text", text }] : [],
    isError,
  };
}

/** Tool inputs may be JSON strings in the event log — parse defensively. */
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

// ---------------------------------------------------------------------------
// Legacy (non-event) message-line format → DisplayMessage
// ---------------------------------------------------------------------------

/**
 * Legacy (pre-event) JSONL files stored one JSON-serialized message per line.
 * This path also handles files written by `fork`, which writes DisplayMessage
 * shape directly. Accepts both shapes:
 *
 *   - Old StoredMessage: tool calls and usage live under `metadata.*`.
 *   - New DisplayMessage: `blocks`, `toolCalls`, `usage` are top-level.
 *
 * Detection is structural — top-level fields override `metadata` when present.
 */
function parseLegacyMessages(lines: string[]): {
  messages: DisplayMessage[];
  messageCount: number;
  preview: string;
} {
  const messages: DisplayMessage[] = [];
  let preview = "";

  for (const line of lines) {
    try {
      const raw = JSON.parse(line) as Record<string, unknown>;
      const msg = legacyLineToDisplay(raw);
      if (!msg) continue;
      messages.push(msg);
      if (!preview && msg.role === "user" && msg.content) preview = msg.content;
    } catch {
      // skip malformed
    }
  }

  return { messages, messageCount: messages.length, preview };
}

function legacyLineToDisplay(raw: Record<string, unknown>): DisplayMessage | null {
  const role = raw.role;
  if (role !== "user" && role !== "assistant") return null;
  const timestamp = typeof raw.timestamp === "string" ? raw.timestamp : "";
  if (!timestamp) return null;
  const content = typeof raw.content === "string" ? raw.content : "";

  const metadata = (raw.metadata ?? {}) as Record<string, unknown>;
  const rawToolCalls = (raw.toolCalls ?? metadata.toolCalls) as
    | Array<Record<string, unknown>>
    | undefined;
  const hydratedTools = rawToolCalls?.map(hydrateLegacyToolCall) ?? [];

  const topBlocks = raw.blocks as DisplayBlock[] | undefined;
  const blocks =
    topBlocks && topBlocks.length > 0
      ? topBlocks
      : buildLegacyBlocks(content, hydratedTools.length > 0 ? hydratedTools : undefined);
  const usage = (raw.usage as DisplayUsage | undefined) ?? buildLegacyUsageFromMetadata(metadata);

  return {
    role,
    content,
    blocks,
    timestamp,
    ...(typeof raw.userId === "string" ? { userId: raw.userId } : {}),
    ...(hydratedTools.length > 0 ? { toolCalls: hydratedTools } : {}),
    ...(usage ? { usage } : {}),
  };
}

/**
 * Legacy stored tool calls lack `status`, `result`, and `appName`. Derive them
 * on read so every DisplayToolCall the reader emits has the full shape,
 * regardless of file age or writer.
 */
function hydrateLegacyToolCall(raw: Record<string, unknown>): DisplayToolCall {
  const name = typeof raw.name === "string" ? raw.name : "";
  const ok = typeof raw.ok === "boolean" ? raw.ok : true;
  const output = typeof raw.output === "string" ? raw.output : "";
  const result = (raw.result as DisplayToolResult | undefined) ?? wrapOutputAsResult(output, !ok);
  const app = extractAppName(name);
  return {
    id: typeof raw.id === "string" ? raw.id : "",
    name,
    ...(app ? { appName: app } : {}),
    status: ok ? "done" : "error",
    ok,
    ms: typeof raw.ms === "number" ? raw.ms : 0,
    input: (raw.input ?? {}) as Record<string, unknown>,
    result,
    ...(typeof raw.resourceUri === "string" ? { resourceUri: raw.resourceUri } : {}),
    ...(Array.isArray(raw.resourceLinks)
      ? { resourceLinks: raw.resourceLinks as DisplayResourceLink[] }
      : {}),
  };
}

function buildLegacyBlocks(content: string, tools: DisplayToolCall[] | undefined): DisplayBlock[] {
  const out: DisplayBlock[] = [];
  if (content) out.push({ type: "text", text: content });
  if (tools && tools.length > 0) out.push({ type: "tool", toolCalls: tools });
  return out;
}

function buildLegacyUsageFromMetadata(metadata: Record<string, unknown>): DisplayUsage | undefined {
  const inputTokens = metadata.inputTokens;
  const outputTokens = metadata.outputTokens;
  if (inputTokens == null && outputTokens == null) return undefined;
  return {
    inputTokens: typeof inputTokens === "number" ? inputTokens : 0,
    outputTokens: typeof outputTokens === "number" ? outputTokens : 0,
    ...(typeof metadata.cacheReadTokens === "number"
      ? { cacheReadTokens: metadata.cacheReadTokens }
      : {}),
    model: typeof metadata.model === "string" ? metadata.model : "unknown",
    llmMs: typeof metadata.llmMs === "number" ? metadata.llmMs : 0,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Read and parse a single JSONL file. Returns null if missing or empty. */
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

  const dataLines = lines.slice(1);
  const isEventFormat = raw.format === "events" || dataLines.some(looksLikeEventLine);

  const { messages, messageCount, preview } = isEventFormat
    ? reconstructFromEvents(dataLines)
    : parseLegacyMessages(dataLines);

  applyDerivedMetrics(meta, deriveMetricsFromLines(dataLines));
  deriveTitleFromEvents(meta, dataLines);

  return { meta, messages, messageCount, preview };
}

/** Fast header read — metadata + preview + count, no message reconstruction. */
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

  const dataLines = lines.slice(1);
  let preview = "";
  let messageCount = 0;
  for (const line of dataLines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      messageCount++;
      if (!preview && parsed.type === "user.message" && Array.isArray(parsed.content)) {
        preview = extractText(parsed.content as ContentPart[]);
      }
      if (!preview && parsed.role === "user" && typeof parsed.content === "string") {
        preview = parsed.content;
      }
    } catch {
      // skip malformed
    }
  }

  deriveTitleFromEvents(meta, dataLines);
  applyDerivedMetrics(meta, deriveMetricsFromLines(dataLines));

  return { meta, preview, messageCount };
}

/** List all .jsonl files in a directory. Absolute paths. */
export function listConversationFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => `${dir}/${f}`);
  } catch {
    return [];
  }
}
