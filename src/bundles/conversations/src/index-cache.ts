/**
 * Pull-on-demand conversation index.
 *
 * Each call reconciles in-memory state with the directory: stat every
 * conversation file, re-read headers only for new or mtime-changed files,
 * drop entries for files that have disappeared. There is no `fs.watch`, no
 * debounce, and no broadcast-vs-debounce race — `list` and `get` always
 * return disk-truth.
 */

import { statSync } from "node:fs";
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

interface CachedEntry {
  entry: IndexEntry;
  mtimeMs: number;
}

// ---------------------------------------------------------------------------
// ConversationIndex
// ---------------------------------------------------------------------------

export class ConversationIndex {
  /** filePath → cached entry + last-seen mtime. */
  private cache: Map<string, CachedEntry> = new Map();
  /** id → filePath. Enables `get(id)` to stat one file instead of walking. */
  private byId: Map<string, string> = new Map();
  private dir: string | null = null;

  /** Point the index at a directory. No I/O until the first list/get. */
  init(dir: string): void {
    this.dir = dir;
  }

  /** List conversations with pagination, sorting, date filtering, search. */
  async list(options?: ListOptions): Promise<ListResult> {
    let items = await this.reconcile();

    if (options?.search) {
      const q = options.search.toLowerCase();
      items = items.filter(
        (e) => (e.title?.toLowerCase().includes(q) ?? false) || e.preview.toLowerCase().includes(q),
      );
    }
    if (options?.dateFrom) {
      const from = options.dateFrom;
      items = items.filter((e) => e.createdAt >= from);
    }
    if (options?.dateTo) {
      const to = options.dateTo;
      items = items.filter((e) => e.createdAt <= to);
    }

    const sortBy = options?.sortBy ?? "updated";
    const sortKey = sortBy === "created" ? "createdAt" : "updatedAt";
    items.sort((a, b) => b[sortKey].localeCompare(a[sortKey]));

    const totalCount = items.length;
    if (options?.cursor) {
      const idx = items.findIndex((e) => e.id === options.cursor);
      if (idx >= 0) items = items.slice(idx + 1);
    }

    const limit = options?.limit ?? 20;
    const page = items.slice(0, limit);
    const nextCursor =
      page.length === limit && items.length > limit ? (page[page.length - 1]?.id ?? null) : null;

    return { conversations: page, nextCursor, totalCount };
  }

  /**
   * Get a single entry by ID.
   *
   * Fast path: when the id has been seen before, stat one file and reuse
   * the cached entry if its mtime is unchanged (or re-read just that
   * header on a change). Avoids the full directory walk for the common
   * case where `handleGet`/`handleFork`/`handleUpdate` operate on a
   * conversation the index already knows about.
   *
   * Slow path: id unknown (first encounter, or the cached file
   * disappeared) — full reconcile, then a Map lookup.
   */
  async get(id: string): Promise<IndexEntry | undefined> {
    if (!this.dir) return undefined;

    const knownPath = this.byId.get(id);
    if (knownPath) {
      try {
        const mtimeMs = statSync(knownPath).mtimeMs;
        const cached = this.cache.get(knownPath);
        if (cached && cached.mtimeMs === mtimeMs) return cached.entry;

        const header = await readConversationHeader(knownPath);
        if (!header) {
          this.cache.delete(knownPath);
          this.byId.delete(id);
          return undefined;
        }
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
          filePath: knownPath,
        };
        this.cache.set(knownPath, { entry, mtimeMs });
        this.byId.set(entry.id, knownPath);
        return entry;
      } catch {
        // File gone since we cached it. Forget the stale mapping and fall
        // through to a full reconcile in case the id moved.
        this.cache.delete(knownPath);
        this.byId.delete(id);
      }
    }

    await this.reconcile();
    const path = this.byId.get(id);
    return path ? this.cache.get(path)?.entry : undefined;
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /**
   * Reconcile cached state with the directory:
   *   - stat every conversation file (sync, cheap)
   *   - reuse cached entry if mtime is unchanged
   *   - re-read header for new or modified files
   *   - drop entries whose files no longer exist
   *
   * Concurrent callers do their own reconcile; cache writes are idempotent
   * by file path, so the worst case is a redundant header read.
   */
  private async reconcile(): Promise<IndexEntry[]> {
    if (!this.dir) return [];

    const files = listConversationFiles(this.dir);
    const present = new Set(files);
    const entries: IndexEntry[] = [];

    for (const filePath of files) {
      let mtimeMs: number;
      try {
        mtimeMs = statSync(filePath).mtimeMs;
      } catch {
        // Race: file removed between listing and stat. Skip.
        continue;
      }

      const cached = this.cache.get(filePath);
      if (cached && cached.mtimeMs === mtimeMs) {
        entries.push(cached.entry);
        continue;
      }

      const header = await readConversationHeader(filePath);
      if (!header) continue;

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
      this.cache.set(filePath, { entry, mtimeMs });
      this.byId.set(entry.id, filePath);
      entries.push(entry);
    }

    for (const [cachedPath, cached] of this.cache) {
      if (!present.has(cachedPath)) {
        this.cache.delete(cachedPath);
        this.byId.delete(cached.entry.id);
      }
    }

    return entries;
  }
}
