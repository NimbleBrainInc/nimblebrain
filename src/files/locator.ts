/**
 * Process-wide file locator.
 *
 * Files are workspace-owned — each lives under
 * `workspaces/<wsId>/files/<ownerId>/<fileId>_<name>`, with a per-owner
 * `registry.jsonl` in that partition. A `FileStore` operates within one
 * owner+workspace directory and knows nothing of other workspaces. The locator
 * is the one component that sees ACROSS workspaces: it answers the question a
 * single-partition store cannot —
 *
 *   **resolve-by-id:** `(ownerId, fileId) → wsId`, so a context-free fetch (the
 *   browser `<img>` GET, a download, any caller that has only the globally-unique
 *   file id) can construct the right workspace store. Tool calls and `/mcp` never
 *   need this — they carry the workspace in the request — so this exists for the
 *   one path that doesn't: a browser GET of the bare `/v1/files/:fileId`.
 *
 * **Owner-scoped by construction.** `locate` only ever searches the caller's OWN
 * `<ownerId>` partitions, and its consumer reads through a store rooted at the
 * same `(wsId, ownerId)`. The owner partition is therefore both the gate and the
 * search scope: there is no client-supplied coordinate, and a request can only
 * ever reach the caller's own bytes. Reading a file SHARED by another owner
 * (Phase 2 `visibility: shared`) is a separate, visibility-checked path — never a
 * widening of this locator to scan other owners.
 *
 * **Memo, not source of truth.** An `(ownerId, fileId) → wsId` memo makes the
 * hot path (an id served repeatedly, or just uploaded) O(1); the caller `peek`s
 * it, then falls through to `resolve` — a path-only readdir walk of the owner's
 * partitions — on a miss. The memo is populated on write (`remember`, from
 * `getWorkspaceFileStore`) and dropped on delete (`forget`); a stale hit is
 * self-healing — the consumer `forget`s it and re-`resolve`s from disk if a read
 * at the memoised location fails. Because it's never the source of truth, a
 * process-local memo stays correct under `replicas > 1`: a miss (or a poisoned
 * hit) costs a walk, not a wrong answer.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { log } from "../observability/log.ts";
import { workspaceFilesDir } from "./paths.ts";

function isWorkspaceDir(name: string): boolean {
  return name.startsWith("ws_");
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export class FileLocator {
  /**
   * `(ownerId, fileId) → wsId`. An optimization over the disk walk, never the
   * truth. Keyed by owner as well as id (not id alone) so the owner-scope wall
   * holds in the memo too: one owner's lookup can neither read nor evict
   * another owner's entry.
   */
  private memo = new Map<string, string>();
  private readonly workspacesRoot: string;

  /** @param workDir absolute path to the runtime work dir (`{workDir}/workspaces/...`). */
  constructor(private readonly workDir: string) {
    this.workspacesRoot = join(workDir, "workspaces");
  }

  // `\u0000` can't appear in an ownerId or fileId, so it's an unambiguous joiner.
  private memoKey(ownerId: string, fileId: string): string {
    return `${ownerId}\u0000${fileId}`;
  }

  /**
   * Record where a file was just written. Called from the write path
   * (`getWorkspaceFileStore`'s `saveFile`), where owner + workspace are known —
   * so a freshly uploaded file resolves O(1) without a walk.
   */
  remember(ownerId: string, fileId: string, wsId: string): void {
    this.memo.set(this.memoKey(ownerId, fileId), wsId);
  }

  /** Drop a memo entry — on delete, or when a read proves a hit stale. */
  forget(ownerId: string, fileId: string): void {
    this.memo.delete(this.memoKey(ownerId, fileId));
  }

  /**
   * Memo-only lookup — no disk. The hot path; `undefined` means "not cached,
   * resolve from disk." Kept separate from `resolve` so the caller can try the
   * cheap cache first and fall through to the authoritative walk only when a
   * cached location turns out stale (the self-heal path).
   */
  peek(ownerId: string, fileId: string): string | undefined {
    return this.memo.get(this.memoKey(ownerId, fileId));
  }

  /**
   * Disk-authoritative resolve of `fileId` within `ownerId`'s own partitions:
   * one path-only walk for `<fileId>_*` (no file reads), memoising the hit.
   * `undefined` if no partition holds it (→ the caller 404s).
   */
  async resolve(ownerId: string, fileId: string): Promise<string | undefined> {
    const wsId = this.walk(ownerId, fileId);
    if (wsId) this.memo.set(this.memoKey(ownerId, fileId), wsId);
    return wsId;
  }

  /**
   * Path-only walk: which of the owner's workspace partitions holds `<fileId>_*`.
   * File ids are globally unique, so at most one should match; if two do (a
   * pathological dup), refuse rather than guess — an ambiguous file is a
   * not-found, not a coin flip.
   */
  private walk(ownerId: string, fileId: string): string | undefined {
    const prefix = `${fileId}_`;
    let match: string | undefined;
    for (const wsId of safeReaddir(this.workspacesRoot)) {
      if (!isWorkspaceDir(wsId)) continue;
      const ownerDir = workspaceFilesDir(this.workDir, wsId, ownerId);
      for (const entry of safeReaddir(ownerDir)) {
        if (!entry.startsWith(prefix)) continue;
        if (match && match !== wsId) {
          log.warn(
            `[file-locator] id ${fileId} resolves in multiple workspaces (${match}, ${wsId}); refusing ambiguous resolution`,
          );
          return undefined;
        }
        match = wsId;
        break;
      }
    }
    return match;
  }
}
