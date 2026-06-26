/**
 * Process-wide conversation locator.
 *
 * Conversations are room-owned — each lives under
 * `workspaces/<wsId>/conversations/<ownerId>/<convId>.jsonl` (or, for automation
 * runs, `.../conversations/_runs/<automationId>/`). The per-room
 * `EventSourcedConversationStore` operates within one room+owner directory and
 * knows nothing of rooms. The locator is the one component that sees ACROSS
 * rooms: it answers two questions the runtime needs that a single-dir store
 * cannot —
 *
 *   1. **load-by-id:** `convId → { wsId, ownerId }`, so a context-free load
 *      (deep link, history fetch, `conversations__get`) can construct the right
 *      room store. The hot chat path already knows its room from the request and
 *      never consults the locator.
 *   2. **list:** the owner's "All rooms" view (every workspace they belong to)
 *      and the room-scoped view (one `workspaceId`), from one structure. The
 *      path is the wall (room filter); ownership is the access gate.
 *
 * **Freshness without recursive watch.** `fs.watch({recursive:true})` is not
 * supported on Linux, so correctness must NOT depend on a watcher. Instead the
 * runtime calls `invalidate()` on every conversation create/delete, and reads
 * repopulate just-in-time. The scan is a targeted walk of each room's
 * `conversations/` subtree (never the whole workspace tree), reusing the
 * conversation header parser so summaries match the per-room index exactly.
 */

import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { log } from "../observability/log.ts";
import { canAccess, parseFileHeader } from "./index-cache.ts";
import { parseConversationPath, RUN_PARTITION_SEGMENT } from "./paths.ts";
import type {
  ConversationAccessContext,
  ConversationListResult,
  ConversationSummary,
  ListOptions,
} from "./types.ts";

/** Where a conversation lives — the locator's resolution result. */
export interface ConversationLocation {
  /** The room (workspace) the conversation is stored under. */
  wsId: string;
  /** The owner sub-partition, or `null` for an automation-run conversation. */
  ownerId: string | null;
  /** The automation id for a `_runs/<automationId>/` conversation; else `null`. */
  automationId: string | null;
  /** Absolute path to the conversation's JSONL file. */
  filePath: string;
}

interface LocatorEntry extends ConversationLocation {
  summary: ConversationSummary;
  /** Access principal (the conversation owner from line-1 metadata). */
  accessOwnerId: string;
}

function isWorkspaceDir(name: string): boolean {
  return name.startsWith("ws_");
}

export class ConversationLocator {
  private entries = new Map<string, LocatorEntry>();
  private populated = false;

  /** @param workspacesRoot absolute path to `{workDir}/workspaces`. */
  constructor(private readonly workspacesRoot: string) {}

  /** Force a full rescan on the next read. Called by the store on create/delete. */
  invalidate(): void {
    this.populated = false;
  }

  /**
   * Resolve a conversation id to its room + owner. `undefined` if no room holds
   * it. Resolution is a PATH operation, NOT a content one: the filename is the
   * convId and `parseConversationPath` recovers `{ wsId, ownerId }` from the
   * directory. So this is a readdir-only walk — it never reads or parses a file,
   * and never touches the summary index (which `list()` rebuilds on every append
   * and would make every resolve a full-tenant scan). Owner/validity is the
   * caller's `load()`'s job: an ownerless file resolves here and surfaces as a
   * `ConversationCorruptedError` on load, not a silent not-found.
   */
  async locate(convId: string): Promise<ConversationLocation | undefined> {
    const target = `${convId}.jsonl`;
    for (const filePath of listAllConversationFiles(this.workspacesRoot)) {
      if (basename(filePath) !== target) continue;
      const loc = parseConversationPath(filePath);
      if (loc) {
        return {
          wsId: loc.wsId,
          ownerId: loc.ownerId,
          automationId: loc.automationId,
          filePath,
        };
      }
    }
    return undefined;
  }

  /**
   * List conversations across rooms. `options.workspaceId` restricts to one
   * room (the room-scoped view); omit for the owner's All-rooms view. `access`
   * is the ownership gate — orthogonal to the room filter.
   */
  async list(
    options?: ListOptions,
    access?: ConversationAccessContext,
  ): Promise<ConversationListResult> {
    await this.ensurePopulated();

    let items = [...this.entries.values()];
    if (options?.workspaceId) {
      items = items.filter((e) => e.wsId === options.workspaceId);
    }
    if (access) {
      items = items.filter((e) => canAccess({ ownerId: e.accessOwnerId }, access));
    }

    let summaries = items.map((e) => e.summary);
    if (options?.search) {
      const q = options.search.toLowerCase();
      summaries = summaries.filter(
        (s) => (s.title?.toLowerCase().includes(q) ?? false) || s.preview.toLowerCase().includes(q),
      );
    }

    const sortBy = options?.sortBy ?? "updatedAt";
    summaries.sort((a, b) => b[sortBy].localeCompare(a[sortBy]));

    const totalCount = summaries.length;
    if (options?.cursor) {
      const idx = summaries.findIndex((s) => s.id === options.cursor);
      if (idx >= 0) summaries = summaries.slice(idx + 1);
    }
    const limit = options?.limit ?? 20;
    const page = summaries.slice(0, limit);
    const nextCursor =
      page.length === limit && summaries.length > limit
        ? (page[page.length - 1]?.id ?? null)
        : null;

    return { conversations: page, nextCursor, totalCount };
  }

  private async ensurePopulated(): Promise<void> {
    if (this.populated) return;
    this.entries.clear();

    // One tree walk for both this index and the usage aggregator's file list.
    let ownerlessSkipped = 0;
    for (const filePath of listAllConversationFiles(this.workspacesRoot)) {
      const loc = parseConversationPath(filePath);
      if (!loc) continue;
      try {
        const content = await readFile(filePath, "utf-8");
        const parsed = parseFileHeader(content);
        if (!parsed) {
          ownerlessSkipped++;
          continue;
        }
        this.entries.set(parsed.summary.id, {
          summary: parsed.summary,
          accessOwnerId: parsed.summary.ownerId,
          wsId: loc.wsId,
          ownerId: loc.ownerId,
          automationId: loc.automationId,
          filePath,
        });
      } catch {
        // Corrupt / unreadable file — skip, same posture as the per-dir index.
      }
    }

    if (ownerlessSkipped > 0) {
      log.warn(
        `[locator] excluded ${ownerlessSkipped} ownerless conversation file(s) — run \`bun run migrate:conversations-to-room\` to stamp ownerId.`,
      );
    }
    this.populated = true;
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Absolute paths of every conversation JSONL across all rooms, via the same
 * targeted walk the locator uses (each room's `conversations/` owner and
 * `_runs/` partitions). For read-side consumers that need the raw files
 * spanning rooms (e.g. the usage aggregator), without building the full index.
 */
export function listAllConversationFiles(workspacesRoot: string): string[] {
  const out: string[] = [];
  for (const wsId of safeReaddir(workspacesRoot)) {
    if (!isWorkspaceDir(wsId)) continue;
    const convRoot = join(workspacesRoot, wsId, "conversations");
    for (const partition of safeReaddir(convRoot)) {
      const partitionDir = join(convRoot, partition);
      const leafDirs =
        partition === RUN_PARTITION_SEGMENT
          ? safeReaddir(partitionDir).map((automationId) => join(partitionDir, automationId))
          : [partitionDir];
      for (const leaf of leafDirs) {
        for (const f of safeReaddir(leaf)) {
          if (f.endsWith(".jsonl")) out.push(join(leaf, f));
        }
      }
    }
  }
  return out;
}
