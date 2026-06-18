/**
 * Watcher-driven cache for the per-workspace tool list.
 *
 * Modeled on `src/bundles/conversations/src/index-cache.ts` — same shape
 * (lazy populate on first read + `fs.watch` invalidation + debounce). The
 * pattern is load-bearing: re-scanning the FS on every `aggregateToolList`
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
 * For a **workspace** tool the `name` field is the canonical
 * `ws_<id>-<toolName>` form built via `namespacedToolName(wsId, t.name)` —
 * never hand-assembled. For a kernel **identity** tool (conversations, …)
 * there is no workspace: `name` is the bare `<source>__<tool>` and `wsId` is
 * `null`. `wsId` and `toolName` are derived bookkeeping (so callers don't have
 * to re-parse to render breadcrumbs or attribute audit entries); no consumer
 * routes on `wsId` — routing reads the name's shape. The remaining fields
 * mirror `Tool` from `src/tools/types.ts`.
 */
export interface NamespacedToolDescriptor {
  /** Canonical `ws_<id>-<toolName>` (workspace) or bare `<source>__<tool>` (identity). */
  name: string;
  /** Workspace this tool lives in, or `null` for an identity-owned tool. */
  wsId: string | null;
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
 * One workspace's listing: the bare-named tools plus whether enumeration
 * was COMPLETE. `complete: false` means at least one source was skipped
 * because it wasn't ready yet (cold start, subprocess restart, pending
 * auth), so the list is partial — the cache must not memoize it.
 */
export interface WorkspaceToolListing {
  tools: readonly Tool[];
  complete: boolean;
}

/**
 * Per-workspace tool lister. Caller supplies one of these (typically a
 * wrapper over `runtime.getRegistryForWorkspace(wsId)` in production). The
 * lister is treated as the source of truth and is the only function the
 * cache invokes for a given workspace until the watcher fires.
 *
 * Returns a {@link WorkspaceToolListing}: bare-named `Tool[]` (the cache
 * namespaces every entry via `namespacedToolName` before handing it to a
 * consumer) plus a `complete` flag. The cache refuses to memoize a listing
 * whose `complete` is false, so a partial cold-start snapshot can never go
 * sticky and starve discovery until an unrelated invalidation fires.
 */
export type WorkspaceToolLister = (wsId: string) => Promise<WorkspaceToolListing>;

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
  /**
   * Memoized listing — only ever a COMPLETE one. `null` means "next ask
   * re-lists." A partial (cold-start) listing is never stored here, so a
   * present `toolsPromise` is complete by construction.
   */
  toolsPromise: Promise<readonly Tool[]> | null;
  /**
   * Shared in-flight listing so concurrent first-askers don't each hit the
   * lister. Carries the `complete` flag (unlike `toolsPromise`, which holds
   * complete listings only) so the awaiter can decide whether to memoize.
   * Cleared when it settles.
   */
  listingInFlight: Promise<WorkspaceToolListing> | null;
  /**
   * Bumped on every invalidation. A listing captures it before calling the
   * lister and refuses to memoize if it changed while in flight — so an
   * invalidation that lands DURING a compute can't be overwritten by the
   * now-stale result that compute is about to produce.
   */
  generation: number;
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

  /**
   * Per-identity union cache — the public answer the aggregator hands out.
   * Only ever holds a union built entirely from COMPLETE workspace listings.
   */
  private readonly identityUnions = new Map<string, Promise<readonly NamespacedToolDescriptor[]>>();

  /**
   * Shared in-flight union computations, keyed by identity, so concurrent
   * first-askers share one fan-out. Carries the union's `complete` flag so
   * the awaiter only memoizes a union with no partial contributing
   * workspace. Cleared when it settles.
   */
  private readonly unionInFlight = new Map<
    string,
    Promise<{ union: readonly NamespacedToolDescriptor[]; complete: boolean }>
  >();

  /**
   * Per-identity generation counter — the union-level analog of
   * `WorkspaceWatchEntry.generation`. Bumped whenever an invalidation touches
   * the identity (a workspace it subscribes to changed, or its membership
   * changed). A union compute captures it up front and refuses to memoize if
   * it changed mid-flight, so an invalidation during the compute can't be
   * clobbered by the stale union about to resolve.
   *
   * Deliberately the one structure here that does NOT reap (unlike orphaned
   * watchers or `identityUnions`): it's monotonic and only cleared in
   * `dispose`. Growth is bounded by distinct identities over the process
   * lifetime (a tenant's user count) at one small int each — not a leak worth
   * chasing. Reaping it would be actively unsafe unless guarded: a plain
   * delete resets the entry to 0, and if that 0 happens to equal an in-flight
   * compute's captured epoch the guard reads "unchanged" and memoizes a result
   * the invalidation should have rejected. A correctness-sensitive conditional
   * to reclaim kilobytes is a bad trade, so we don't. Monotonic; never deleted
   * outside `dispose` (resetting could let a stale in-flight read as current).
   */
  private readonly identityEpochs = new Map<string, number>();

  private disposed = false;

  constructor(workDir: string, lister: WorkspaceToolLister, options: ToolListCacheOptions = {}) {
    this.workspacesDir = join(workDir, "workspaces");
    this.lister = lister;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  // ── Per-workspace ─────────────────────────────────────────────────

  /**
   * Return the listing for `wsId`, populating on first ask.
   *
   * Concurrent first-askers share one in-flight request (`listingInFlight`)
   * — the cold-start fan-in pattern `index-cache` relies on.
   *
   * Memoization is gated on completeness: a COMPLETE listing is cached in
   * `toolsPromise` (served directly on the next ask); a PARTIAL listing (a
   * source skipped because it wasn't ready) is returned to this caller but
   * left uncached, so the next ask re-lists once the source is up. This is
   * the core of the stale-empty-union fix — an incomplete snapshot can never
   * become sticky and starve discovery until some unrelated invalidation
   * happens to fire.
   *
   * If the lister rejects, the rejection propagates and nothing is cached, so
   * a subsequent call retries — mirroring `ToolRegistry.availableTools`'
   * per-source containment (one stuck source shouldn't poison the cache).
   */
  async getWorkspaceListing(wsId: string): Promise<WorkspaceToolListing> {
    this.assertOpen();
    const entry = this.ensureWatchEntry(wsId);
    // Memoized hit — present `toolsPromise` is complete by construction.
    if (entry.toolsPromise !== null) {
      return { tools: await entry.toolsPromise, complete: true };
    }
    // Share an in-flight listing across concurrent first-askers.
    if (entry.listingInFlight !== null) return entry.listingInFlight;
    // Capture the generation before listing. If an invalidation lands while
    // the lister runs it bumps `generation`, and we refuse to memoize the
    // now-stale result below — the next ask re-lists against current state.
    const gen = entry.generation;
    const inFlight = this.lister(wsId);
    entry.listingInFlight = inFlight;
    try {
      const listing = await inFlight;
      if (listing.complete && entry.generation === gen && entry.toolsPromise === null) {
        entry.toolsPromise = Promise.resolve(listing.tools);
      }
      return listing;
    } finally {
      if (entry.listingInFlight === inFlight) entry.listingInFlight = null;
    }
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
   * `getWorkspaceListing` → `ensureWatchEntry`, so this call site
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
    // A memoized union was built entirely from COMPLETE listings AND no
    // invalidation touched this identity while it was built (the epoch guard
    // below) — so it's both complete and fresh, safe to serve directly.
    if (existing) return existing;
    // Share an in-flight fan-out across concurrent first-askers.
    const inFlight = this.unionInFlight.get(identityId);
    if (inFlight) return inFlight.then((r) => r.union);

    // Capture the identity's generation before computing. An invalidation
    // landing mid-compute (a subscribed workspace changed, or membership
    // changed) bumps it, and we refuse to memoize below — leaving the union
    // uncached so the next ask rebuilds AND re-subscribes to the workspace
    // whose watcher set this identity was just cleared from.
    const epoch = this.identityEpochs.get(identityId) ?? 0;

    const compute = (async (): Promise<{
      union: readonly NamespacedToolDescriptor[];
      complete: boolean;
    }> => {
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
        wsIds.map(async (wsId) => ({ wsId, listing: await this.getWorkspaceListing(wsId) })),
      );
      const out: NamespacedToolDescriptor[] = [];
      // The union is complete only if every workspace listing succeeded AND
      // was itself complete. A rejected whole-workspace listing or a partial
      // (cold-start) one makes the union partial — see below.
      let complete = true;
      for (const result of settled) {
        if (result.status === "rejected") {
          complete = false;
          log.debug(
            "mcp",
            `[tool-list-cache] dropping a workspace from the union for identity "${identityId}": ${
              result.reason instanceof Error ? result.reason.message : String(result.reason)
            }`,
          );
          continue;
        }
        const { wsId, listing } = result.value;
        if (!listing.complete) complete = false;
        for (const t of listing.tools) {
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
      return { union: out, complete };
    })();

    this.unionInFlight.set(identityId, compute);
    try {
      const { union, complete } = await compute;
      // Memoize ONLY when (a) no contributing workspace was partial, and (b)
      // no invalidation touched this identity while we were computing
      // (epoch unchanged). (a) keeps a cold-start partial out of the cache;
      // (b) keeps a result that an invalidation already superseded out — and,
      // critically, leaves it uncached so the next ask re-subscribes to any
      // workspace this identity was unsubscribed from mid-compute. Without (b)
      // we'd memoize a stale union with a broken watcher subscription — the
      // very "stale until an unrelated invalidation" failure this PR kills.
      if (complete && (this.identityEpochs.get(identityId) ?? 0) === epoch) {
        this.identityUnions.set(identityId, Promise.resolve(union));
      }
      return union;
    } finally {
      if (this.unionInFlight.get(identityId) === compute) {
        this.unionInFlight.delete(identityId);
      }
    }
  }

  /**
   * Compose a union over an EXPLICIT workspace set, with NO identity-level
   * memo. Used by the focus-scoped path (workspace lockdown): the set is
   * `{focused, personal}`, which varies per turn, so the `identityId`-keyed
   * memo in {@link getUnionForIdentity} would serve a stale union for a
   * different focus. The per-WORKSPACE listings this fans out over ARE cached +
   * FS-watched (`getWorkspaceListing`), so recomposing a 2-element union per
   * call is cheap and always fresh — no second cache to invalidate. A rejected
   * whole-workspace listing is dropped (degrade gracefully), mirroring
   * {@link getUnionForIdentity}. No `subscribedIdentities` tracking: there is no
   * memoized union here to invalidate.
   */
  async composeUnion(
    wsIds: readonly string[],
    namespace: (wsId: string, toolName: string) => string,
  ): Promise<readonly NamespacedToolDescriptor[]> {
    this.assertOpen();
    const settled = await Promise.allSettled(
      wsIds.map(async (wsId) => ({ wsId, listing: await this.getWorkspaceListing(wsId) })),
    );
    const out: NamespacedToolDescriptor[] = [];
    for (const result of settled) {
      if (result.status === "rejected") {
        log.debug(
          "mcp",
          `[tool-list-cache] composeUnion dropping a workspace: ${
            result.reason instanceof Error ? result.reason.message : String(result.reason)
          }`,
        );
        continue;
      }
      const { wsId, listing } = result.value;
      for (const t of listing.tools) {
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
  }

  /**
   * Drop the cached union for `identityId` (e.g. after a membership
   * change the FS watcher can't see). Idempotent. Also unsubscribes
   * this identity from every workspace's invalidation list so a stale
   * subscription doesn't keep firing into a deleted union.
   *
   * Reaps any workspace watcher whose last subscriber was this identity
   * (e.g. the identity lost access via a workspace delete / membership
   * change). Without this, watchers accumulate for the lifetime of the
   * process — an fd leak under long-lived per-tenant workspace churn. The
   * watcher is lazily re-created by `ensureWatchEntry` on the next listing,
   * so reaping a still-needed workspace is self-healing; shared workspaces
   * (other identities still subscribed) keep their watcher.
   */
  invalidateIdentity(identityId: string): void {
    this.identityUnions.delete(identityId);
    // Bump the identity epoch so an in-flight union compute for this identity
    // refuses to memoize a result built before this membership change.
    this.bumpIdentityEpoch(identityId);
    const orphaned: string[] = [];
    for (const [wsId, entry] of this.workspaces) {
      entry.subscribedIdentities.delete(identityId);
      if (entry.subscribedIdentities.size === 0) orphaned.push(wsId);
    }
    for (const wsId of orphaned) {
      const entry = this.workspaces.get(wsId);
      if (!entry) continue;
      if (entry.pendingDebounce !== null) clearTimeout(entry.pendingDebounce);
      try {
        entry.watcher.close();
      } catch {
        // best-effort — an already-closed watcher throws on close
      }
      this.workspaces.delete(wsId);
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  /**
   * Close every watcher, clear every debounce timer, drop every
   * cache entry. Idempotent. After `dispose()` the cache is closed —
   * further `getWorkspaceListing` / `getUnionForIdentity` calls throw.
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
    this.unionInFlight.clear();
    this.identityEpochs.clear();
  }

  /** Bump an identity's generation so any in-flight union compute for it
   *  refuses to memoize a now-superseded result. */
  private bumpIdentityEpoch(identityId: string): void {
    this.identityEpochs.set(identityId, (this.identityEpochs.get(identityId) ?? 0) + 1);
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
      listingInFlight: null,
      generation: 0,
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

  /**
   * Drop the cached tool list for `wsId` and every identity union that read
   * from it; the next ask re-lists. Safe to call when nothing is cached for
   * `wsId` (early-returns). Called by the debounce watcher (external
   * `workspace.json` edits) AND, post-Stage-2, by the aggregator when a
   * source-readiness transition fires — see
   * `ToolRegistry.setInvalidationListener`. Deliberately does NOT touch the
   * aggregator's membership stamp or reap watchers (that's
   * `invalidateIdentity`'s job): a source coming online is a tool-set change,
   * not a membership change.
   */
  invalidateWorkspace(wsId: string): void {
    const entry = this.workspaces.get(wsId);
    if (!entry) return;
    // Bump generation and clear any in-flight listing so a listing already
    // running against the old state can't memoize, and a caller arriving
    // after this point starts a fresh listing rather than sharing the stale
    // in-flight one.
    entry.generation += 1;
    entry.toolsPromise = null;
    entry.listingInFlight = null;
    // Drop every identity union that read from this workspace, and bump each
    // identity's epoch so an in-flight union compute for it refuses to memoize
    // a result built before this change.
    for (const identityId of entry.subscribedIdentities) {
      this.identityUnions.delete(identityId);
      this.bumpIdentityEpoch(identityId);
    }
    entry.subscribedIdentities.clear();
  }

  private assertOpen(): void {
    if (this.disposed) {
      throw new Error("[tool-list-cache] cache is disposed; create a new one to keep operating");
    }
  }
}
