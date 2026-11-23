/**
 * What a conversation's stored header and events project to: the record `get`
 * returns, the summary `list` returns, and the matches `search` returns.
 *
 * Pure, so every provider projects the same way and the conformance suite
 * holds one answer for all of them.
 */

import { capPreview, previewTextOf } from "./preview.ts";
import type {
  ConversationScope,
  ConversationSummary,
  ListQuery,
  Page,
  SearchHit,
  StoredEvent,
} from "./store.ts";
import type { Conversation, ConversationEvent } from "./types.ts";

/** The fields a conversation is created with, as a provider stores them. */
export interface ConversationHeader {
  id: string;
  createdAt: string;
  ownerId: string;
  model: string;
  metadata?: Record<string, unknown>;
}

/** The record `get` returns: the header with title, last model and last activity from the events. */
export function projectConversation(
  header: ConversationHeader,
  scope: ConversationScope,
  events: readonly ConversationEvent[],
): Conversation {
  let title: string | null = null;
  let lastModel: string | null = null;
  for (const event of events) {
    if (event.type === "metadata.title") title = event.title;
    else if (event.type === "llm.response") lastModel = event.model;
  }
  const last = events[events.length - 1];
  return {
    id: header.id,
    createdAt: header.createdAt,
    updatedAt: last?.ts ?? header.createdAt,
    title,
    lastModel,
    ownerId: header.ownerId,
    model: header.model,
    workspaceId: scope.workspaceId,
    ...(header.metadata ? { metadata: header.metadata } : {}),
  };
}

/** The summary `list` returns. A message is a user message or a completed run. */
export function projectSummary(
  header: ConversationHeader,
  events: readonly ConversationEvent[],
): ConversationSummary {
  let title: string | null = null;
  let preview = "";
  let messageCount = 0;
  const usage: ConversationSummary["usage"] = {};
  for (const event of events) {
    switch (event.type) {
      case "user.message":
        messageCount++;
        if (!preview) preview = capPreview(previewTextOf(event.content));
        break;
      case "run.done":
        messageCount++;
        break;
      case "metadata.title":
        title = event.title;
        break;
      case "llm.response":
      case "aux.usage": {
        const entry = usage[event.model] ?? { inputTokens: 0, outputTokens: 0 };
        entry.inputTokens += event.usage.inputTokens;
        entry.outputTokens += event.usage.outputTokens;
        usage[event.model] = entry;
        break;
      }
    }
  }
  return {
    id: header.id,
    title,
    preview,
    createdAt: header.createdAt,
    lastActivityAt: events[events.length - 1]?.ts ?? header.createdAt,
    messageCount,
    usage,
  };
}

/** Whether a summary passes a listing's text and date filters. */
export function summaryMatches(summary: ConversationSummary, query: ListQuery): boolean {
  if (query.text) {
    const needle = query.text.toLowerCase();
    const inTitle = summary.title?.toLowerCase().includes(needle) ?? false;
    if (!inTitle && !summary.preview.toLowerCase().includes(needle)) return false;
  }
  if (query.updatedFrom && summary.lastActivityAt < query.updatedFrom) return false;
  if (query.updatedTo && summary.lastActivityAt > query.updatedTo) return false;
  return true;
}

const SNIPPET_CONTEXT = 100;
const MAX_MATCHES = 3;

/** The text a message event carries: a user message's and a response's text parts. */
function messageText(event: ConversationEvent): string | null {
  if (event.type !== "user.message" && event.type !== "llm.response") return null;
  const parts: string[] = [];
  for (const part of event.content) {
    if (part.type === "text") parts.push(part.text);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

function snippetAround(text: string, at: number, length: number): string {
  const start = Math.max(0, at - SNIPPET_CONTEXT);
  const end = Math.min(text.length, at + length + SNIPPET_CONTEXT);
  return `${start > 0 ? "..." : ""}${text.slice(start, end)}${end < text.length ? "..." : ""}`;
}

/** Up to three messages whose text contains `needle` (case-insensitive), or null when none does. */
export function searchMatches(
  id: string,
  title: string | null,
  events: readonly StoredEvent[],
  needle: string,
): SearchHit | null {
  const lower = needle.toLowerCase();
  const matches: SearchHit["matches"] = [];
  for (const { seq, event } of events) {
    if (matches.length >= MAX_MATCHES) break;
    const text = messageText(event);
    if (!text) continue;
    const at = text.toLowerCase().indexOf(lower);
    if (at < 0) continue;
    matches.push({ seq, snippet: snippetAround(text, at, needle.length) });
  }
  return matches.length > 0 ? { id, title, matches } : null;
}

/** A position in a listing: the sort key and id of the last item a page returned. */
interface CursorPosition {
  key: string;
  id: string;
}

function encodeCursor(position: CursorPosition): string {
  return Buffer.from(JSON.stringify(position)).toString("base64url");
}

function decodeCursor(cursor: string): CursorPosition | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8")) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as CursorPosition).key === "string" &&
      typeof (parsed as CursorPosition).id === "string"
    ) {
      return parsed as CursorPosition;
    }
  } catch {
    // An unreadable cursor starts from the first page.
  }
  return null;
}

/** Descending by key, then by id: the one order every listing pages in. */
function before(a: CursorPosition, b: CursorPosition): boolean {
  if (a.key !== b.key) return a.key > b.key;
  return a.id > b.id;
}

/**
 * One page of `items`, ordered newest first by `keyOf`, starting strictly
 * after `cursor`. The cursor names a position, not an index, so an item
 * inserted ahead of it never shifts what the next page returns.
 */
export function paginate<T extends { id: string }>(
  items: readonly T[],
  keyOf: (item: T) => string,
  cursor: string | undefined,
  limit: number,
): Page<T> {
  const positioned = items.map((item) => ({ item, at: { key: keyOf(item), id: item.id } }));
  positioned.sort((a, b) => (before(a.at, b.at) ? -1 : before(b.at, a.at) ? 1 : 0));
  const from = cursor ? decodeCursor(cursor) : null;
  const rest = from ? positioned.filter((p) => before(from, p.at)) : positioned;
  const page = rest.slice(0, Math.max(0, limit));
  const last = page[page.length - 1];
  return {
    items: page.map((p) => p.item),
    nextCursor: last && rest.length > page.length ? encodeCursor(last.at) : null,
    total: items.length,
  };
}
