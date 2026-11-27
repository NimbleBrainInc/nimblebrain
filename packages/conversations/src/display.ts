/**
 * A conversation's display projection: one message per user turn and per run, with ordered
 * blocks, folded from its stored events. This is what `get` returns and what `export` and
 * `stats` read. It is the plugin's own; the host builds a model's context separately.
 */

// ── The display shape (the contract's `get_output` messages) ────────────────

export interface DisplayResourceLink {
  uri: string;
  name?: string;
  mimeType?: string;
  description?: string;
}

export interface DisplayToolResult {
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError: boolean;
}

export interface DisplayToolCall {
  id: string;
  name: string;
  appName?: string;
  status: "done" | "error";
  ok: boolean;
  ms: number;
  input: Record<string, unknown>;
  result: DisplayToolResult;
  resourceUri?: string;
  resourceLinks?: DisplayResourceLink[];
}

export type DisplayBlock =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool"; toolCalls: DisplayToolCall[] };

export interface DisplayUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  model: string;
  llmMs: number;
}

export interface DisplaySkill {
  id: string;
  name: string;
  connector?: string;
  scope: string;
  tokens: number;
  loadedBy: string;
  reason: string;
}

export interface DisplaySkillsContext {
  skills: DisplaySkill[];
  totalTokens: number;
}

export interface DisplayMessage {
  role: "user" | "assistant";
  content: string;
  blocks: DisplayBlock[];
  timestamp: string;
  userId?: string;
  toolCalls?: DisplayToolCall[];
  usage?: DisplayUsage;
  files?: unknown[];
  pluginRequestAnswer?: unknown;
  stopReason?: string;
  pending?: boolean;
  skillsLoaded?: DisplaySkillsContext;
}

// ── Stored events, as this projection reads them ───────────────────────────

/** One part of a stored content list: opaque, read field by field. */
type ContentPart = Record<string, unknown>;

interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

interface UserMessageEvent {
  ts: string;
  type: "user.message";
  content: ContentPart[];
  userId?: string;
  files?: unknown[];
  pluginRequestAnswer?: unknown;
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
  usage: Usage;
  llmMs: number;
}
interface AuxUsageEvent {
  ts: string;
  type: "aux.usage";
  usage?: Usage;
}
interface ToolStartEvent {
  ts: string;
  type: "tool.start";
  runId: string;
  id: string;
  input?: unknown;
}
interface ToolDoneEvent {
  ts: string;
  type: "tool.done";
  runId: string;
  id: string;
  ok: boolean;
  ms: number;
  output: string;
  resourceUri?: string;
  resourceLinks?: DisplayResourceLink[];
  /** The call did not run: it was held for its tool's guidance. */
  held?: true;
}
interface SkillsLoadedEvent {
  ts: string;
  type: "skills.loaded";
  runId: string;
  skills?: Array<{
    id?: string;
    name?: string;
    connector?: string;
    scope?: string;
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
}

export type KnownEvent =
  | UserMessageEvent
  | RunStartEvent
  | LlmResponseEvent
  | AuxUsageEvent
  | ToolStartEvent
  | ToolDoneEvent
  | SkillsLoadedEvent
  | RunDoneEvent
  | RunErrorEvent;

/** A stored event as this projection reads it: anything with a `ts` and a `type`. */
export type ReadEvent = KnownEvent | { ts: string; type: string };

const is =
  <T extends KnownEvent>(type: T["type"]) =>
  (e: ReadEvent): e is T =>
    e.type === type;
const isUserMessage = is<UserMessageEvent>("user.message");
const isRunStart = is<RunStartEvent>("run.start");
const isLlmResponse = is<LlmResponseEvent>("llm.response");
const isAuxUsage = is<AuxUsageEvent>("aux.usage");
const isToolStart = is<ToolStartEvent>("tool.start");
const isToolDone = is<ToolDoneEvent>("tool.done");
const isSkillsLoaded = is<SkillsLoadedEvent>("skills.loaded");
const isRunDone = is<RunDoneEvent>("run.done");
const isRunError = is<RunErrorEvent>("run.error");

/** An event line as this projection reads it: JSON with a non-empty string `ts` and `type`. */
export function parseEventLine(line: string): ReadEvent | null {
  try {
    const parsed = JSON.parse(line) as { ts?: unknown; type?: unknown };
    if (!isRecord(parsed)) return null;
    if (typeof parsed.ts !== "string" || typeof parsed.type !== "string") return null;
    if (!parsed.ts || !parsed.type) return null;
    return parsed as ReadEvent;
  } catch {
    return null;
  }
}

// ── Reading opaque payloads ────────────────────────────────────────────────
// Event payloads are opaque: every field a projection reads may be any JSON value. These
// read a field as the shape a projection expects, and as absent when it is anything else.

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
/** A content list's parts that are objects; anything else in it, or no list, is none. */
const partsOf = (content: unknown): ContentPart[] =>
  Array.isArray(content) ? content.filter(isRecord) : [];
const usageOf = (usage: unknown): Partial<Usage> => (isRecord(usage) ? usage : {});

export function extractText(content: unknown): string {
  return partsOf(content)
    .map((p) => (p.type === "text" && typeof p.text === "string" ? p.text : ""))
    .join("");
}

/**
 * The text a person wrote in a user message: its text parts, less those the host marked
 * `attached` (an attachment's extracted text or a note naming it, which the model reads and
 * the message shows as its `files`).
 */
export function personText(content: unknown): string {
  return partsOf(content)
    .map((p) =>
      p.type === "text" && p.attached !== true && typeof p.text === "string" ? p.text : "",
    )
    .join("");
}

// ── Metrics derived from events ────────────────────────────────────────────

export interface DerivedMetrics {
  totalInputTokens: number;
  totalOutputTokens: number;
  lastModel: string | null;
  lastEventTs: string | null;
}

export const emptyMetrics = (): DerivedMetrics => ({
  totalInputTokens: 0,
  totalOutputTokens: 0,
  lastModel: null,
  lastEventTs: null,
});

/**
 * Fold one event into the running totals: model calls and the forked calls (`aux.usage`)
 * that run outside a turn both count; the last event's `ts` is the last activity.
 */
export function accumulateEventMetrics(evt: ReadEvent, acc: DerivedMetrics): void {
  acc.lastEventTs = evt.ts;
  if (isLlmResponse(evt) || isAuxUsage(evt)) {
    const usage = usageOf(evt.usage);
    acc.totalInputTokens += num(usage.inputTokens);
    acc.totalOutputTokens += num(usage.outputTokens);
  }
  if (isLlmResponse(evt)) acc.lastModel = str(evt.model) ?? acc.lastModel;
}

// ── Reconstruction ─────────────────────────────────────────────────────────

function buildUserMessage(evt: UserMessageEvent): DisplayMessage {
  const text = personText(evt.content);
  return {
    role: "user",
    content: text,
    blocks: text ? [{ type: "text", text }] : [],
    timestamp: evt.ts,
    ...(str(evt.userId) ? { userId: evt.userId } : {}),
    ...(Array.isArray(evt.files) && evt.files.length > 0 ? { files: evt.files } : {}),
    ...(evt.pluginRequestAnswer ? { pluginRequestAnswer: evt.pluginRequestAnswer } : {}),
  };
}

/**
 * Walk events in order: each `user.message` is one user message, and each run from
 * `run.start` to its `run.done` or `run.error` is one assistant message whose blocks follow
 * its model calls in order. A run cut short by a later turn is `interrupted`; a run that
 * runs off the end is `pending`.
 */
function reconstruct(events: ReadEvent[]): DisplayMessage[] {
  const messages: DisplayMessage[] = [];
  for (let i = 0; i < events.length; ) {
    const evt = events[i]!;
    // A message that cannot be projected is left out; the events after it still are.
    try {
      if (isUserMessage(evt)) {
        messages.push(buildUserMessage(evt));
      } else if (isRunStart(evt)) {
        const [msg, next] = collectRun(events, i, evt.runId);
        if (msg) messages.push(msg);
        i = next;
        continue;
      }
    } catch {
      // skipped: the next event is read on its own
    }
    i++;
  }
  return messages;
}

interface RunScan {
  toolDones: Map<string, ToolDoneEvent>;
  toolInputs: Map<string, unknown>;
  llmResponses: LlmResponseEvent[];
  skillsLoaded: DisplaySkillsContext | undefined;
  endTs: string;
  stopReason: string | undefined;
  terminated: boolean;
  abandoned: boolean;
  nextIndex: number;
}

function projectSkillsLoaded(evt: SkillsLoadedEvent): DisplaySkillsContext | undefined {
  const entries = Array.isArray(evt.skills) ? evt.skills.filter(isRecord) : [];
  const skills: DisplaySkill[] = entries
    .filter(
      (s): s is { id: string; name: string } & NonNullable<typeof s> =>
        typeof s.id === "string" && typeof s.name === "string",
    )
    .map((s) => ({
      id: s.id,
      name: s.name,
      ...(typeof s.connector === "string" ? { connector: s.connector } : {}),
      scope: str(s.scope) ?? "org",
      tokens: typeof s.tokens === "number" ? s.tokens : 0,
      loadedBy: typeof s.loadedBy === "string" ? s.loadedBy : "",
      reason: typeof s.reason === "string" ? s.reason : "",
    }));
  if (skills.length === 0) return undefined;
  const totalTokens =
    typeof evt.totalTokens === "number"
      ? evt.totalTokens
      : skills.reduce((sum, s) => sum + s.tokens, 0);
  return { skills, totalTokens };
}

type RunBoundary =
  | { kind: "terminal"; endTs: string; stopReason: string | undefined }
  | { kind: "foreign" };

function classifyRunBoundary(inner: ReadEvent, runId: string): RunBoundary | null {
  if (isRunDone(inner) && inner.runId === runId) {
    return { kind: "terminal", endTs: inner.ts, stopReason: str(inner.stopReason) };
  }
  if (isRunError(inner) && inner.runId === runId) {
    return { kind: "terminal", endTs: inner.ts, stopReason: "error" };
  }
  // A later turn (a user message, or another run's start) ends a run that never closed.
  if (isUserMessage(inner) || isRunStart(inner)) return { kind: "foreign" };
  return null;
}

function collectRunContent(inner: ReadEvent, runId: string, into: RunScan): void {
  if (isLlmResponse(inner) && inner.runId === runId) {
    into.llmResponses.push(inner);
  } else if (isToolStart(inner) && inner.runId === runId) {
    if (inner.input !== undefined && str(inner.id)) into.toolInputs.set(inner.id, inner.input);
  } else if (isToolDone(inner) && inner.runId === runId && str(inner.id)) {
    into.toolDones.set(inner.id, inner);
  } else if (isSkillsLoaded(inner) && inner.runId === runId) {
    into.skillsLoaded = projectSkillsLoaded(inner);
  }
}

function scanRun(events: ReadEvent[], start: number, runId: string): RunScan {
  const scan: RunScan = {
    toolDones: new Map(),
    toolInputs: new Map(),
    llmResponses: [],
    skillsLoaded: undefined,
    endTs: events[start]?.ts ?? "",
    stopReason: undefined,
    terminated: false,
    abandoned: false,
    nextIndex: start + 1,
  };
  let i = start + 1;
  for (; i < events.length; i++) {
    const inner = events[i]!;
    const boundary = classifyRunBoundary(inner, runId);
    if (boundary?.kind === "terminal") {
      scan.endTs = boundary.endTs;
      scan.stopReason = boundary.stopReason;
      scan.terminated = true;
      i++;
      break;
    }
    if (boundary?.kind === "foreign") {
      // Not consumed: the later turn renders as its own message.
      scan.abandoned = true;
      scan.stopReason = "interrupted";
      break;
    }
    collectRunContent(inner, runId, scan);
  }
  scan.nextIndex = i;
  return scan;
}

function extractAppName(name: string): string | undefined {
  const idx = name.indexOf("__");
  return idx === -1 ? undefined : name.slice(0, idx);
}

/** A stored tool input may be a JSON string; anything but a JSON object reads as `{}`. */
function parseToolInput(input: unknown): Record<string, unknown> {
  let value = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch {
      return {};
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function buildToolCall(tc: ContentPart, scan: RunScan): DisplayToolCall {
  const toolCallId = str(tc.toolCallId) ?? "";
  const done = scan.toolDones.get(toolCallId);
  const input = parseToolInput(scan.toolInputs.get(toolCallId) ?? tc.input);
  const ok = typeof done?.ok === "boolean" ? done.ok : true;
  const name = str(tc.toolName) ?? "";
  const appName = extractAppName(name);
  const text = str(done?.output) ?? "";
  return {
    id: toolCallId,
    name,
    ...(appName ? { appName } : {}),
    status: ok ? "done" : "error",
    ok,
    ms: num(done?.ms),
    input,
    result: { content: text ? [{ type: "text", text }] : [], isError: !ok },
    ...(str(done?.resourceUri) ? { resourceUri: done?.resourceUri } : {}),
    ...(Array.isArray(done?.resourceLinks) && done.resourceLinks.length > 0
      ? { resourceLinks: done.resourceLinks }
      : {}),
  };
}

function buildRunBlocks(scan: RunScan): { blocks: DisplayBlock[]; toolCalls: DisplayToolCall[] } {
  const blocks: DisplayBlock[] = [];
  const toolCalls: DisplayToolCall[] = [];
  for (const llm of scan.llmResponses) {
    const parts = partsOf(llm.content);
    const reasoning = parts
      .filter((c) => c.type === "reasoning")
      .map((c) => str(c.text) ?? "")
      .join("");
    if (reasoning) blocks.push({ type: "reasoning", text: reasoning });
    const text = extractText(parts);
    if (text) blocks.push({ type: "text", text });
    // A call held for its tool's guidance ran nothing; its re-issue is the one shown.
    const calls = parts
      .filter(
        (c) => c.type === "tool-call" && scan.toolDones.get(str(c.toolCallId) ?? "")?.held !== true,
      )
      .map((tc) => buildToolCall(tc, scan));
    if (calls.length > 0) {
      blocks.push({ type: "tool", toolCalls: calls });
      toolCalls.push(...calls);
    }
  }
  return { blocks, toolCalls };
}

function sumRunUsage(llmResponses: LlmResponseEvent[]): DisplayUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let reasoning = 0;
  let llmMs = 0;
  let model = "";
  for (const llm of llmResponses) {
    const usage = usageOf(llm.usage);
    inputTokens += num(usage.inputTokens);
    outputTokens += num(usage.outputTokens);
    cacheRead += Math.max(num(usage.cacheReadTokens), 0);
    cacheWrite += Math.max(num(usage.cacheWriteTokens), 0);
    reasoning += Math.max(num(usage.reasoningTokens), 0);
    llmMs += num(llm.llmMs);
    model = str(llm.model) ?? model;
  }
  return {
    inputTokens,
    outputTokens,
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
    ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
    model,
    llmMs,
  };
}

/**
 * A run that produced no model response: shown only once it is known to have ended without
 * completing (its terminator says why, or a later turn cut it off), as an assistant message
 * with no text that carries the reason. A run still open, or one that completed with
 * nothing to say, shows nothing.
 */
function unansweredRun(scan: RunScan): DisplayMessage | null {
  const ended = scan.abandoned || scan.terminated;
  if (!ended || !scan.stopReason || scan.stopReason === "complete") return null;
  return {
    role: "assistant",
    content: "",
    blocks: [],
    timestamp: scan.endTs,
    stopReason: scan.stopReason,
  };
}

function collectRun(
  events: ReadEvent[],
  start: number,
  runId: string,
): [DisplayMessage | null, number] {
  const scan = scanRun(events, start, runId);
  if (scan.llmResponses.length === 0) return [unansweredRun(scan), scan.nextIndex];
  const { blocks, toolCalls } = buildRunBlocks(scan);
  const content = blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
  const msg: DisplayMessage = {
    role: "assistant",
    content,
    blocks,
    timestamp: scan.endTs,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    usage: sumRunUsage(scan.llmResponses),
    ...(scan.skillsLoaded ? { skillsLoaded: scan.skillsLoaded } : {}),
    ...(scan.stopReason && scan.stopReason !== "complete" ? { stopReason: scan.stopReason } : {}),
    ...(scan.terminated || scan.abandoned ? {} : { pending: true }),
  };
  return [msg, scan.nextIndex];
}

/**
 * A trailing run with no terminator is `pending` only while a reply is generating for the
 * conversation. Otherwise its writer stopped, and it reads as an interrupted run does.
 */
function settleTrailingRun(messages: DisplayMessage[]): void {
  const last = messages[messages.length - 1];
  if (!last?.pending) return;
  const { pending: _pending, ...rest } = last;
  messages[messages.length - 1] = { ...rest, stopReason: last.stopReason ?? "interrupted" };
}

// ── A whole conversation ───────────────────────────────────────────────────

/** Line 1 of a conversation file: what `create` recorded. */
export interface ConversationHeader {
  id: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  ownerId: string;
  lastModel: string | null;
  metadata?: Record<string, unknown>;
}

/** A conversation's summary: its header with the fields events decide applied. */
export interface ConversationMeta {
  id: string;
  createdAt: string;
  updatedAt: string;
  title: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  lastModel: string | null;
  model: string;
  ownerId: string;
}

export interface DisplayConversation {
  meta: ConversationMeta;
  messages: DisplayMessage[];
  messageCount: number;
}

/** Apply event-derived totals, last model and last activity to a header. */
export function metaOf(
  header: ConversationHeader,
  metrics: DerivedMetrics,
  title: string | null,
): ConversationMeta {
  return {
    id: header.id,
    createdAt: header.createdAt,
    updatedAt: metrics.lastEventTs ?? header.updatedAt,
    title,
    totalInputTokens: metrics.totalInputTokens,
    totalOutputTokens: metrics.totalOutputTokens,
    lastModel: metrics.lastModel,
    model: header.model,
    ownerId: header.ownerId,
  };
}

/** The title: the last `metadata.title` event's. */
export function titleOf(events: ReadEvent[]): string | null {
  let title: string | null = null;
  for (const e of events) {
    const t = (e as { title?: unknown }).title;
    if (e.type === "metadata.title" && typeof t === "string") title = t;
  }
  return title;
}

/**
 * Project a conversation from its header and its event lines (every line after line 1).
 * `runActive` says a reply is generating for it now, so a trailing open run stays pending.
 */
export function projectConversation(
  header: ConversationHeader,
  eventLines: string[],
  runActive: boolean,
): DisplayConversation {
  const events = eventLines.map(parseEventLine).filter((e): e is ReadEvent => e !== null);
  const messages = reconstruct(events);
  const metrics = emptyMetrics();
  for (const e of events) {
    try {
      accumulateEventMetrics(e, metrics);
    } catch {
      // an event whose totals cannot be read adds none
    }
  }
  if (!runActive) settleTrailingRun(messages);
  return {
    meta: metaOf(header, metrics, titleOf(events)),
    messages,
    messageCount: messages.length,
  };
}
