/**
 * In-memory index of conversation metadata for fast listing, searching, and filtering.
 *
 * Built on startup by scanning all JSONL file headers, then kept fresh by the
 * runtime's conversation-change hook: `invalidate()` records what moved and
 * `refresh()` applies it on the next read. All IO stays on the read path, so a
 * write never pays for a cache it may not be the one to use.
 *
 * **Two grades of staleness, because the signal has two grades of precision.** A
 * change that names its conversation costs one header re-read. A change that
 * cannot name one — a workspace archive-delete retires an unbounded set at once
 * — falls back to the full rebuild. Appends are the hot case and they always
 * name one, which is the difference between re-reading a file and re-reading
 * the corpus on every message.
 *
 * **A header re-read resumes where the last one stopped.** Each file's scan is
 * kept with its byte offset, so re-reading a conversation that grew costs the
 * appended events, not the whole file. A turn appends after every model call
 * and tool call, and the list is refreshed while it runs, so on a long
 * conversation the difference is a whole-file parse on the event loop per
 * refresh. A file that was replaced, rewritten or truncated is read in full.
 *
 * A watcher cannot supply either signal: the index spans the recursive
 * workspace layout and a root `fs.watch` can't see writes nested under each
 * workspace's own `conversations/<ownerId>/` partition.
 *
 * Types are defined locally — no imports from the runtime codebase.
 */

import {
  type HeaderScan,
  headerOfScan,
  listConversationFiles,
  scanConversationHeader,
} from "./jsonl-reader.ts";

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
   * Single-owner principal. A file whose header has no `ownerId` is not
   * indexed: `load()` refuses it, so no caller could open it.
   */
  ownerId: string;
  /**
   * The workspace the conversation lives in, taken from its DIRECTORY — the
   * only binding (line 1 holds none), so this wall and the
   * `ConversationLocator`'s agree by construction.
   */
  workspaceId: string;
}

/**
 * One conversation the runtime reports as changed.
 *
 * `filePath` and `wsId` come from the store that wrote it rather than being
 * rebuilt from `id` here — this index has no way to resolve an id to a path
 * without the directory walk the whole mechanism exists to avoid, and a second
 * derivation could disagree with the first.
 *
 * Structurally compatible with the runtime's `ConversationChange` and declared
 * separately on purpose: this app imports no runtime types.
 */
export interface ConversationChange {
  id: string;
  filePath: string;
  wsId: string;
}

/**
 * The one workspace and the one owner a call is walled to.
 *
 * Conversations are workspace-owned and single-owner, so every read or write
 * through the index resolves inside exactly one workspace, for exactly one
 * owner. Both halves are ambient — the request's workspace and its
 * authenticated identity — never coordinates the caller supplies, and both are
 * required: there is no way to ask the index for a full-tenant or any-owner
 * answer. An entry outside either half is indistinguishable from an absent one.
 */
export interface ReadScope {
  workspaceId: string;
  userId: string;
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
  /** Each indexed file's header scan, keyed by path, so a re-read resumes from it. */
  private scans: Map<string, HeaderScan> = new Map();
  private dir: string | null = null;
  /**
   * The in-flight mutation — a full `build()` or an incremental apply — so
   * concurrent readers join it instead of racing it. Both kinds go through this
   * field: an incremental apply awaits a header read, and a rebuild landing
   * inside that window would clear the map the apply is about to write into.
   */
  private updating: Promise<void> | null = null;
  /**
   * Conversations whose header must be re-read, keyed by id so a burst of
   * appends to one conversation collapses to a single re-read, on a signal
   * that actually fires under the workspace layout.
   */
  private pending: Map<string, ConversationChange> = new Map();
  /** Set when the change could not name a conversation; the next read rebuilds in full. */
  private dirty = false;

  /** Build the index from every conversation file under `dir`, the workspaces root. */
  async build(dir: string): Promise<void> {
    this.dir = dir;
    this.entries.clear();
    // A rebuild keeps the scans of files still present: each is checked
    // against its file before it is resumed, and a file that is gone drops out.
    const prior = this.scans;
    this.scans = new Map();

    for (const { filePath, wsId } of listConversationFiles(dir)) {
      await this.indexFile(filePath, wsId, prior.get(filePath));
    }
  }

  /**
   * Record that the index may be stale. Does no IO — the work happens on the
   * next `refresh()`, so a write is never billed for a read it may not make.
   *
   * With a `change`, only that conversation is re-read. Without one, the whole
   * index is: the caller is saying it cannot attribute the change, which is
   * true of a workspace archive-delete and would be a correctness bug to treat
   * as "nothing moved".
   */
  invalidate(change?: ConversationChange): void {
    if (!change) {
      this.dirty = true;
      return;
    }
    this.pending.set(change.id, change);
  }

  /**
   * Bring the index up to date on the read path. A no-op when clean (O(1)); a
   * re-read of the named conversations when appends/creates/deletes are
   * pending; a full rebuild when something could not name what it changed.
   *
   * A full rebuild subsumes any pending targeted changes, so it discards them
   * rather than doing the same reads twice.
   */
  async refresh(): Promise<void> {
    if (this.dir === null) return;

    // Never answer against an index mid-update: `build()` clears the map and
    // then repopulates it, and an incremental apply writes into it across an
    // await. A reader arriving inside either window would see a partial map.
    // Join whatever is in flight first. This is the only place the in-flight
    // update and the staleness state are both visible, which is why the
    // coalescing lives here rather than at a caller.
    while (this.updating) await this.updating;

    // Clear BEFORE the work, in both branches. `build()` lists the directory up
    // front and an apply snapshots its changes, so a write landing mid-update
    // cannot be in this pass — but its `invalidate()` must survive it. Clearing
    // afterwards would let an update that never saw the write erase the signal
    // raised for it, and that conversation would stay stale until an unrelated
    // later write re-flagged the index.
    if (this.dirty) {
      this.dirty = false;
      this.pending.clear();
      const dir = this.dir;
      this.updating = this.build(dir).finally(() => {
        this.updating = null;
      });
      await this.updating;
      return;
    }

    if (this.pending.size === 0) return;
    const changes = [...this.pending.values()];
    this.pending.clear();
    this.updating = this.applyChanges(changes).finally(() => {
      this.updating = null;
    });
    await this.updating;

    // Deliberately does NOT loop until clean. The contract is an index at least
    // as fresh as this call's entry, not the newest possible one — on a busy
    // tenant a write can always land during the update, and chasing it does not
    // return. Whatever arrives leaves its signal set for the next reader.
  }

  /**
   * List the conversations `scope` can see, with pagination, sorting, date
   * filtering, and search.
   */
  list(scope: ReadScope, options?: ListOptions): ListResult {
    // Owner and workspace filter — applied BEFORE pagination and the other
    // filters, so `totalCount` and the limit apply to the caller's set in this
    // workspace rather than slicing a global page and then dropping entries
    // (which under-counts a workspace whose chats aren't in the global
    // most-recent page). `e.workspaceId` is the entry's DIRECTORY, so a record
    // is in exactly the workspace it is stored under.
    let items = [...this.entries.values()].filter(
      (e) => e.ownerId === scope.userId && e.workspaceId === scope.workspaceId,
    );

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
   * Get a single entry by ID, inside `scope`. Returns `undefined` for "not
   * found", "exists but not yours", and "exists in another workspace" alike —
   * one shape, so a caller cannot learn that an id exists outside its scope.
   */
  get(id: string, scope: ReadScope): IndexEntry | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (entry.ownerId !== scope.userId || entry.workspaceId !== scope.workspaceId) {
      return undefined;
    }
    return entry;
  }

  /** Total conversation count. */
  get size(): number {
    return this.entries.size;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Read one conversation's header into the index.
   *
   * Returns false when the header does not read — the file is gone, or was
   * caught mid-write. `build()` ignores that (it cleared the map first, so an
   * unreadable file is simply absent); an incremental apply acts on it, because
   * nothing else will drop the entry.
   */
  private async indexFile(
    filePath: string,
    wsId: string,
    prior = this.scans.get(filePath),
  ): Promise<boolean> {
    const scan = await scanConversationHeader(filePath, prior);
    if (!scan) {
      this.scans.delete(filePath);
      return false;
    }
    this.scans.set(filePath, scan);
    const header = headerOfScan(scan);
    const ownerId = header.meta.ownerId;
    if (!ownerId) return false;

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
      ownerId,
      workspaceId: wsId,
    };

    this.entries.set(entry.id, entry);
    return true;
  }

  /**
   * Re-read the named conversations. One header read each, no directory walk.
   *
   * A change whose header no longer reads is a delete, so the entry goes. The
   * id is the store's, not the header's — a deleted file has no header to read
   * one from, which is exactly why the change carries it.
   */
  private async applyChanges(changes: ConversationChange[]): Promise<void> {
    for (const { id, filePath, wsId } of changes) {
      const indexed = await this.indexFile(filePath, wsId);
      if (!indexed) this.entries.delete(id);
    }
  }
}
