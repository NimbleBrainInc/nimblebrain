/**
 * Cross-workspace tool list aggregator.
 *
 * Retained ONLY for the `/mcp` `tools/list` surface (`api/mcp-server.ts`):
 * given an identity, return the union of every tool the identity can call,
 * namespaced via `namespacedToolName(wsId, t.name)`. Each call returns the
 * cached union after the first lookup. The chat and task surfaces no longer
 * consume this — they are walled to one workspace and list via
 * `Runtime.listToolsForWorkspace(workspaceId)`. Removed once `/mcp` is bound to
 * a single workspace.
 *
 * Cache-shape contract (per task spec, audit-criteria item 1):
 *
 *  - Lazy population on first call per identity.
 *  - FS-watcher invalidation on every workspace's `workspace.json`
 *    (the bundle-state persistence target — see `BundleLifecycleManager`
 *    and `WorkspaceStore.update`).
 *  - One watcher per workspace, shared across identities.
 *  - Debounce on burst events; tunable, default 100ms.
 *
 * No re-scan-per-call. A test in `test/unit/orchestrator/...` calls
 * the aggregator 50× in a tight loop and asserts the per-workspace
 * lister fires once per workspace; the Stage 1 footgun (lesson 5)
 * regression would fire 100×, not 2.
 *
 * Namespacing: every entry is built through
 * `namespacedToolName(wsId, name)` from `src/tools/namespace.ts` — the
 * sole legal builder for `ws_<id>-<name>` strings. The
 * `check:tool-namespace` lint rejects any hand-built form elsewhere.
 */

import { namespacedToolName } from "../tools/namespace.ts";
import type { Tool } from "../tools/types.ts";
import type { Workspace } from "../workspace/types.ts";
import {
  type NamespacedToolDescriptor,
  ToolListCache,
  type ToolListCacheOptions,
  type WorkspaceToolLister,
} from "./tool-list-cache.ts";

export type {
  NamespacedToolDescriptor,
  WorkspaceToolLister,
  WorkspaceToolListing,
} from "./tool-list-cache.ts";

/**
 * Lists the kernel identity sources' tools (conversations, …), source-qualified
 * (`conversations__list`). Identity tools are owned by the user, not any
 * workspace, so the aggregator emits them BARE and prepends them to every
 * identity's union. v1 has no per-tenant identity sources, so the result is
 * static — listed once and never invalidated (unlike the per-workspace cache).
 */
export type IdentityToolLister = () => Promise<readonly Tool[]>;

// ── Surface the aggregator depends on ─────────────────────────────

/**
 * Minimal workspace store surface the aggregator needs.
 *
 * Carved as a typed interface rather than importing `WorkspaceStore`
 * directly so the unit test can pass a synthetic store with a tiny
 * in-memory `getWorkspacesForUser` — no temp dir, no JSON files. The
 * production `WorkspaceStore` matches structurally (see
 * `src/workspace/workspace-store.ts`).
 */
export interface AggregatorWorkspaceStore {
  getWorkspacesForUser(userId: string): Promise<Workspace[]>;
}

/**
 * Construction options for `createToolListAggregator`. `workDir` is
 * load-bearing: the cache derives `<workDir>/workspaces/<wsId>` from it
 * to attach the FS watcher.
 *
 * `listToolsForWorkspace` is the per-workspace lister. In production
 * the caller wires it through the runtime's per-workspace
 * `ToolRegistry.availableTools()`; in tests it's a stub that returns
 * a fixed `Tool[]`.
 */
export interface ToolListAggregatorOptions {
  workDir: string;
  workspaceStore: AggregatorWorkspaceStore;
  listToolsForWorkspace: WorkspaceToolLister;
  /**
   * Lists the kernel identity sources' tools, emitted bare and prepended to
   * every identity's union (see {@link IdentityToolLister}). Optional: tests
   * and non-identity callers omit it; the union is then workspace-only.
   */
  listIdentityTools?: IdentityToolLister;
  cache?: ToolListCacheOptions;
}

/**
 * Public handle returned by `createToolListAggregator`.
 *
 * `aggregateToolList(identityId)` is the load-bearing method. The
 * remaining surface exists for the orchestrator and the test suite —
 * `invalidateIdentity` for membership-change pushes,
 * `activeWatcherCount` for the leak-free-shutdown integration test,
 * `dispose` for the cleanup path the runtime calls on `shutdown()`
 * (wired in `runtime.ts`).
 */
export interface ToolListAggregator {
  aggregateToolList(identityId: string): Promise<readonly NamespacedToolDescriptor[]>;
  /**
   * Drop the cached union for `identityId`. The aggregator calls this
   * automatically when the workspace membership for the identity
   * changes (`getWorkspacesForUser` returns a different set than the
   * cache is keyed on). Exposed publicly so the orchestrator can push
   * explicit invalidation signals from membership-change events
   * (workspace removed, member removed) without depending on a fresh
   * `aggregateToolList` call to discover the drift.
   */
  invalidateIdentity(identityId: string): void;
  /**
   * Drop the cached tool list for one workspace and every identity union that
   * read from it. The reactive counterpart to {@link invalidateIdentity}:
   * that handles membership changes (a workspace left the identity's set);
   * this handles tool-set changes WITHIN a workspace that the
   * `workspace.json` watcher can't see — a bundle subprocess (re)connecting,
   * a deferred/pending-auth start completing, or a native
   * `tools/list_changed`. Wired from `ToolRegistry.setInvalidationListener`.
   * Does NOT touch the membership stamp (membership is unchanged).
   */
  invalidateWorkspace(wsId: string): void;
  /** Number of active per-workspace watchers — for the leak test. */
  activeWatcherCount(): number;
  /** Close every watcher, clear every cache. Idempotent. */
  dispose(): void;
}

// ── Construction ──────────────────────────────────────────────────

/**
 * Build a `ToolListAggregator` for a given runtime context.
 *
 * The returned handle is stateful (it owns the watcher cache). Code
 * paths that boot a runtime should construct exactly one and dispose
 * it on `runtime.shutdown()`. Tests that boot many fixtures back-to-back
 * MUST `dispose()` each one — otherwise `fs.watch` handles leak and
 * Bun's test process accumulates them across the suite.
 *
 * The "membership stamp" trick: we key the identity-union cache on the
 * full set of workspace ids the identity has access to. On every call
 * we re-read `getWorkspacesForUser(identityId)` (cheap — a single
 * directory listing) and compare against the cached set. If the set
 * has changed (a workspace was removed or the identity was added to
 * a new one), we invalidate the identity union and recompute. The
 * watcher catches in-workspace tool changes; this stamp catches
 * out-of-workspace membership changes. Together they cover both
 * invalidation channels without coupling to the workspace-store's
 * event surface.
 */
export function createToolListAggregator(options: ToolListAggregatorOptions): ToolListAggregator {
  const cache = new ToolListCache(
    options.workDir,
    options.listToolsForWorkspace,
    options.cache ?? {},
  );

  /**
   * Per-identity record of the workspace-id set the cached union was
   * built from. The watcher invalidates on tool-list changes; this map
   * invalidates on membership changes (a workspace was added to or
   * removed from the identity's set).
   */
  const identityMembershipStamp = new Map<string, string>();

  /**
   * Bare descriptors for the kernel identity sources, listed once. Identity
   * tools are static (code-defined, not per-tenant install), so unlike the
   * per-workspace cache they need no FS-watch invalidation — list on first
   * use, memoize, reuse for every identity. A failed OR empty listing drops
   * the memo so the next call retries (see below).
   */
  let identityDescriptorsPromise: Promise<readonly NamespacedToolDescriptor[]> | null = null;
  const getIdentityDescriptors = (): Promise<readonly NamespacedToolDescriptor[]> => {
    const lister = options.listIdentityTools;
    if (!lister) return Promise.resolve([]);
    if (!identityDescriptorsPromise) {
      const p = lister().then((tools) =>
        // Bare: `name === toolName`, `wsId === null`. The orchestrator routes
        // a bare `<source>__<tool>` through the identity door.
        tools.map((t) => ({
          name: t.name,
          wsId: null,
          toolName: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          ...(t.annotations !== undefined ? { annotations: t.annotations } : {}),
          ...(t.execution !== undefined ? { execution: t.execution } : {}),
        })),
      );
      identityDescriptorsPromise = p;
      // Clear the memo on rejection (retry next call) — AND on an empty
      // result. The kernel identity sources (conversations/files/automations)
      // are code-defined and always present, so an empty list is never a
      // legitimate steady state: it means the in-process sources weren't yet
      // enumerable when the first call landed (e.g. an aggregateToolList that
      // raced `Runtime.start`'s `_platformSources` assignment). Memoizing []
      // here would strand `files__read` & friends out of every session's tool
      // union for the whole process lifetime — the identity-side half of the
      // stale-union bug. Retrying while empty is bounded: it stops the instant
      // a non-empty list resolves (sources finish connecting), so steady state
      // is a single memoized non-empty promise, not a re-list loop. (A
      // deployment that genuinely ships zero identity sources omits
      // `listIdentityTools` entirely and never reaches this branch.)
      p.then(
        (descriptors) => {
          if (descriptors.length === 0 && identityDescriptorsPromise === p) {
            identityDescriptorsPromise = null;
          }
        },
        () => {
          if (identityDescriptorsPromise === p) identityDescriptorsPromise = null;
        },
      );
    }
    return identityDescriptorsPromise;
  };

  const aggregateToolList = async (
    identityId: string,
  ): Promise<readonly NamespacedToolDescriptor[]> => {
    if (typeof identityId !== "string" || identityId.length === 0) {
      throw new Error("[tool-list-aggregator] aggregateToolList: identityId is required");
    }
    const workspaces = await options.workspaceStore.getWorkspacesForUser(identityId);
    const wsIds = workspaces.map((ws) => ws.id).sort();
    const stamp = wsIds.join("|");
    const cachedStamp = identityMembershipStamp.get(identityId);
    if (cachedStamp !== undefined && cachedStamp !== stamp) {
      cache.invalidateIdentity(identityId);
    }
    identityMembershipStamp.set(identityId, stamp);
    // Identity tools (bare, workspace-agnostic) prepend the per-workspace
    // union. Two independent sources of truth: the cache owns workspace tools
    // and their invalidation; identity tools are static and live here. When
    // there are no identity tools, return the cache's memoized union *as-is*
    // (same reference) — only allocate a fresh array when there's actually
    // something to prepend.
    const [identityTools, wsUnion] = await Promise.all([
      getIdentityDescriptors(),
      cache.getUnionForIdentity(identityId, wsIds, namespacedToolName),
    ]);
    return identityTools.length === 0 ? wsUnion : [...identityTools, ...wsUnion];
  };

  const invalidateIdentity = (identityId: string): void => {
    cache.invalidateIdentity(identityId);
    identityMembershipStamp.delete(identityId);
  };

  const invalidateWorkspace = (wsId: string): void => {
    cache.invalidateWorkspace(wsId);
  };

  const dispose = (): void => {
    cache.dispose();
    identityMembershipStamp.clear();
  };

  const activeWatcherCount = (): number => cache.activeWatcherCount();

  return {
    aggregateToolList,
    invalidateIdentity,
    invalidateWorkspace,
    activeWatcherCount,
    dispose,
  };
}
