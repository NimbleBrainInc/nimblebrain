/**
 * Read-only JSONL parser for NimbleBrain conversation files.
 *
 * Produces display-shaped messages (one per turn, with ordered blocks) —
 * the canonical view for any UI consumer of conversations. The LLM-replay
 * view is a separate projection in src/conversation/event-reconstructor.ts.
 *
 * Types are intentionally self-contained — no imports from the runtime
 * codebase — because this app is deployable independently.
 */

import { type Dirent, readdirSync } from "node:fs";
import { type FileHandle, open, readFile } from "node:fs/promises";
import { join } from "node:path";

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
  /**
   * The model the conversation is bound to — the runtime stamps this on the
   * line-1 header at create time and never mutates it. Distinct from
   * `lastModel`, which is derived from events and describes what the last turn
   * ran on.
   */
  model: string;
  ownerId?: string;
  /**
   * The workspace the conversation ran in — the breadcrumb the
   * runtime stamps on the line-1 header at create time. May be absent; the
   * workspace the file is stored under is authoritative either way.
   */
  workspaceId?: string;
}

export type {
  DisplayBlock,
  DisplayFile,
  DisplayMessage,
  DisplayResourceLink,
  DisplaySkill,
  DisplaySkillsContext,
  DisplayToolCall,
  DisplayToolResult,
  DisplayUsage,
} from "../schemas/conversations.ts";

import type {
  DisplayBlock,
  DisplayFile,
  DisplayMessage,
  DisplayResourceLink,
  DisplaySkill,
  DisplaySkillsContext,
  DisplayToolCall,
  DisplayToolResult,
  DisplayUsage,
} from "../schemas/conversations.ts";

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

/**
 * Token usage shape mirrored from the runtime's canonical TokenUsage.
 * This app is intentionally self-contained (no imports from runtime),
 * so the shape is duplicated rather than imported. Keep in sync with
 * src/usage/types.ts — verified at test time by
 * `test/unit/platform/conversations/usage-shape-sync.test.ts`.
 */
export interface UsageShape {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

interface LlmResponseEvent {
  ts: string;
  type: "llm.response";
  runId: string;
  model: string;
  content: ContentPart[];
  usage: UsageShape;
  llmMs: number;
}

/**
 * Usage for a forked fast-slot model call (compaction summarizer, auto-title)
 * that runs outside the agentic loop and emits no `llm.response`.
 * Mirrors the runtime's `AuxUsageEvent`. Carries no content and is never a
 * message — `reconstructFromEvents` skips it — but its usage is summed into
 * the conversation totals so the connector matches the runtime aggregator.
 */
interface AuxUsageEvent {
  ts: string;
  type: "aux.usage";
  source?: string;
  model?: string;
  usage?: UsageShape;
  llmMs?: number;
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
  output: string;
  resourceUri?: string;
  resourceLinks?: DisplayResourceLink[];
}

/**
 * `skills.loaded` — per-turn skill telemetry emitted after `run.start`. Entry
 * fields are all optional on the wire so historical events (which may carry a
 * subset, e.g. an older `loadedBy` vocabulary) parse without loss.
 */
interface SkillsLoadedEvent {
  ts: string;
  type: "skills.loaded";
  runId: string;
  skills?: Array<{
    id?: string;
    name?: string;
    connector?: string;
    scope?: "org" | "workspace" | "user" | "provided";
    tokens?: number;
    loadedBy?: string;
    reason?: string;
  }>;
  totalTokens?: number;
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
  | AuxUsageEvent
  | ToolStartEvent
  | ToolDoneEvent
  | SkillsLoadedEvent
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
function isAuxUsage(e: { type: string }): e is AuxUsageEvent {
  return e.type === "aux.usage";
}
function isToolStart(e: { type: string }): e is ToolStartEvent {
  return e.type === "tool.start";
}
function isToolDone(e: { type: string }): e is ToolDoneEvent {
  return e.type === "tool.done";
}
function isSkillsLoaded(e: { type: string }): e is SkillsLoadedEvent {
  return e.type === "skills.loaded";
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
  if (typeof raw.model !== "string" || raw.model.length === 0) return null;
  return {
    id: raw.id,
    createdAt: raw.createdAt,
    updatedAt: (raw.updatedAt as string) ?? raw.createdAt,
    title: (raw.title as string | null) ?? null,
    totalInputTokens: (raw.totalInputTokens as number) ?? 0,
    totalOutputTokens: (raw.totalOutputTokens as number) ?? 0,
    totalCostUsd: (raw.totalCostUsd as number) ?? 0,
    lastModel: (raw.lastModel as string | null) ?? null,
    model: raw.model,
    ...(raw.ownerId ? { ownerId: raw.ownerId as string } : {}),
    ...(raw.workspaceId ? { workspaceId: raw.workspaceId as string } : {}),
  };
}

interface DerivedMetrics {
  totalInputTokens: number;
  totalOutputTokens: number;
  lastModel: string | null;
  lastEventTs: string | null;
}

/** Fold one parsed event's usage into the running metrics accumulator. */
function accumulateEventMetrics(
  evt: KnownEvent & { ts: string; type: string },
  acc: DerivedMetrics,
): void {
  acc.lastEventTs = evt.ts;
  if (isLlmResponse(evt)) {
    acc.totalInputTokens += evt.usage.inputTokens;
    acc.totalOutputTokens += evt.usage.outputTokens;
    acc.lastModel = evt.model;
  } else if (isAuxUsage(evt)) {
    // Forked fast-slot calls (compaction/title) emit no
    // llm.response; count their usage so the app's totals match the
    // runtime aggregator (which counts aux.usage too).
    acc.totalInputTokens += evt.usage?.inputTokens ?? 0;
    acc.totalOutputTokens += evt.usage?.outputTokens ?? 0;
  }
}

function deriveMetricsFromLines(lines: string[]): DerivedMetrics {
  const acc: DerivedMetrics = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    lastModel: null,
    lastEventTs: null,
  };

  for (const line of lines) {
    const evt = parseEventLine(line);
    if (evt) accumulateEventMetrics(evt, acc);
  }

  return acc;
}

function applyDerivedMetrics(meta: ConversationMeta, metrics: DerivedMetrics): void {
  // Always overwrite with derived values — never fall back to the line-1
  // totals stored on disk. The line-1 totals were a stored-derived field
  // we deliberately stopped maintaining; preserving them here would
  // produce different totals than the runtime's index-cache, which now
  // always derives from events. Old conversations show zero totals.
  meta.totalInputTokens = metrics.totalInputTokens;
  meta.totalOutputTokens = metrics.totalOutputTokens;
  // Reset cost too — without this, a pre-PR conversation with line-1
  // `{ totalInputTokens: 1000, totalCostUsd: 5.50 }` would read back as
  // `{ totalInputTokens: 0, totalCostUsd: 5.50 }`: incoherent. The
  // app is intentionally pricing-decoupled (no model catalog), so 0
  // is the honest answer here. Consumers that want a real cost compute
  // it themselves from `(model, summed usage)`.
  meta.totalCostUsd = 0;
  meta.lastModel = metrics.lastModel;
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

/** Build the user DisplayMessage for a `user.message` event. */
function buildUserMessage(evt: UserMessageEvent): DisplayMessage {
  const text = extractText(evt.content);
  return {
    role: "user",
    content: text,
    blocks: text ? [{ type: "text", text }] : [],
    timestamp: evt.ts,
    ...(evt.userId ? { userId: evt.userId } : {}),
    ...(evt.files && evt.files.length > 0 ? { files: evt.files } : {}),
  };
}

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
      const msg = buildUserMessage(evt);
      messages.push(msg);
      if (!preview) preview = msg.content;
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

/** How a run ended: a clean terminal (run.done/run.error) or a foreign turn. */
type RunBoundary =
  | { kind: "terminal"; endTs: string; stopReason: string | undefined }
  | { kind: "foreign" };

/** Collected events for one run, plus how it ended and where to resume. */
interface RunScan {
  toolDones: Map<string, ToolDoneEvent>;
  toolInputs: Map<string, unknown>;
  llmResponses: LlmResponseEvent[];
  /** The run's most recent `skills.loaded`, projected — undefined if none. */
  skillsLoaded: DisplaySkillsContext | undefined;
  endTs: string;
  stopReason: string | undefined;
  terminated: boolean;
  abandoned: boolean;
  nextIndex: number;
}

/** One recorded entry → a display row, every field defaulted. */
function projectSkill(
  s: NonNullable<SkillsLoadedEvent["skills"]>[number] & { id: string; name: string },
) {
  return {
    id: s.id,
    name: s.name,
    ...(s.connector ? { connector: s.connector } : {}),
    scope: s.scope ?? "org",
    tokens: typeof s.tokens === "number" ? s.tokens : 0,
    loadedBy: typeof s.loadedBy === "string" ? s.loadedBy : "",
    reason: typeof s.reason === "string" ? s.reason : "",
  } satisfies DisplaySkill;
}

/**
 * Project a `skills.loaded` event to the display shape. Returns undefined for a
 * zero-skill turn so the ledger line is suppressed (absence is the signal).
 */
function projectSkillsLoaded(evt: SkillsLoadedEvent): DisplaySkillsContext | undefined {
  const skills: DisplaySkill[] = (evt.skills ?? [])
    .filter(
      (s): s is { id: string; name: string } & NonNullable<typeof s> =>
        typeof s?.id === "string" && typeof s.name === "string",
    )
    .map(projectSkill);
  if (skills.length === 0) return undefined;
  const totalTokens =
    typeof evt.totalTokens === "number"
      ? evt.totalTokens
      : skills.reduce((sum, s) => sum + s.tokens, 0);
  return { skills, totalTokens };
}

/**
 * Classify whether `inner` ends the run identified by `runId`. Returns how it
 * ended, or null for an interior event that belongs to (or is ignorable within)
 * the run.
 */
function classifyRunBoundary(inner: KnownEvent, runId: string): RunBoundary | null {
  if (isRunDone(inner) && inner.runId === runId) {
    return { kind: "terminal", endTs: inner.ts, stopReason: inner.stopReason };
  }
  if (isRunError(inner) && inner.runId === runId) {
    return { kind: "terminal", endTs: inner.ts, stopReason: "error" };
  }
  // Implicit run end: a foreign user.message or a different run's run.start
  // means this run never closed cleanly (process death / deploy bounce
  // mid-turn before a terminal event). Mirrors the sibling LLM-replay
  // projection's guard in src/conversation/event-reconstructor.ts. Without
  // this, an orphaned run swallows every subsequent turn and the transcript
  // appears to lose everything after the bounce (NimbleBrain prod incident: a
  // deploy-killed turn hid the next hour of an actively-used conversation on
  // reload). The scan begins at start + 1, so any run.start seen here is by
  // construction a foreign run.
  if (isUserMessage(inner) || isRunStart(inner)) {
    return { kind: "foreign" };
  }
  return null;
}

/** Fold an interior run event (llm.response / tool.start / tool.done) into the scan. */
function collectRunContentEvent(
  inner: KnownEvent,
  runId: string,
  into: {
    llmResponses: LlmResponseEvent[];
    toolInputs: Map<string, unknown>;
    toolDones: Map<string, ToolDoneEvent>;
  },
): void {
  if (isLlmResponse(inner) && inner.runId === runId) {
    into.llmResponses.push(inner);
  } else if (isToolStart(inner) && inner.runId === runId) {
    if (inner.input !== undefined) into.toolInputs.set(inner.id, inner.input);
  } else if (isToolDone(inner) && inner.runId === runId) {
    into.toolDones.set(inner.id, inner);
  }
}

/**
 * Scan forward from the run.start at `start`, collecting the run's events until
 * a terminal (run.done/run.error), an implicit end (a foreign turn), or the end
 * of the array. A run is "terminated" only on its own run.done/run.error; if the
 * scan runs off the END of the array first the turn was still in flight when the
 * file was read (caller marks it pending). A run cut short by a LATER turn is
 * `abandoned`, not pending.
 */
function scanRunEvents(events: KnownEvent[], start: number, runId: string): RunScan {
  const toolDones = new Map<string, ToolDoneEvent>();
  const toolInputs = new Map<string, unknown>();
  const llmResponses: LlmResponseEvent[] = [];
  let skillsLoaded: DisplaySkillsContext | undefined;

  let endTs = events[start]?.ts ?? "";
  let stopReason: string | undefined;
  let terminated = false;
  let abandoned = false;

  let i = start + 1;
  while (i < events.length) {
    const inner = events[i]!;
    const boundary = classifyRunBoundary(inner, runId);
    if (boundary) {
      if (boundary.kind === "terminal") {
        endTs = boundary.endTs;
        stopReason = boundary.stopReason;
        terminated = true;
        i++;
      } else {
        // Foreign turn: stop WITHOUT consuming the event (`i` stays put) so the
        // outer loop renders it as its own turn. It is `abandoned`, not pending.
        abandoned = true;
        stopReason = "interrupted";
      }
      break;
    }
    // `skills.loaded` rides inside the run span (emitted after run.start); the
    // last one for the run wins.
    if (isSkillsLoaded(inner) && inner.runId === runId) {
      skillsLoaded = projectSkillsLoaded(inner);
    }
    collectRunContentEvent(inner, runId, { llmResponses, toolInputs, toolDones });
    i++;
  }

  return {
    toolDones,
    toolInputs,
    llmResponses,
    skillsLoaded,
    endTs,
    stopReason,
    terminated,
    abandoned,
    nextIndex: i,
  };
}

/**
 * Reconstruct a single DisplayToolCall from a tool-call content part, joining it
 * with its tool.start input and tool.done result.
 */
function buildToolCall(
  tc: ContentPart,
  toolDones: Map<string, ToolDoneEvent>,
  toolInputs: Map<string, unknown>,
): DisplayToolCall {
  const toolCallId = tc.toolCallId ?? "";
  const done = toolDones.get(toolCallId);
  const inputFromStart = toolInputs.get(toolCallId);
  const input = parseToolInput(inputFromStart ?? tc.input);
  const ok = done?.ok ?? true;
  const name = tc.toolName ?? "";
  const appName = extractAppName(name);
  return {
    id: toolCallId,
    name,
    ...(appName ? { appName } : {}),
    status: ok ? "done" : "error",
    ok,
    ms: done?.ms ?? 0,
    input,
    // No `tool.done` yet (still running, or cut short): nothing to show.
    result: wrapOutputAsResult(done ? done.output : "", !ok),
    ...(done?.resourceUri ? { resourceUri: done.resourceUri } : {}),
    ...(done?.resourceLinks && done.resourceLinks.length > 0
      ? { resourceLinks: done.resourceLinks }
      : {}),
  };
}

/** Project a run's llm.responses into ordered display blocks and flattened tool calls. */
function buildRunBlocks(
  llmResponses: LlmResponseEvent[],
  toolDones: Map<string, ToolDoneEvent>,
  toolInputs: Map<string, unknown>,
): { blocks: DisplayBlock[]; flatToolCalls: DisplayToolCall[] } {
  const blocks: DisplayBlock[] = [];
  const flatToolCalls: DisplayToolCall[] = [];

  for (const llm of llmResponses) {
    // Reasoning content — collapse all reasoning parts in this response
    // into a single block. Emitted before text/tool blocks so the UI
    // renders the model's thinking above its visible output.
    const reasoningParts = llm.content.filter(
      (c): c is { type: "reasoning"; text: string } => c.type === "reasoning",
    );
    if (reasoningParts.length > 0) {
      const reasoningText = reasoningParts.map((r) => r.text).join("");
      if (reasoningText) blocks.push({ type: "reasoning", text: reasoningText });
    }

    // Text content — one text block per llm.response that has any text.
    const text = extractText(llm.content);
    if (text) blocks.push({ type: "text", text });

    // Tool-call content — one tool block per llm.response that has tool-calls.
    const toolCallParts = llm.content.filter((c) => c.type === "tool-call");
    if (toolCallParts.length > 0) {
      const tools = toolCallParts.map((tc) => buildToolCall(tc, toolDones, toolInputs));
      blocks.push({ type: "tool", toolCalls: tools });
      flatToolCalls.push(...tools);
    }
  }

  return { blocks, flatToolCalls };
}

/** Running usage totals across a run's llm.responses. */
interface UsageAccumulator {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  hasCacheReads: boolean;
  hasCacheWrites: boolean;
  hasReasoning: boolean;
  llmMs: number;
  model: string;
}

/**
 * Add one llm.response's usage into the accumulator. cacheWrite and reasoning
 * are carried so fork() can round-trip them; the chat UI doesn't render them
 * per-message today.
 */
function addLlmUsage(acc: UsageAccumulator, llm: LlmResponseEvent): void {
  acc.inputTokens += llm.usage.inputTokens;
  acc.outputTokens += llm.usage.outputTokens;
  const llmCacheRead = llm.usage.cacheReadTokens ?? 0;
  if (llmCacheRead > 0) {
    acc.hasCacheReads = true;
    acc.cacheReadTokens += llmCacheRead;
  }
  const llmCacheWrite = llm.usage.cacheWriteTokens ?? 0;
  if (llmCacheWrite > 0) {
    acc.hasCacheWrites = true;
    acc.cacheWriteTokens += llmCacheWrite;
  }
  const llmReasoning = llm.usage.reasoningTokens ?? 0;
  if (llmReasoning > 0) {
    acc.hasReasoning = true;
    acc.reasoningTokens += llmReasoning;
  }
  acc.llmMs += llm.llmMs;
  acc.model = llm.model;
}

/** Sum usage across a run's llm.responses into the aggregate DisplayUsage. */
function sumRunUsage(llmResponses: LlmResponseEvent[]): DisplayUsage {
  const acc: UsageAccumulator = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    hasCacheReads: false,
    hasCacheWrites: false,
    hasReasoning: false,
    llmMs: 0,
    model: "",
  };

  for (const llm of llmResponses) addLlmUsage(acc, llm);

  return {
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    ...(acc.hasCacheReads ? { cacheReadTokens: acc.cacheReadTokens } : {}),
    ...(acc.hasCacheWrites ? { cacheWriteTokens: acc.cacheWriteTokens } : {}),
    ...(acc.hasReasoning ? { reasoningTokens: acc.reasoningTokens } : {}),
    model: acc.model,
    llmMs: acc.llmMs,
  };
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
  const scan = scanRunEvents(events, start, runId);
  if (scan.llmResponses.length === 0) return [null, scan.nextIndex];

  const { blocks, flatToolCalls } = buildRunBlocks(
    scan.llmResponses,
    scan.toolDones,
    scan.toolInputs,
  );
  const usage = sumRunUsage(scan.llmResponses);

  const contentText = blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");

  const msg: DisplayMessage = {
    role: "assistant",
    content: contentText,
    blocks,
    timestamp: scan.endTs,
    ...(flatToolCalls.length > 0 ? { toolCalls: flatToolCalls } : {}),
    usage,
    ...(scan.skillsLoaded ? { skillsLoaded: scan.skillsLoaded } : {}),
    ...(scan.stopReason && scan.stopReason !== "complete" ? { stopReason: scan.stopReason } : {}),
    // `pending` only for a TRULY trailing in-flight run (ran off the end of the
    // array). An `abandoned` run has a later turn after it, so it can never be
    // in flight — stamping it pending would show a perpetual "still thinking"
    // spinner on an old turn (and chat-store's trailing-pending trim doesn't
    // apply to an interior turn anyway). It carries stopReason "interrupted".
    ...(scan.terminated || scan.abandoned ? {} : { pending: true }),
  };
  return [msg, scan.nextIndex];
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
// Public API
// ---------------------------------------------------------------------------

/** Read and parse a single JSONL file. Returns null if missing or empty. */
/**
 * Settle a trailing run that never wrote a terminator.
 *
 * `collectRun` marks such a run `pending` — "still coming" — because from the
 * event log alone it cannot tell an in-flight turn from one whose writer died.
 * An INTERIOR unterminated run has a later turn to prove it stopped, and is
 * already `abandoned` with `stopReason: "interrupted"`. A trailing one has no
 * such successor, so the proof has to come from outside the file: whether a run
 * is live for this conversation right now, which only the RunBus knows.
 *
 * Given that proof, the trailing case is the interior case — same outcome, same
 * stopReason. `pending` is only ever set on the last message (anything followed
 * by another turn is `abandoned` by construction), so correcting it here is
 * equivalent to threading liveness through reconstruction, with one call site
 * instead of three.
 */
function settleTrailingRun(messages: DisplayMessage[]): void {
  const last = messages[messages.length - 1];
  if (!last?.pending) return;
  const { pending: _wasPending, ...rest } = last;
  messages[messages.length - 1] = {
    ...rest,
    stopReason: last.stopReason ?? "interrupted",
  };
}

export async function readConversation(
  filePath: string,
  opts?: {
    /**
     * Whether a run is generating for this conversation right now. Defaults to
     * `false`: a caller with no liveness signal is not the live viewer, and
     * assuming a turn is still coming is the failure this parameter exists to
     * end — it renders a dead turn as a perpetual spinner.
     */
    runActive?: boolean;
  },
): Promise<ConversationFile | null> {
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
  const { messages, messageCount, preview } = reconstructFromEvents(dataLines);

  applyDerivedMetrics(meta, deriveMetricsFromLines(dataLines));
  deriveTitleFromEvents(meta, dataLines);

  if (!opts?.runActive) settleTrailingRun(messages);

  return { meta, messages, messageCount, preview };
}

/**
 * A header read in progress: everything the summary is folded from, plus where
 * in the file the fold stopped.
 *
 * Conversation files are append-only event logs, so a change to one is new
 * lines at its end. Resuming from `offset` makes a re-read cost the bytes
 * appended since the last one instead of the whole file, which is what keeps a
 * list refresh during a turn on a long conversation from re-parsing megabytes
 * on the event loop after every tool call. `ino` and `line1` detect the cases
 * where the file is not the one the fold read (replaced, rewritten, truncated);
 * those start over.
 */
export interface HeaderScan {
  /** Line 1 as read, before event-derived fields are applied. */
  meta: ConversationMeta;
  /** The file's text through line 1, compared against its first bytes on resume. */
  line1: string;
  ino: number;
  /** Bytes folded so far: always just past a newline, or the end of a final line that parsed. */
  offset: number;
  preview: string;
  /** The last `metadata.title` event's title, when one has been seen. */
  title?: string;
  userMessages: number;
  runStarts: string[];
  runsWithResponse: Set<string>;
  metrics: DerivedMetrics;
}

/**
 * Fold one event line into the scan. One `JSON.parse` per line.
 *
 * Each field keeps the rule it has always had, because the header must agree
 * with {@link readConversation} on the same file:
 *
 * - The preview is the first user message with text. An empty user message is
 *   not an answer, so the search continues past one (a picture with no caption
 *   still needs a preview).
 * - The count is messages, not lines. One turn is a `run.start`, an
 *   `llm.response`, any number of `tool.*` pairs and a `run.done`, so this
 *   mirrors `reconstructFromEvents`: every `user.message`, plus every run that
 *   produced at least one `llm.response`.
 * - The title is the last `metadata.title` event's.
 * - Totals, last model and `updatedAt` come from events that carry `ts` and
 *   `type`, through {@link accumulateEventMetrics}.
 *
 * Returns false when the line is not JSON.
 */
function foldHeaderLine(scan: HeaderScan, line: string): boolean {
  let parsed: Record<string, unknown> & { ts?: string; type?: string };
  try {
    parsed = JSON.parse(line);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== "object") return true;
  foldHeaderEvent(scan, parsed);
  if (parsed.ts && parsed.type) {
    // Same narrowing as `parseEventLine`: a line with `ts` and `type` is read
    // as an event, and `accumulateEventMetrics` keys on `type` alone.
    accumulateEventMetrics(parsed as KnownEvent & { ts: string; type: string }, scan.metrics);
  }
  return true;
}

/** The preview, count and title parts of {@link foldHeaderLine}. */
function foldHeaderEvent(scan: HeaderScan, parsed: Record<string, unknown>): void {
  const runId = typeof parsed.runId === "string" ? parsed.runId : null;
  if (parsed.type === "user.message") {
    scan.userMessages++;
    if (!scan.preview && Array.isArray(parsed.content)) {
      scan.preview = extractText(parsed.content as ContentPart[]);
    }
  } else if (parsed.type === "run.start" && runId) {
    scan.runStarts.push(runId);
  } else if (parsed.type === "llm.response" && runId) {
    scan.runsWithResponse.add(runId);
  } else if (parsed.type === "metadata.title" && typeof parsed.title === "string") {
    scan.title = parsed.title;
  }
}

/**
 * Fold the complete lines of `text` into the scan and return how much of it
 * was consumed, in string length.
 *
 * A final line without a newline is folded only when it parses: an append in
 * flight is left for the next read rather than skipped as malformed and then
 * stepped over for good.
 */
function foldHeaderText(scan: HeaderScan, text: string): number {
  const lastNl = text.lastIndexOf("\n");
  for (const line of text.slice(0, Math.max(lastNl, 0)).split("\n")) {
    if (line) foldHeaderLine(scan, line);
  }
  const tail = text.slice(lastNl + 1);
  if (tail && foldHeaderLine(scan, tail)) return text.length;
  return lastNl + 1;
}

/**
 * Read a conversation file's header state, resuming from `prior` when the file
 * has only grown since that read.
 *
 * Returns null when the file is missing, empty, or line 1 is not conversation
 * metadata. A resumed read still opens the file and checks it is the same one
 * (inode, line 1, not shorter); anything else is read again from the start.
 */
export async function scanConversationHeader(
  filePath: string,
  prior?: HeaderScan,
): Promise<HeaderScan | null> {
  let handle: FileHandle;
  try {
    handle = await open(filePath, "r");
  } catch {
    return null;
  }
  try {
    const { ino, size } = await handle.stat();
    if (prior && prior.ino === ino && size >= prior.offset) {
      const line1Bytes = Buffer.byteLength(prior.line1);
      const head = Buffer.alloc(line1Bytes);
      const headRead = await handle.read(head, 0, line1Bytes, 0);
      if (head.toString("utf8", 0, headRead.bytesRead) === prior.line1) {
        const scan = cloneScan(prior);
        if (size > prior.offset) {
          const buf = Buffer.alloc(size - prior.offset);
          const { bytesRead } = await handle.read(buf, 0, buf.length, prior.offset);
          const text = buf.toString("utf8", 0, bytesRead);
          scan.offset += Buffer.byteLength(text.slice(0, foldHeaderText(scan, text)));
        }
        return scan;
      }
    }

    const content = (await handle.readFile()).toString("utf8");
    // Line 1 is the first non-empty line. `line1` keeps any blank lines before
    // it, so a resumed read can compare it against the file's first bytes.
    const leading = content.length - content.replace(/^\n+/, "").length;
    const lineEnd = content.indexOf("\n", leading);
    const firstEnd = lineEnd < 0 ? content.length : lineEnd;
    if (firstEnd === leading) return null;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(content.slice(leading, firstEnd)) as Record<string, unknown>;
    } catch {
      return null;
    }
    const meta = parseMeta(raw);
    if (!meta) return null;

    const scan: HeaderScan = {
      meta,
      line1: content.slice(0, firstEnd),
      ino,
      offset: 0,
      preview: "",
      userMessages: 0,
      runStarts: [],
      runsWithResponse: new Set(),
      metrics: { totalInputTokens: 0, totalOutputTokens: 0, lastModel: null, lastEventTs: null },
    };
    const afterLine1 = Math.min(firstEnd + 1, content.length);
    const consumed = foldHeaderText(scan, content.slice(afterLine1));
    scan.offset = Buffer.byteLength(content.slice(0, afterLine1 + consumed));
    return scan;
  } finally {
    await handle.close();
  }
}

function cloneScan(scan: HeaderScan): HeaderScan {
  return {
    ...scan,
    meta: { ...scan.meta },
    runStarts: [...scan.runStarts],
    runsWithResponse: new Set(scan.runsWithResponse),
    metrics: { ...scan.metrics },
  };
}

/** The summary a scan describes: line-1 metadata with the event-derived fields applied. */
export function headerOfScan(scan: HeaderScan): {
  meta: ConversationMeta;
  preview: string;
  messageCount: number;
} {
  const meta = { ...scan.meta };
  if (scan.title !== undefined) meta.title = scan.title;
  applyDerivedMetrics(meta, scan.metrics);
  const messageCount =
    scan.userMessages + scan.runStarts.filter((runId) => scan.runsWithResponse.has(runId)).length;
  return { meta, preview: scan.preview, messageCount };
}

/** Fast header read — metadata + preview + count, no message reconstruction. */
export async function readConversationHeader(
  filePath: string,
): Promise<{ meta: ConversationMeta; preview: string; messageCount: number } | null> {
  const scan = await scanConversationHeader(filePath);
  return scan ? headerOfScan(scan) : null;
}

/** Collect `.jsonl` file paths under a workspace's `conversations/<ownerId>/` partitions. */
function listWorkspaceConversationFiles(convRoot: string): string[] {
  const out: string[] = [];
  for (const ownerId of safeReaddir(convRoot)) {
    const ownerDir = join(convRoot, ownerId);
    for (const f of safeReaddir(ownerDir)) {
      if (f.endsWith(".jsonl")) out.push(join(ownerDir, f));
    }
  }
  return out;
}

/**
 * A conversation file plus the workspace it lives in.
 *
 * `wsId` comes from the directory the walk descended through, which is the
 * authoritative binding — the `workspaceId` on line 1 is a denormalised
 * convenience and can disagree.
 */
export interface ConversationFileRef {
  filePath: string;
  wsId: string;
}

/**
 * Conversation JSONL file paths under `dir`, the workspaces root: each
 * workspace's `conversations/` holds one `<ownerId>/` partition per member.
 * Self-contained (no runtime imports) so the app stays independently
 * deployable.
 */
export function listConversationFiles(dir: string): ConversationFileRef[] {
  const out: ConversationFileRef[] = [];
  let top: Dirent[];
  try {
    top = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const ent of top) {
    if (!ent.isDirectory() || !ent.name.startsWith("ws_")) continue;
    // Workspace-owned layout: each workspace's conversations subtree. The
    // directory name IS the workspace, so no path re-parsing is needed.
    // lint-ok:conversation-path
    const convRoot = join(dir, ent.name, "conversations");
    for (const filePath of listWorkspaceConversationFiles(convRoot)) {
      out.push({ filePath, wsId: ent.name });
    }
  }
  return out;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
