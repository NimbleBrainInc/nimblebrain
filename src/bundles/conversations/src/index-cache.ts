/**
 * In-memory index of conversation metadata for fast listing, searching, and filtering.
 *
 * Built on startup by scanning all JSONL file headers. Kept fresh one of two
 * ways: `fs.watch` (`startWatching`, for a single flat directory) OR — when the
 * index spans the recursive room layout, where a root watcher can't see nested
 * writes — an external `invalidate()` signal followed by a `refresh()` full
 * rebuild on the next read. The runtime drives the latter from its
 * conversation-change hook (every write + workspace delete).
 *
 * Types are defined locally — no imports from the runtime codebase.
 */

import { type FSWatcher, watch } from "node:fs";
import { basename, join } from "node:path";
import { listConversationFiles, readConversationHeader } from "./jsonl-reader.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IndexEntry {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  lastModel: string | null;
  preview: string;
  filePath: string;
  /**
   * Single-owner principal. Stage 1 requires every conversation to
   * carry an `ownerId`; legacy files written before the migration may
   * lack one — the index keeps `null` for those rather than guessing,
   * and the dispatcher treats `null` as inaccessible (no synthesis).
   */
  ownerId: string | null;
}

export interface ListOptions {
  limit?: number; // Default: 20
  cursor?: string;
  search?: string; // Substring match on title + preview
  sortBy?: "created" | "updated";
  dateFrom?: string; // ISO 8601
  dateTo?: string; // ISO 8601
}

/**
 * Access context for ownership-gated reads. When supplied, list/search/
 * stats filter to entries owned by `userId`; get/update/fork/export
 * refuse mismatched owners with a "not found" — no existence leak.
 */
export interface AccessContext {
  userId: string;
}

export interface ListResult {
  conversations: IndexEntry[];
  nextCursor: string | null;
  totalCount: number;
}

// ---------------------------------------------------------------------------
// ConversationIndex
// ---------------------------------------------------------------------------

export class ConversationIndex {
  private entries: Map<string, IndexEntry> = new Map();
  /** Maps filename (e.g. "conv_abc.jsonl") to conversation ID for fast fs.watch lookups. */
  private fileToId: Map<string, string> = new Map();
  private dir: string | null = null;
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingFiles: Set<string> = new Set();
  /** Set when the index may be stale; the next read does a full rebuild. */
  private dirty = false;

  /** Build index by scanning all .jsonl files in dir. Reads only headers (line 1 + preview). */
  async build(dir: string): Promise<void> {
    this.dir = dir;
    this.entries.clear();
    this.fileToId.clear();

    const files = listConversationFiles(dir);

    for (const filePath of files) {
      await this.indexFile(filePath);
    }
  }

  /**
   * Mark the index stale. The next `refresh()` rebuilds from disk. Used when an
   * external signal (the runtime's conversation-change hook) reports a write or
   * a workspace delete the index can't observe itself — the recursive room
   * layout defeats `fs.watch`, so the index cannot rely on the watcher for
   * updates or deletions.
   */
  invalidate(): void {
    this.dirty = true;
  }

  /**
   * Bring the index up to date on the read path. A no-op when clean (O(1)); a
   * full rebuild when `invalidate()` flagged it stale — re-reading every header
   * (so summary changes from appends land) and dropping entries whose file is
   * gone (so deletes don't ghost). Unlike `flushPending`, this is not add-only.
   */
  async refresh(): Promise<void> {
    if (this.dirty && this.dir !== null) {
      await this.build(this.dir);
      this.dirty = false;
    }
  }

  /** Start fs.watch on dir. On change, debounce 500ms, then re-read affected file header. */
  startWatching(dir: string): void {
    this.stopWatching();
    this.dir = dir;

    this.watcher = watch(dir, (_eventType, filename) => {
      if (!filename?.endsWith(".jsonl")) return;

      this.pendingFiles.add(filename);

      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }

      this.debounceTimer = setTimeout(() => {
        this.processPendingFiles();
      }, 500);
    });
  }

  /**
   * Bring the index up to date NOW, bypassing the fs.watch debounce.
   *
   * Processes any queued watch events immediately, then scans the directory
   * for files not yet indexed (a just-created conversation whose watch event
   * hasn't fired or debounced yet). Called on the read path so a
   * `data.changed`-driven list refresh reflects a brand-new conversation
   * deterministically, instead of racing the 500ms watch debounce.
   */
  async flushPending(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    await this.processPendingFiles();
    if (!this.dir) return;
    for (const filePath of listConversationFiles(this.dir)) {
      if (!this.fileToId.has(basename(filePath))) {
        await this.indexFile(filePath);
      }
    }
  }

  /** Stop watching. */
  stopWatching(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.pendingFiles.clear();
  }

  /** List conversations with pagination, sorting, date filtering, search. */
  list(options?: ListOptions, access?: AccessContext): ListResult {
    let items = [...this.entries.values()];

    // Ownership filter — applied before other filters so totalCount
    // reflects the caller's visible set, not the global one.
    if (access) {
      items = items.filter((e) => e.ownerId === access.userId);
    }

    // Search filter: case-insensitive substring on title + preview
    if (options?.search) {
      const q = options.search.toLowerCase();
      items = items.filter(
        (e) => (e.title?.toLowerCase().includes(q) ?? false) || e.preview.toLowerCase().includes(q),
      );
    }

    // Date filtering
    if (options?.dateFrom) {
      const from = options.dateFrom;
      items = items.filter((e) => e.createdAt >= from);
    }
    if (options?.dateTo) {
      const to = options.dateTo;
      items = items.filter((e) => e.createdAt <= to);
    }

    // Sorting (descending — newest first)
    const sortBy = options?.sortBy ?? "updated";
    const sortKey = sortBy === "created" ? "createdAt" : "updatedAt";
    items.sort((a, b) => b[sortKey].localeCompare(a[sortKey]));

    const totalCount = items.length;

    // Cursor pagination: skip entries up to and including the cursor ID
    if (options?.cursor) {
      const idx = items.findIndex((e) => e.id === options.cursor);
      if (idx >= 0) {
        items = items.slice(idx + 1);
      }
    }

    const limit = options?.limit ?? 20;
    const page = items.slice(0, limit);
    const nextCursor =
      page.length === limit && items.length > limit ? (page[page.length - 1]?.id ?? null) : null;

    return { conversations: page, nextCursor, totalCount };
  }

  /**
   * Get a single entry by ID. With `access` supplied, returns
   * `undefined` for both "not found" AND "exists but not yours" — same
   * shape, no existence leak. Without `access`, the caller is asserting
   * trusted scope.
   */
  get(id: string, access?: AccessContext): IndexEntry | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (access && entry.ownerId !== access.userId) return undefined;
    return entry;
  }

  /** Total conversation count. */
  get size(): number {
    return this.entries.size;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private async indexFile(filePath: string): Promise<void> {
    const header = await readConversationHeader(filePath);
    if (!header) return;

    const entry: IndexEntry = {
      id: header.meta.id,
      title: header.meta.title,
      createdAt: header.meta.createdAt,
      updatedAt: header.meta.updatedAt,
      messageCount: header.messageCount,
      totalInputTokens: header.meta.totalInputTokens,
      totalOutputTokens: header.meta.totalOutputTokens,
      lastModel: header.meta.lastModel,
      preview: header.preview,
      filePath,
      ownerId: header.meta.ownerId ?? null,
    };

    this.entries.set(entry.id, entry);
    this.fileToId.set(basename(filePath), entry.id);
  }

  private async processPendingFiles(): Promise<void> {
    if (!this.dir) return;

    const files = [...this.pendingFiles];
    this.pendingFiles.clear();

    for (const filename of files) {
      const filePath = join(this.dir, filename);

      // Try to read the header. If the file was deleted, readConversationHeader returns null.
      const header = await readConversationHeader(filePath);

      if (header) {
        // File exists — update/add entry
        const entry: IndexEntry = {
          id: header.meta.id,
          title: header.meta.title,
          createdAt: header.meta.createdAt,
          updatedAt: header.meta.updatedAt,
          messageCount: header.messageCount,
          totalInputTokens: header.meta.totalInputTokens,
          totalOutputTokens: header.meta.totalOutputTokens,
          lastModel: header.meta.lastModel,
          preview: header.preview,
          filePath,
          ownerId: header.meta.ownerId ?? null,
        };
        this.entries.set(entry.id, entry);
        this.fileToId.set(filename, entry.id);
      } else {
        // File was deleted or became unreadable — remove from index
        const id = this.fileToId.get(filename);
        if (id) {
          this.entries.delete(id);
          this.fileToId.delete(filename);
        }
      }
    }
  }
}
