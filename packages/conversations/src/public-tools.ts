/**
 * The contract's public tools over the store: what people and agents read. Each takes its
 * input (already checked against the contract's input schema) and the call's scope, and
 * returns the contract's output. A failure throws a `ToolCallError` with a public code.
 */

import { ToolCallError } from "../../plugin-sdk/src/index.ts";
import {
  type DisplayMessage,
  type DisplayToolCall,
  isRecord,
  projectConversation,
} from "./display.ts";
import { CorruptConversationError, summaryOf } from "./scan.ts";
import {
  ConversationNotFoundError,
  type ConversationStore,
  type Found,
  type Scope,
} from "./store.ts";

const NOT_FOUND = "Conversation not found: ";

export const notFound = (id: string) =>
  new ToolCallError("conversation_not_found", `${NOT_FOUND}${id}`);

// ── Previews ───────────────────────────────────────────────────────────────

/** The longest preview a response carries. */
export const PREVIEW_MAX_CHARS = 200;

/**
 * Cap a preview on its way out, at a word boundary in the last quarter when there is one.
 * A preview is a conversation's first user message, so uncapped it carries a whole pasted
 * document into every response that lists it. The stored preview stays whole, so `list`'s
 * `search` still matches text past the cap.
 */
export function capPreview(text: string): string {
  if (text.length <= PREVIEW_MAX_CHARS) return text;
  const head = text.slice(0, PREVIEW_MAX_CHARS - 1);
  const lastSpace = head.lastIndexOf(" ");
  const cut = lastSpace > PREVIEW_MAX_CHARS * 0.75 ? head.slice(0, lastSpace) : head;
  return `${cut}…`;
}

// ── list ───────────────────────────────────────────────────────────────────

export interface Row {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  lastModel: string | null;
  preview: string;
  ownerId: string;
  workspaceId: string;
}

function rowOf(found: Found, workspaceId: string): Row {
  const { meta, preview, messageCount } = summaryOf(found.scan);
  return {
    id: found.id,
    title: meta.title,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    messageCount,
    totalInputTokens: meta.totalInputTokens,
    totalOutputTokens: meta.totalOutputTokens,
    lastModel: meta.lastModel,
    preview,
    ownerId: meta.ownerId,
    workspaceId,
  };
}

type SortBy = "created" | "updated";
const sortKeyOf = (row: Row, sortBy: SortBy) =>
  sortBy === "created" ? row.createdAt : row.updatedAt;

/** Newest first; ties broken by id, so the order is total and a cursor has one place. */
function compareRows(a: { key: string; id: string }, b: { key: string; id: string }): number {
  return b.key.localeCompare(a.key) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

/**
 * A cursor is the position of the last row returned: its sort key and id, and the sort it
 * belongs to. The next page is every row after that position, so a conversation created
 * between pages never shifts one already returned or yet to come.
 */
interface CursorPoint {
  sortBy: SortBy;
  key: string;
  id: string;
}

function encodeCursor(point: CursorPoint): string {
  return Buffer.from(JSON.stringify([point.sortBy, point.key, point.id])).toString("base64url");
}

function decodeCursor(cursor: string, sortBy: SortBy): CursorPoint {
  try {
    const [s, key, id] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown[];
    if (s === sortBy && typeof key === "string" && typeof id === "string") {
      return { sortBy, key, id };
    }
  } catch {
    // falls through to the refusal
  }
  throw new ToolCallError(
    "invalid_input",
    `Invalid arguments for "list": cursor is not one this server issued for sortBy "${sortBy}"`,
  );
}

export interface ListInput {
  limit?: number;
  cursor?: string;
  search?: string;
  sortBy?: SortBy;
  dateFrom?: string;
  dateTo?: string;
}

export interface ListPage {
  conversations: Row[];
  nextCursor: string | null;
  totalCount: number;
}

/** The rows in scope that match the filters, newest first. */
export async function rowsInScope(
  store: ConversationStore,
  scope: Scope,
  input: Pick<ListInput, "search" | "sortBy" | "dateFrom" | "dateTo">,
): Promise<Row[]> {
  let rows = (await store.list(scope)).map((f) => rowOf(f, scope.workspaceId));
  if (input.search) {
    const q = input.search.toLowerCase();
    rows = rows.filter(
      (r) => (r.title?.toLowerCase().includes(q) ?? false) || r.preview.toLowerCase().includes(q),
    );
  }
  const { dateFrom, dateTo } = input;
  if (dateFrom) rows = rows.filter((r) => r.createdAt >= dateFrom);
  if (dateTo) rows = rows.filter((r) => r.createdAt <= dateTo);
  const sortBy = input.sortBy ?? "updated";
  return rows
    .map((row) => ({ row, key: sortKeyOf(row, sortBy), id: row.id }))
    .sort(compareRows)
    .map((x) => x.row);
}

export async function listTool(
  store: ConversationStore,
  scope: Scope,
  input: ListInput,
  activeId: string | undefined,
): Promise<ListPage> {
  const sortBy = input.sortBy ?? "updated";
  const rows = await rowsInScope(store, scope, input);
  const totalCount = rows.length;
  let rest = rows;
  if (input.cursor) {
    const at = decodeCursor(input.cursor, sortBy);
    rest = rows.filter((r) => compareRows(at, { key: sortKeyOf(r, sortBy), id: r.id }) < 0);
  }
  const limit = input.limit ?? 20;
  const page = rest.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    last && page.length === limit && rest.length > limit
      ? encodeCursor({ sortBy, key: sortKeyOf(last, sortBy), id: last.id })
      : null;
  return {
    conversations: page.map((r) => ({
      ...r,
      preview: capPreview(r.preview),
      // Whether a reply is generating is the host's to know. A call made inside a
      // conversation's turn proves that one is; the host overlays the rest.
      active: r.id === activeId,
    })),
    nextCursor,
    totalCount,
  };
}

// ── get ────────────────────────────────────────────────────────────────────

/** Messages the default `get` returns, counted from the end. */
export const DEFAULT_GET_LIMIT = 20;
/** The compact size of the messages the default `get` returns, before older ones drop. */
export const DEFAULT_GET_CHAR_CAP = 30_000;

function selectByCharCap(messages: DisplayMessage[], cap: number) {
  const kept: DisplayMessage[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    const size = JSON.stringify(message).length;
    if (kept.length > 0 && used + size > cap) break;
    kept.unshift(message);
    used += size;
  }
  const dropped = messages.length - kept.length;
  return { messages: kept, droppedOlderMessages: dropped, truncated: dropped > 0 };
}

async function project(store: ConversationStore, scope: Scope, id: string, runActive: boolean) {
  const loaded = await store.load(scope, id).catch(() => null);
  if (!loaded) throw notFound(id);
  const lines = loaded.text.split("\n").filter(Boolean);
  return projectConversation(loaded.header, lines.slice(1), runActive);
}

export async function getTool(
  store: ConversationStore,
  scope: Scope,
  input: { id: string; expand?: "metadata" | "messages" | "full"; limit?: number },
  activeId: string | undefined,
) {
  const conv = await project(store, scope, input.id, input.id === activeId);
  const metadata = {
    id: conv.meta.id,
    title: conv.meta.title,
    createdAt: conv.meta.createdAt,
    updatedAt: conv.meta.updatedAt,
    totalInputTokens: conv.meta.totalInputTokens,
    totalOutputTokens: conv.meta.totalOutputTokens,
    lastModel: conv.meta.lastModel,
    model: conv.meta.model,
    ownerId: conv.meta.ownerId,
    workspaceId: scope.workspaceId,
  };
  const expand = input.expand ?? "messages";
  if (expand === "metadata") {
    return { metadata, messages: [], totalMessages: conv.messageCount };
  }
  if (expand === "full") {
    return { metadata, messages: conv.messages, totalMessages: conv.messageCount };
  }
  const limit = input.limit !== undefined && input.limit >= 0 ? input.limit : DEFAULT_GET_LIMIT;
  const windowed = limit === 0 ? [] : conv.messages.slice(-limit);
  const { messages, droppedOlderMessages, truncated } = selectByCharCap(
    windowed,
    DEFAULT_GET_CHAR_CAP,
  );
  // Small flags before the large `messages`, so a reader that slices from the end keeps them.
  return {
    metadata,
    totalMessages: conv.messageCount,
    ...(truncated
      ? {
          truncated: true,
          droppedOlderMessages,
          truncationHint: `Returned ${messages.length} of the requested ${windowed.length} trailing messages; the older ${droppedOlderMessages} exceeded the ${DEFAULT_GET_CHAR_CAP}-char response budget. Use expand:"full" only if you genuinely need the entire transcript, or narrow the limit and request specific ranges.`,
        }
      : {}),
    messages,
  };
}

// ── search ─────────────────────────────────────────────────────────────────

const SNIPPET_CONTEXT = 100;
const MAX_SNIPPETS_PER_CONVERSATION = 3;

function extractSnippet(text: string, at: number, length: number): string {
  const start = Math.max(0, at - SNIPPET_CONTEXT);
  const end = Math.min(text.length, at + length + SNIPPET_CONTEXT);
  let snippet = text.slice(start, end);
  if (start > 0) snippet = `...${snippet}`;
  if (end < text.length) snippet = `${snippet}...`;
  return snippet;
}

/** A line's message text: its `content` text parts, or the raw line when it has none. */
function lineText(line: string): string {
  try {
    const msg: unknown = JSON.parse(line);
    const content = isRecord(msg) ? msg.content : undefined;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter(isRecord)
        .flatMap((b) => (b.type === "text" && typeof b.text === "string" && b.text ? [b.text] : []))
        .join(" ");
    }
  } catch {
    // not JSON: the raw line is searched
  }
  return line;
}

function snippetsOf(raw: string, query: string): Array<{ snippet: string }> {
  const q = query.toLowerCase();
  const lines = raw.split("\n");
  const matches: Array<{ snippet: string }> = [];
  // Line 1 is the header, not a message.
  for (let i = 1; i < lines.length && matches.length < MAX_SNIPPETS_PER_CONVERSATION; i++) {
    const line = lines[i]!;
    if (!line.toLowerCase().includes(q)) continue;
    const text = lineText(line);
    const pos = text.toLowerCase().indexOf(q);
    if (pos >= 0) matches.push({ snippet: extractSnippet(text, pos, query.length) });
  }
  return matches;
}

export async function searchTool(
  store: ConversationStore,
  scope: Scope,
  input: { query: string; limit?: number },
) {
  const query = input.query.trim();
  if (!query) {
    throw new ToolCallError(
      "invalid_input",
      'Invalid arguments for "search": query is required and cannot be empty',
    );
  }
  const limit = input.limit ?? 10;
  const results: Array<{ id: string; title: string | null; matches: Array<{ snippet: string }> }> =
    [];
  for (const row of await rowsInScope(store, scope, {})) {
    if (results.length >= limit) break;
    const loaded = await store.load(scope, row.id).catch(() => null);
    if (!loaded?.text.toLowerCase().includes(query.toLowerCase())) continue;
    const matches = snippetsOf(loaded.text, query);
    if (matches.length > 0) results.push({ id: row.id, title: row.title, matches });
  }
  return { results, totalMatches: results.length };
}

// ── update ─────────────────────────────────────────────────────────────────

/** Retitle: append a `metadata.title` event, then answer what a reader now projects. */
export async function updateTool(
  store: ConversationStore,
  scope: Scope,
  input: { id: string; title: string },
) {
  try {
    await store.append(scope, input.id, [
      { ts: new Date().toISOString(), type: "metadata.title", title: input.title },
    ]);
  } catch (err) {
    if (err instanceof ConversationNotFoundError || err instanceof CorruptConversationError) {
      throw notFound(input.id);
    }
    throw err;
  }
  const found = await store.find(scope, input.id).catch(() => null);
  if (!found) throw notFound(input.id);
  const { meta, preview, messageCount } = summaryOf(found.scan);
  return {
    id: meta.id,
    title: meta.title,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    messageCount,
    totalInputTokens: meta.totalInputTokens,
    totalOutputTokens: meta.totalOutputTokens,
    lastModel: meta.lastModel,
    preview: capPreview(preview),
  };
}

// ── stats ──────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
const PERIOD_MS = { day: DAY_MS, week: 7 * DAY_MS, month: 30 * DAY_MS } as const;

interface ModelStats {
  inputTokens: number;
  outputTokens: number;
  conversations: number;
}

function modelStats(byModel: Map<string, ModelStats>, model: string): ModelStats {
  let stats = byModel.get(model);
  if (!stats) {
    stats = { inputTokens: 0, outputTokens: 0, conversations: 0 };
    byModel.set(model, stats);
  }
  return stats;
}

function countToolCalls(counts: Map<string, number>, calls: DisplayToolCall[] | undefined): void {
  for (const tc of calls ?? []) counts.set(tc.name, (counts.get(tc.name) ?? 0) + 1);
}

/** Fold one conversation's turns into per-model usage and tool counts. */
function foldMessages(
  messages: DisplayMessage[],
  byModel: Map<string, ModelStats>,
  toolCounts: Map<string, number>,
): void {
  const models = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    if (msg.usage?.model) {
      models.add(msg.usage.model);
      const stats = modelStats(byModel, msg.usage.model);
      stats.inputTokens += msg.usage.inputTokens;
      stats.outputTokens += msg.usage.outputTokens;
    }
    countToolCalls(toolCounts, msg.toolCalls);
  }
  for (const model of models) modelStats(byModel, model).conversations += 1;
}

export async function statsTool(
  store: ConversationStore,
  scope: Scope,
  input: { period?: "day" | "week" | "month" | "all" },
  now = new Date(),
) {
  const period = input.period ?? "week";
  const since = period === "all" ? "" : new Date(now.getTime() - PERIOD_MS[period]).toISOString();
  const until = now.toISOString();
  const rows = await rowsInScope(store, scope, {
    ...(since ? { dateFrom: since } : {}),
    dateTo: until,
    sortBy: "created",
  });
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  const byModel = new Map<string, ModelStats>();
  const toolCounts = new Map<string, number>();
  for (const row of rows) {
    const conv = await project(store, scope, row.id, false).catch(() => null);
    if (!conv) continue;
    totalInputTokens += conv.meta.totalInputTokens;
    totalOutputTokens += conv.meta.totalOutputTokens;
    foldMessages(conv.messages, byModel, toolCounts);
  }
  return {
    period: { since, until },
    totalConversations: rows.length,
    totalInputTokens,
    totalOutputTokens,
    byModel: Object.fromEntries(byModel),
    topTools: [...toolCounts]
      .map(([name, callCount]) => ({ name, callCount }))
      .sort((a, b) => b.callCount - a.callCount),
  };
}

// ── export ─────────────────────────────────────────────────────────────────

const truncate = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max)}...`);

function resultText(tc: DisplayToolCall): string {
  for (const block of tc.result.content) {
    if (block.type === "text" && typeof block.text === "string") return block.text;
  }
  return "";
}

function renderMessage(msg: DisplayMessage): string {
  const parts: string[] = [msg.role === "user" ? "## User" : "## Assistant", ""];
  if (msg.content) parts.push(msg.content);
  for (const tc of msg.toolCalls ?? []) {
    parts.push("");
    parts.push(`> **Tool call:** ${tc.name}`);
    parts.push(`> Input: ${truncate(JSON.stringify(tc.input), 100)}`);
    parts.push(`> Result: ${truncate(resultText(tc), 200)}`);
  }
  return parts.join("\n");
}

export async function exportTool(
  store: ConversationStore,
  scope: Scope,
  input: { id: string; format: "markdown" | "json" },
) {
  const conv = await project(store, scope, input.id, false);
  if (input.format === "json") return { content: JSON.stringify(conv.messages, null, 2) };
  const lines = [
    `# Conversation: ${conv.meta.title || "Untitled"}`,
    "",
    `**Created:** ${conv.meta.createdAt}`,
    `**Messages:** ${conv.messageCount}`,
    `**Tokens:** ${conv.meta.totalInputTokens} in / ${conv.meta.totalOutputTokens} out`,
    "",
    "---",
  ];
  for (const msg of conv.messages) lines.push("", renderMessage(msg), "", "---");
  return { content: lines.join("\n") };
}
