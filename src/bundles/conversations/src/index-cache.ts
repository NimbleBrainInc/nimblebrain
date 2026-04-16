/**
 * In-memory index of conversation metadata for fast listing, searching, and filtering.
 *
 * Built on startup by scanning all JSONL file headers. Invalidated by fs.watch()
 * on the conversations directory (debounced 500ms).
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
}

export interface ListOptions {
  limit?: number; // Default: 20
  cursor?: string;
  search?: string; // Substring match on title + preview
  sortBy?: "created" | "updated";
  dateFrom?: string; // ISO 8601
  dateTo?: string; // ISO 8601
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
  list(options?: ListOptions): ListResult {
    let items = [...this.entries.values()];

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

  /** Get a single entry by ID. */
  get(id: string): IndexEntry | undefined {
    return this.entries.get(id);
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
