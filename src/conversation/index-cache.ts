import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "../observability/log.ts";
import { estimateCost } from "../usage/cost.ts";
import type { TokenUsage } from "../usage/types.ts";
import type {
  ConversationAccessContext,
  ConversationListResult,
  ConversationSummary,
  ListOptions,
  StoredMessage,
} from "./types.ts";

interface ConversationMetadata {
  id: string;
  createdAt: string;
  updatedAt?: string;
  title?: string | null;
  ownerId?: string;
}

/**
 * In-memory index of conversation metadata for fast list/search.
 *
 * Lazily populates by reading only line 1 (metadata) and the first user
 * message (preview) from each JSONL file — never loads full history.
 */
/**
 * Access-control metadata stored alongside each summary in the index.
 * Stage 1: single-owner only — `ownerId` is the entire authorization
 * surface. Stage 4 reintroduces sharing via explicit policy.
 */
interface IndexedAccessMeta {
  ownerId?: string;
}

export class ConversationIndex {
  private entries: Map<string, ConversationSummary> = new Map();
  private accessMeta: Map<string, IndexedAccessMeta> = new Map();
  private populated = false;

  /** Lazily populate index by reading line 1 of each JSONL file + first user message. */
  async populate(dir: string): Promise<void> {
    if (this.populated) return;

    this.entries.clear();
    this.accessMeta.clear();

    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      this.populated = true;
      return;
    }

    // Count ownerless files separately from generic "couldn't parse"
    // failures. Ownerless files are pre-invariant state needing manual
    // triage (no migration stamps an owner); surface a single line so
    // they aren't a silent oracle ("the dashboard is missing N
    // conversations and no one sees why").
    let ownerlessSkipped = 0;
    for (const file of files) {
      try {
        const content = await readFile(join(dir, file), "utf-8");
        const parsed = parseFileHeader(content);
        if (parsed) {
          this.entries.set(parsed.summary.id, parsed.summary);
          this.accessMeta.set(parsed.summary.id, parsed.access);
        } else if (isLikelyOwnerlessFile(content)) {
          ownerlessSkipped++;
        }
      } catch {
        // Skip corrupt or unreadable files
      }
    }

    if (ownerlessSkipped > 0) {
      log.warn(
        `[index] excluded ${ownerlessSkipped} ownerless conversation file(s) in ${dir} — these predate the ownership invariant and need manual triage (stamp an ownerId on line 1, or remove); no migration stamps them.`,
      );
    }

    this.populated = true;
  }

  /** Force re-scan on next access. */
  invalidate(): void {
    this.populated = false;
  }

  /** Get a single entry by ID. */
  get(id: string): ConversationSummary | undefined {
    return this.entries.get(id);
  }

  /** Add or update an entry without re-scanning. */
  upsert(summary: ConversationSummary): void {
    this.entries.set(summary.id, summary);
  }

  /** Remove an entry. */
  remove(id: string): void {
    this.entries.delete(id);
  }

  /** Case-insensitive substring search across title and preview. */
  search(query: string): ConversationSummary[] {
    const q = query.toLowerCase();
    return [...this.entries.values()].filter(
      (s) => (s.title?.toLowerCase().includes(q) ?? false) || s.preview.toLowerCase().includes(q),
    );
  }

  /** Get access metadata for a conversation by ID. */
  getAccessMeta(id: string): IndexedAccessMeta | undefined {
    return this.accessMeta.get(id);
  }

  /** List conversations with pagination, sorting, optional search, and access filtering. */
  list(options?: ListOptions, access?: ConversationAccessContext): ConversationListResult {
    let items = options?.search ? this.search(options.search) : [...this.entries.values()];

    // Apply access filtering when context is provided
    if (access) {
      items = items.filter((s) => canAccess(this.accessMeta.get(s.id), access));
    }

    const sortBy = options?.sortBy ?? "updatedAt";
    items.sort((a, b) => b[sortBy].localeCompare(a[sortBy]));

    const totalCount = items.length;

    // Cursor pagination: skip entries up to and including the cursor ID.
    //
    // Edge case (future hardening, not Stage 1): if the cursor names a
    // conversation that no longer satisfies the current `access`
    // filter — owner changed (Stage 4 sharing), or the conversation
    // was deleted between calls — `findIndex` returns -1 and the
    // slice is a no-op, so the caller re-sees page 1 instead of
    // getting an empty / shifted page. Stage 1 single-owner doesn't
    // hit this (ownership can't change), but the cursor model should
    // be revisited when sharing returns. Options: opaque
    // ({createdAt}, last-id) cursors that don't depend on the filtered
    // result, or return an explicit `cursor_invalid` signal.
    if (options?.cursor) {
      const idx = items.findIndex((s) => s.id === options.cursor);
      if (idx >= 0) items = items.slice(idx + 1);
    }

    const limit = options?.limit ?? 20;
    const page = items.slice(0, limit);
    const nextCursor =
      page.length === limit && items.length > limit ? (page[page.length - 1]?.id ?? null) : null;

    return { conversations: page, nextCursor, totalCount };
  }
}

/**
 * Check if a user can access a conversation.
 *
 * Stage 1: single-owner. A conversation is accessible iff the caller
 * is its owner. Workspace-admin overrides and shared-with-participants
 * semantics are gone — Stage 4 reintroduces them with explicit policy
 * gates and audit trails.
 *
 * A `meta` of `undefined` or one without `ownerId` is treated as
 * inaccessible — Stage 1 enforces "every conversation has an owner"
 * at write time, so unset means the index hasn't caught up.
 */
export function canAccess(
  meta: IndexedAccessMeta | undefined,
  access: ConversationAccessContext,
): boolean {
  if (!meta?.ownerId) return false;
  return meta.ownerId === access.userId;
}

/**
 * Detect whether a JSONL file uses the event-sourced format.
 * Checks line 1 metadata for `format: "events"`, or line 2 for a `type` field (events)
 * vs a `role` field (legacy messages).
 */
function isEventFormat(meta: Record<string, unknown>, secondLine?: string): boolean {
  if (meta.format === "events") return true;
  if (!secondLine) return false;
  try {
    const parsed = JSON.parse(secondLine) as Record<string, unknown>;
    return "type" in parsed && !("role" in parsed);
  } catch {
    return false;
  }
}

/**
 * Extract preview text from a user.message event's content array.
 */
function extractEventPreview(content: unknown): string {
  if (!Array.isArray(content)) return "";
  for (const part of content) {
    if (
      part &&
      typeof part === "object" &&
      "type" in part &&
      (part as { type: string }).type === "text"
    ) {
      return (part as { text?: string }).text ?? "";
    }
  }
  return "";
}

/**
 * Heuristic check: did parseFileHeader bail because the file is
 * structurally OK but lacks `ownerId`? Used by `populate` to count
 * ownerless skips so operators see a "you have N pre-migration files"
 * line — vs corrupt files which silently fail.
 *
 * Doesn't re-derive everything: just peeks at line 1, parses it, and
 * checks whether `id` is present and `ownerId` is absent. Worst case
 * if we're wrong (file IS corrupt with a plausible-looking line 1)
 * the count is off by one; the operator action is the same either way.
 */
function isLikelyOwnerlessFile(content: string): boolean {
  const firstLine = content.split("\n", 1)[0];
  if (!firstLine) return false;
  try {
    const meta = JSON.parse(firstLine) as Partial<ConversationMetadata>;
    return typeof meta.id === "string" && !meta.ownerId;
  } catch {
    return false;
  }
}

/**
 * Running metrics folded from a conversation's lines (past line 1).
 * `lastModel` is on Conversation, not ConversationSummary, so it isn't tracked.
 */
interface DerivedMetrics {
  preview: string;
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  lastEventTs: string | null;
  title: string | null | undefined;
}

/** A single event-sourced line, with the fields the index derives from. */
interface EventLine {
  type?: string;
  ts?: string;
  content?: unknown;
  usage?: TokenUsage;
  model?: string;
  title?: string | null;
}

/** Zero-valued metrics accumulator. */
function emptyMetrics(): DerivedMetrics {
  return {
    preview: "",
    messageCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    lastEventTs: null,
    title: undefined,
  };
}

/**
 * Fold each line after line 1 into a metrics accumulator, skipping any
 * line that fails to parse or apply (malformed).
 */
function scanLines(
  lines: string[],
  apply: (metrics: DerivedMetrics, line: string) => void,
): DerivedMetrics {
  const metrics = emptyMetrics();
  for (let i = 1; i < lines.length; i++) {
    try {
      apply(metrics, lines[i]!);
    } catch {
      // Skip malformed lines
    }
  }
  return metrics;
}

/** Fold one event-sourced line into the running metrics. */
function applyEventLine(metrics: DerivedMetrics, line: string): void {
  const event = JSON.parse(line) as EventLine;
  if (event.ts) metrics.lastEventTs = event.ts;
  if (event.type === "user.message") {
    metrics.messageCount++;
    if (!metrics.preview) {
      metrics.preview = extractEventPreview(event.content);
    }
  } else if (event.type === "run.done") {
    metrics.messageCount++;
  } else if (event.type === "llm.response" && event.usage && event.model) {
    metrics.inputTokens += event.usage.inputTokens;
    metrics.outputTokens += event.usage.outputTokens;
    metrics.costUsd += estimateCost(event.model, event.usage);
  } else if (event.type === "metadata.title") {
    metrics.title = event.title;
  }
}

/**
 * Fold one legacy (message-format) line into the running metrics. Every
 * parseable line counts; assistant messages with usage add to totals so the
 * summary is consistent with the event-format path. Messages without usage
 * contribute zero.
 */
function applyMessageLine(metrics: DerivedMetrics, line: string): void {
  const msg = JSON.parse(line) as StoredMessage;
  metrics.messageCount++;
  if (!metrics.preview && msg.role === "user") {
    metrics.preview = typeof msg.content === "string" ? msg.content : "";
  }
  if (msg.role === "assistant" && msg.metadata?.usage && msg.metadata.model) {
    metrics.inputTokens += msg.metadata.usage.inputTokens;
    metrics.outputTokens += msg.metadata.usage.outputTokens;
    metrics.costUsd += estimateCost(msg.metadata.model, msg.metadata.usage);
  }
}

/**
 * Parse a JSONL file's content to extract a ConversationSummary and access metadata.
 * Reads line 1 for metadata and scans for the first user message as preview.
 * Supports both legacy (StoredMessage) and event-sourced formats.
 */
export function parseFileHeader(
  content: string,
): { summary: ConversationSummary; access: IndexedAccessMeta } | null {
  const lines = content.split("\n").filter(Boolean);
  if (lines.length === 0) return null;

  const meta = JSON.parse(lines[0]!) as ConversationMetadata;
  if (!meta.id) return null;

  const eventFormat = isEventFormat(
    meta as unknown as Record<string, unknown>,
    lines[1] as string | undefined,
  );

  // Totals are always derived — from events for event-sourced files, from
  // each assistant message's metadata.usage for legacy files. Legacy line-1
  // metadata totals are intentionally ignored, so old conversations show
  // zero totals if their events don't carry usage. (See PR removing stored
  // totals.)
  const metrics = scanLines(lines, eventFormat ? applyEventLine : applyMessageLine);

  // Stage 1 invariant: every conversation has an ownerId. A file
  // without one is pre-migration data — load() already throws when
  // it encounters such a file directly, and the index honors the same
  // invariant by EXCLUDING ownerless entries entirely. Including them
  // with an absent / empty ownerId would be a category error: the
  // application's view of "conversations that exist" would include
  // entries that load() can't actually return. Operators see
  // ownerless files via filesystem inspection or the migration
  // script's report, not via the index.
  if (!meta.ownerId) return null;

  return {
    summary: {
      id: meta.id,
      createdAt: meta.createdAt,
      updatedAt: metrics.lastEventTs ?? meta.updatedAt ?? meta.createdAt,
      title: metrics.title ?? meta.title ?? null,
      messageCount: metrics.messageCount,
      preview: metrics.preview,
      totalInputTokens: metrics.inputTokens,
      totalOutputTokens: metrics.outputTokens,
      totalCostUsd: metrics.costUsd,
      ownerId: meta.ownerId,
    },
    access: {
      ownerId: meta.ownerId,
    },
  };
}
