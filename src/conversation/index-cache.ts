import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { estimateCost } from "../engine/cost.ts";
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
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCostUsd?: number;
  ownerId?: string;
  visibility?: "private" | "shared";
  participants?: string[];
}

/**
 * In-memory index of conversation metadata for fast list/search.
 *
 * Lazily populates by reading only line 1 (metadata) and the first user
 * message (preview) from each JSONL file — never loads full history.
 */
/** Access-control metadata stored alongside each summary in the index. */
interface IndexedAccessMeta {
  ownerId?: string;
  visibility?: "private" | "shared";
  participants?: string[];
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

    for (const file of files) {
      try {
        const content = await readFile(join(dir, file), "utf-8");
        const parsed = parseFileHeader(content);
        if (parsed) {
          this.entries.set(parsed.summary.id, parsed.summary);
          this.accessMeta.set(parsed.summary.id, parsed.access);
        }
      } catch {
        // Skip corrupt or unreadable files
      }
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

    // Cursor pagination: skip entries up to and including the cursor ID
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
 * Check if a user can access a conversation based on its access metadata.
 *
 * Rules:
 * - Admins can see everything
 * - Legacy conversations (no ownerId/visibility) are visible to all (backward compat)
 * - Owner always sees their own conversations
 * - Shared conversations are visible to participants
 * - Private conversations are only visible to their owner
 */
export function canAccess(
  meta: IndexedAccessMeta | undefined,
  access: ConversationAccessContext,
): boolean {
  // Admins see everything
  if (access.workspaceRole === "admin") return true;

  // Legacy conversations without access metadata are visible to all
  if (!meta?.ownerId && !meta?.visibility) return true;

  // Owner always has access
  if (meta?.ownerId === access.userId) return true;

  // Shared conversations visible to participants
  if (meta?.visibility === "shared") {
    return meta.participants?.includes(access.userId) ?? false;
  }

  // Private (default) — only owner (already handled above)
  return false;
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
 * Parse a JSONL file's content to extract a ConversationSummary and access metadata.
 * Reads line 1 for metadata and scans for the first user message as preview.
 * Supports both legacy (StoredMessage) and event-sourced formats.
 */
function parseFileHeader(
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

  let preview = "";
  let messageCount = 0;

  // Derived metrics (event-sourced format only)
  let derivedInputTokens = 0;
  let derivedOutputTokens = 0;
  let derivedCostUsd = 0;
  let derivedLastModel: string | null = null;
  let lastEventTs: string | null = null;
  let derivedTitle: string | null | undefined;
  let derivedVisibility: "private" | "shared" | undefined;
  let derivedParticipants: string[] | undefined;

  if (eventFormat) {
    // Event-sourced format: scan for events
    for (let i = 1; i < lines.length; i++) {
      try {
        const event = JSON.parse(lines[i]!) as {
          type?: string;
          ts?: string;
          content?: unknown;
          inputTokens?: number;
          outputTokens?: number;
          cacheReadTokens?: number;
          model?: string;
          title?: string | null;
          visibility?: "private" | "shared";
          participants?: string[];
        };
        if (event.ts) lastEventTs = event.ts;
        if (event.type === "user.message") {
          messageCount++;
          if (!preview) {
            preview = extractEventPreview(event.content);
          }
        } else if (event.type === "run.done") {
          messageCount++;
        } else if (event.type === "llm.response") {
          derivedInputTokens += event.inputTokens ?? 0;
          derivedOutputTokens += event.outputTokens ?? 0;
          derivedLastModel = event.model ?? derivedLastModel;
          derivedCostUsd += estimateCost(event.model ?? "", {
            inputTokens: event.inputTokens ?? 0,
            outputTokens: event.outputTokens ?? 0,
            cacheReadTokens: event.cacheReadTokens ?? 0,
          });
        } else if (event.type === "metadata.title") {
          derivedTitle = event.title;
        } else if (event.type === "metadata.visibility") {
          derivedVisibility = event.visibility;
        } else if (event.type === "metadata.participants") {
          derivedParticipants = event.participants;
        }
      } catch {
        // Skip malformed event lines
      }
    }
  } else {
    // Legacy format: scan for StoredMessage objects with role field
    for (let i = 1; i < lines.length; i++) {
      try {
        const msg = JSON.parse(lines[i]!) as StoredMessage;
        messageCount++;
        if (!preview && msg.role === "user") {
          preview = typeof msg.content === "string" ? msg.content : "";
        }
      } catch {
        // Skip malformed message lines
      }
    }
  }

  // Use derived values from events when available, fall back to line 1 for legacy
  const hasDerivedMetrics = derivedInputTokens > 0 || derivedOutputTokens > 0;

  const effectiveVisibility = derivedVisibility ?? meta.visibility;
  const effectiveParticipants = derivedParticipants ?? meta.participants;

  return {
    summary: {
      id: meta.id,
      createdAt: meta.createdAt,
      updatedAt: lastEventTs ?? meta.updatedAt ?? meta.createdAt,
      title: derivedTitle ?? meta.title ?? null,
      messageCount,
      preview,
      totalInputTokens: hasDerivedMetrics ? derivedInputTokens : (meta.totalInputTokens ?? 0),
      totalOutputTokens: hasDerivedMetrics ? derivedOutputTokens : (meta.totalOutputTokens ?? 0),
      totalCostUsd: hasDerivedMetrics ? derivedCostUsd : (meta.totalCostUsd ?? 0),
    },
    access: {
      ...(meta.ownerId ? { ownerId: meta.ownerId } : {}),
      ...(effectiveVisibility ? { visibility: effectiveVisibility } : {}),
      ...(effectiveParticipants ? { participants: effectiveParticipants } : {}),
    },
  };
}
