/**
 * Cross-workspace tool list aggregator.
 *
 * Public entry point for Stage 2 chat / `/mcp` sessions: given an
 * identity, return the union of every tool the identity can call,
 * namespaced via `namespacedToolName(wsId, t.name)`. The orchestrator
 * (T004) and the identity-bound runtime chat (T006) / `/mcp` session
 * (T007) consume this surface — each call returns the cached union
 * after the first lookup.
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
 * sole legal builder for `ws_<id>/<name>` strings. The
 * `check:tool-namespace` lint rejects any hand-built form elsewhere.
 */

import { namespacedToolName } from "../tools/namespace.ts";
import type { Workspace } from "../workspace/types.ts";
import {
  type NamespacedToolDescriptor,
  ToolListCache,
  type ToolListCacheOptions,
  type WorkspaceToolLister,
} from "./tool-list-cache.ts";

export type { NamespacedToolDescriptor, WorkspaceToolLister } from "./tool-list-cache.ts";

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
  cache?: ToolListCacheOptions;
}

/**
 * Public handle returned by `createToolListAggregator`.
 *
 * `aggregateToolList(identityId)` is the load-bearing method. The
 * remaining surface exists for the orchestrator and the test suite —
 * `invalidateIdentity` for membership-change pushes,
 * `activeWatcherCount` for the leak-free-shutdown integration test,
 * `dispose` for the cleanup path the runtime will eventually call on
 * `shutdown()` (T006 wires this in).
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
    return cache.getUnionForIdentity(identityId, wsIds, namespacedToolName);
  };

  const invalidateIdentity = (identityId: string): void => {
    cache.invalidateIdentity(identityId);
    identityMembershipStamp.delete(identityId);
  };

  const dispose = (): void => {
    cache.dispose();
    identityMembershipStamp.clear();
  };

  const activeWatcherCount = (): number => cache.activeWatcherCount();

  return {
    aggregateToolList,
    invalidateIdentity,
    activeWatcherCount,
    dispose,
  };
}
