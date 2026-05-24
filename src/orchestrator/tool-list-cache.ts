/**
 * Watcher-driven cache for the per-workspace tool list.
 *
 * Modeled on `src/bundles/conversations/src/index-cache.ts` — same shape
 * (lazy populate on first read + `fs.watch` invalidation + debounce). The
 * pattern is load-bearing per `SPEC_REFERENCE.md` § "Stage 1 lessons to
 * carry forward" item 5: re-scanning the FS on every `aggregateToolList`
 * call is exactly the `getUserConversationStore` perf footgun this
 * refactor is meant to head off.
 *
 * Layout:
 *
 *   ToolListCache
 *     ├─ Per-workspace `Tool[]` (Map<wsId, Promise<Tool[]>>) — populated
 *     │  lazily on first ask. Each entry resolves through the
 *     │  caller-supplied `listToolsForWorkspace(wsId)`.
 *     ├─ Per-identity `NamespacedToolDescriptor[]` (Map<identityId,
 *     │  Promise<NamespacedToolDescriptor[]>>) — the union the
 *     │  orchestrator hands out.
 *     ├─ One `fs.watch` per workspace, attached on first touch and
 *     │  shared across every identity whose membership includes that
 *     │  workspace. Coalesces burst events into a debounce window
 *     │  (default 100ms — inside the spec's 50–250ms band, matching
 *     │  `index-cache`'s shape).
 *     └─ `dispose()` closes every watcher and clears every cache.
 *
 * What the watcher watches: each workspace's `workspace.json` file at
 * `<workDir>/workspaces/<wsId>/workspace.json` — the canonical
 * persistence target for `bundles[]` writes by `BundleLifecycleManager`
 * via `WorkspaceStore.update` (and the in-place `atomicWrite` calls in
 * `src/bundles/lifecycle.ts`). When that file changes (install /
 * uninstall / reorder), the per-workspace tool list might too — drop the
 * cached entry and every identity-union that included this workspace.
 *
 * The cache deliberately does NOT model "remove this identity from
 * `userIdentities`" or "remove this workspace from the workspaces set"
 * via FS events — those are membership / store-shape changes the
 * aggregator detects on its own when the identity's
 * `workspaceStore.getWorkspacesForUser(...)` answer changes. A separate
 * `invalidateIdentity(identityId)` entry point lets the orchestrator
 * push membership-change signals in explicitly (workspace removed,
 * member removed, etc.). Keeping membership outside the watcher avoids
 * polling the workspace store from the FS layer.
 */

import { type FSWatcher, watch } from "node:fs";
import { join } from "node:path";
import { log } from "../cli/log.ts";
import type { Tool } from "../tools/types.ts";

// ── Defaults ───────────────────────────────────────────────────────

/**
 * Debounce window for coalescing burst FS events on a single
 * `workspace.json`. Matches `index-cache`'s 500ms in shape but tuned
 * tighter (100ms) for tool-list freshness; the spec allows 50–250ms.
 *
 * Override per-instance via `ToolListCacheOptions.debounceMs` — every
 * test under `test/integration/tool-list-aggregator-watch.test.ts` sets
 * a smaller value so the suite doesn't have to wait for the production
 * default to fire.
 */
const DEFAULT_DEBOUNCE_MS = 100;

// ── Public shapes ──────────────────────────────────────────────────

/**
 * A tool entry in the aggregated cross-workspace list.
 *
 * The `name` field is the canonical `ws_<id>/<toolName>` form built via
 * `namespacedToolName(wsId, t.name)` — never hand-assembled. `wsId` and
 * `toolName` are carried alongside as derived bookkeeping (so callers
 * don't have to re-parse to render breadcrumbs or attribute audit
 * entries). The remaining fields mirror `Tool` from `src/tools/types.ts`.
 */
export interface NamespacedToolDescriptor {
  /** Canonical `ws_<id>/<toolName>` form. */
  name: string;
  /** Workspace this tool lives in. Same as the `ws_<id>` portion of `name`. */
  wsId: string;
  /** Bare tool name (no `ws_` prefix, no `__`-prefixed source). */
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  execution?: {
    taskSupport?: "optional" | "required" | "forbidden";
  };
}

/**
 * Per-workspace tool lister. Caller supplies one of these (typically
 * `(wsId) => runtime.getRegistryForWorkspace(wsId).availableTools()` in
 * production). The lister is treated as the source of truth and is the
 * only function the cache invokes for a given workspace until the
 * watcher fires.
 *
 * Returns `Tool[]` (bare names) — the cache namespaces every entry via
 * `namespacedToolName` before handing it to a consumer.
 */
export type WorkspaceToolLister = (wsId: string) => Promise<readonly Tool[]>;

export interface ToolListCacheOptions {
  /** Override the 100ms default. Lower for tests, higher in production. */
  debounceMs?: number;
}

// ── Implementation ─────────────────────────────────────────────────

/**
 * One per workspace; tracks both the watcher and the in-flight promise.
 *
 * `toolsPromise === null` means "next ask will trigger a fresh
 * `listToolsForWorkspace` call." When a watcher fires, we null the
 * promise — the next caller pays the listing cost on demand, not in
 * the watcher callback.
 *
 * `pendingDebounce` is the scheduled invalidation timer; it's cleared
 * on every fresh event so a burst of writes collapses to one
 * invalidation at burst-end.
 */
interface WorkspaceWatchEntry {
  watcher: FSWatcher;
  toolsPromise: Promise<readonly Tool[]> | null;
  pendingDebounce: ReturnType<typeof setTimeout> | null;
  /**
   * Identities currently caching a union that includes this workspace.
   * Updated by the aggregator when it computes / drops a per-identity
   * entry; consulted in the watcher callback to invalidate exactly the
   * identities that need it.
   */
  subscribedIdentities: Set<string>;
}

export class ToolListCache {
  private readonly workspacesDir: string;
  private readonly lister: WorkspaceToolLister;
  private readonly debounceMs: number;

  /** Per-workspace cache + watcher. */
  private readonly workspaces = new Map<string, WorkspaceWatchEntry>();

  /** Per-identity union cache — the public answer the aggregator hands out. */
  private readonly identityUnions = new Map<string, Promise<readonly NamespacedToolDescriptor[]>>();

  private disposed = false;

  constructor(workDir: string, lister: WorkspaceToolLister, options: ToolListCacheOptions = {}) {
    this.workspacesDir = join(workDir, "workspaces");
    this.lister = lister;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  // ── Per-workspace ─────────────────────────────────────────────────

  /**
   * Return the cached `Tool[]` for `wsId`, populating on first ask.
   *
   * Wraps the lister call in a memoized promise so concurrent callers
   * during the first listing all share one in-flight request — the same
   * pattern `index-cache` relies on for cold-start fan-in.
   *
   * If the lister rejects, the rejection is propagated to the awaiter
   * and the cached slot is cleared so a subsequent call retries. This
   * mirrors the registry's per-source error containment in
   * `ToolRegistry.availableTools` (one stuck source shouldn't poison
   * the cache forever).
   */
  async getWorkspaceTools(wsId: string): Promise<readonly Tool[]> {
    this.assertOpen();
    const entry = this.ensureWatchEntry(wsId);
    if (entry.toolsPromise === null) {
      // Holder pattern: declare a mutable holder so the catch can
      // self-identify against the cached slot without a forward
      // reference to the variable that captures it. A naked IIFE
      // referencing its own outer-let binding trips
      // `used before assignment`.
      const holder: { p: Promise<readonly Tool[]> | null } = { p: null };
      holder.p = this.lister(wsId).catch((err: unknown) => {
        // Drop the cached slot so the next call retries instead of
        // serving a permanently-poisoned rejection — same posture as
        // `ToolRegistry.availableTools` (one-source-down doesn't
        // poison the cache forever).
        if (entry.toolsPromise === holder.p) entry.toolsPromise = null;
        throw err;
      });
      entry.toolsPromise = holder.p;
    }
    return entry.toolsPromise;
  }

  // ── Per-identity union ────────────────────────────────────────────

  /**
   * Lazily compute and memoize the union for `identityId` from the
   * supplied workspace ids. Each workspace listing is concurrent
   * (`Promise.all`) — pins the perf contract under the
   * "Concurrent enumeration" test. Identity-level cache hits skip
   * the workspace loop entirely.
   *
   * Watcher attachment for each workspace happens inside
   * `getWorkspaceTools` → `ensureWatchEntry`, so this call site
   * doesn't have to know FS layout. Membership tracking
   * (`subscribedIdentities`) is updated here because the workspace
   * watcher needs to know which identity unions to drop when its
   * `workspace.json` changes.
   */
  async getUnionForIdentity(
    identityId: string,
    wsIds: readonly string[],
    namespace: (wsId: string, toolName: string) => string,
  ): Promise<readonly NamespacedToolDescriptor[]> {
    this.assertOpen();
    const existing = this.identityUnions.get(identityId);
    if (existing) return existing;

    const p = (async (): Promise<readonly NamespacedToolDescriptor[]> => {
      // Record interest BEFORE listing so an FS event during listing
      // invalidates correctly. Order matters: the watcher needs the
      // identity in its set the moment any one workspace's listing
      // starts.
      for (const wsId of wsIds) {
        const entry = this.ensureWatchEntry(wsId);
        entry.subscribedIdentities.add(identityId);
      }
      // Concurrent per-workspace listings (Promise pipelining, case 5 in
      // the task spec). Settled, not all-or-nothing: a single workspace
      // whose listing rejects (e.g. its registry can't be constructed)
      // must NOT nuke the identity's entire aggregated tool list — degrade
      // gracefully and surface what the healthy workspaces provide. The
      // lister already contains per-SOURCE failures one level down; this
      // catches the rarer whole-WORKSPACE listing failure.
      const settled = await Promise.allSettled(
        wsIds.map(async (wsId) => ({ wsId, tools: await this.getWorkspaceTools(wsId) })),
      );
      const out: NamespacedToolDescriptor[] = [];
      for (const result of settled) {
        if (result.status === "rejected") {
          log.debug(
            "mcp",
            `[tool-list-cache] dropping a workspace from the union for identity "${identityId}": ${
              result.reason instanceof Error ? result.reason.message : String(result.reason)
            }`,
          );
          continue;
        }
        const { wsId, tools } = result.value;
        for (const t of tools) {
          out.push({
            name: namespace(wsId, t.name),
            wsId,
            toolName: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            ...(t.annotations !== undefined ? { annotations: t.annotations } : {}),
            ...(t.execution !== undefined ? { execution: t.execution } : {}),
          });
        }
      }
      return out;
    })();
    this.identityUnions.set(identityId, p);
    // If the union failed, drop it so the next call retries — same
    // posture as `getWorkspaceTools`. The clearer pattern is to await
    // here, but doing so would serialize unrelated identities; instead
    // we hang an error-handler off the cached promise.
    p.catch(() => {
      if (this.identityUnions.get(identityId) === p) {
        this.identityUnions.delete(identityId);
      }
    });
    return p;
  }

  /**
   * Drop the cached union for `identityId` (e.g. after a membership
   * change the FS watcher can't see). Idempotent. Also unsubscribes
   * this identity from every workspace's invalidation list so a stale
   * subscription doesn't keep firing into a deleted union.
   */
  invalidateIdentity(identityId: string): void {
    this.identityUnions.delete(identityId);
    for (const entry of this.workspaces.values()) {
      entry.subscribedIdentities.delete(identityId);
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  /**
   * Close every watcher, clear every debounce timer, drop every
   * cache entry. Idempotent. After `dispose()` the cache is closed —
   * further `getWorkspaceTools` / `getUnionForIdentity` calls throw.
   *
   * The `index-cache` analog is `stopWatching()`. We close more here
   * (the per-identity union map is cleared too) because the cache
   * is per-runtime, not per-store: there's no "running but not
   * watching" intermediate state.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.workspaces.values()) {
      if (entry.pendingDebounce !== null) {
        clearTimeout(entry.pendingDebounce);
        entry.pendingDebounce = null;
      }
      entry.watcher.close();
    }
    this.workspaces.clear();
    this.identityUnions.clear();
  }

  // ── Test / inspection helpers ─────────────────────────────────────

  /**
   * Count active watchers. Lets the integration test assert that
   * `dispose()` closes them all without reaching into the private map.
   */
  activeWatcherCount(): number {
    return this.workspaces.size;
  }

  /**
   * True if `identityId` has a memoized union. Used by the cache-hit
   * tests; exposed deliberately rather than scraping internals.
   */
  hasIdentityCached(identityId: string): boolean {
    return this.identityUnions.has(identityId);
  }

  // ── Internal ──────────────────────────────────────────────────────

  private ensureWatchEntry(wsId: string): WorkspaceWatchEntry {
    const existing = this.workspaces.get(wsId);
    if (existing) return existing;
    const wsFile = join(this.workspacesDir, wsId, "workspace.json");
    const wsDir = join(this.workspacesDir, wsId);
    // `fs.watch` on a directory delivers events when the file inside
    // is replaced atomically (write to temp, rename) — the pattern
    // `BundleLifecycleManager.atomicWrite` and
    // `WorkspaceStore.atomicWrite` both use. Watching the file
    // directly would miss the rename on macOS / Linux; watching the
    // directory catches every replacement.
    const watcher = watch(wsDir, (_eventType, filename) => {
      if (filename !== "workspace.json") return;
      this.scheduleInvalidate(wsId);
    });
    // Surface the underlying error path explicitly so a swallowed
    // watcher failure doesn't silently leave the cache stale forever.
    watcher.on("error", () => {
      // The cache's posture on a watcher error is to drop the cached
      // entry — next ask re-lists. Closing the watcher avoids leaking
      // a dead handle.
      this.invalidateWorkspace(wsId);
      try {
        watcher.close();
      } catch {
        // best-effort — already-closed watchers throw on close
      }
      this.workspaces.delete(wsId);
    });
    const entry: WorkspaceWatchEntry = {
      watcher,
      toolsPromise: null,
      pendingDebounce: null,
      subscribedIdentities: new Set(),
    };
    this.workspaces.set(wsId, entry);
    // Touch `wsFile` so a `noUnusedLocals` style check doesn't drop the
    // computed path — we keep it computed because operator stderr
    // logging may want to surface "watching <path>" diagnostics in
    // a later patch. Cheap; zero-runtime if the variable goes unused.
    void wsFile;
    return entry;
  }

  private scheduleInvalidate(wsId: string): void {
    const entry = this.workspaces.get(wsId);
    if (!entry) return;
    if (entry.pendingDebounce !== null) {
      clearTimeout(entry.pendingDebounce);
    }
    entry.pendingDebounce = setTimeout(() => {
      entry.pendingDebounce = null;
      this.invalidateWorkspace(wsId);
    }, this.debounceMs);
  }

  private invalidateWorkspace(wsId: string): void {
    const entry = this.workspaces.get(wsId);
    if (!entry) return;
    entry.toolsPromise = null;
    // Drop every identity union that read from this workspace.
    for (const identityId of entry.subscribedIdentities) {
      this.identityUnions.delete(identityId);
    }
    entry.subscribedIdentities.clear();
  }

  private assertOpen(): void {
    if (this.disposed) {
      throw new Error("[tool-list-cache] cache is disposed; create a new one to keep operating");
    }
  }
}
