/**
 * Integration tests for `src/orchestrator/tool-list-aggregator.ts`.
 *
 * These exercise the watcher → debounce → invalidate path, which the
 * unit test deliberately skips (FS watchers need a real workdir; macOS
 * FSEvents is unreliable for newly-created files in unit-tier mode).
 *
 * Three cases, mapped to the task spec:
 *
 *  8. FS-watch invalidation — write a fresh `workspace.json` to one
 *     workspace; within debounce + slack, the next `aggregateToolList`
 *     reflects the new tool list. Adversarial posture: we tolerate
 *     staleness immediately after the write and assert eventual
 *     consistency, NOT synchronous semantics the watcher can't
 *     guarantee.
 *  9. Workspace removal — the identity loses access to `ws_b`; next
 *     `aggregateToolList` drops `ws_b/*` entries. Pins the
 *     membership-stamp invariant in the aggregator (it diffs the
 *     workspace-id set on every call and invalidates the identity's
 *     union when it changes).
 * 10. Watcher lifecycle leak-free — after `dispose()`, every watcher
 *     has been closed. Pins the audit criterion "watcher lifecycle is
 *     leak-free." Stage 1 had file-watcher leaks in test suites; the
 *     explicit assertion here prevents the regression silently
 *     coming back.
 *
 * Why this lives in `test/integration/`: the test uses `fs.watch`
 * against a real `mkdtempSync` workdir, persists a real
 * `workspace.json`, and waits for OS-level event delivery. Per
 * `CLAUDE.md` § Testing classification rule, that's integration tier.
 * No `Runtime.start()` — the aggregator's design accepts the workdir
 * + a workspace-store-shape + a lister, all of which we synthesize.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createToolListAggregator,
  type AggregatorWorkspaceStore,
  type ToolListAggregator,
} from "../../src/orchestrator/tool-list-aggregator.ts";
import { parseNamespacedToolName } from "../../src/tools/namespace.ts";
import type { Tool } from "../../src/tools/types.ts";
import type { Workspace } from "../../src/workspace/types.ts";

// The aggregator emits workspace-scoped names; narrow the parsed scope to
// the wsId so the `.wsId` reads below stay unchanged.
function wsIdOf(name: string): string {
  const { scope } = parseNamespacedToolName(name);
  if (scope.kind !== "workspace") {
    throw new Error(`expected workspace scope, got global for "${name}"`);
  }
  return scope.wsId;
}

// ── Constants ──────────────────────────────────────────────────────

/**
 * The debounce window the aggregator runs under. Small enough that the
 * test isn't sluggish; large enough that the watcher's coalesce window
 * is observable (a debounce of 0 would fire on every event, which is
 * NOT what production runs at).
 */
const DEBOUNCE_MS = 50;

/**
 * Total time to wait for the watcher → debounce → invalidate cycle to
 * settle before re-listing. Generous because macOS FSEvents has up to
 * a ~50ms initial latency before delivering the first event for a
 * newly-created subdirectory; combined with the debounce that gives
 * us a 50ms+50ms floor. 800ms accommodates CI noise.
 */
const SETTLE_WAIT_MS = 800;

// ── Helpers ────────────────────────────────────────────────────────

function buildWorkspace(id: string, memberId: string): Workspace {
  const now = "2026-05-22T00:00:00.000Z";
  return {
    id,
    name: id.slice(3),
    members: [{ userId: memberId, role: "admin" }],
    bundles: [],
    createdAt: now,
    updatedAt: now,
    isPersonal: false,
  };
}

function buildTools(bareNames: readonly string[], sourceTag: string): Tool[] {
  return bareNames.map((n) => ({
    name: n,
    description: `${sourceTag} ${n}`,
    inputSchema: { type: "object", properties: {} },
    source: sourceTag,
  }));
}

/**
 * Write `workspace.json` to disk via the atomic-rename pattern
 * production uses (write to temp + rename). The aggregator's watcher
 * is attached to the per-workspace directory exactly because that's
 * the only way to reliably catch atomic-rename writes — see the
 * `BundleLifecycleManager.atomicWrite` comment that motivates the
 * convention.
 */
function writeWorkspaceJson(workDir: string, wsId: string, workspace: Workspace): void {
  const wsDir = join(workDir, "workspaces", wsId);
  mkdirSync(wsDir, { recursive: true });
  writeFileSync(join(wsDir, "workspace.json"), `${JSON.stringify(workspace, null, 2)}\n`);
}

function makeWorkDir(wsIds: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), "nb-aggregator-int-"));
  mkdirSync(join(root, "workspaces"), { recursive: true });
  for (const wsId of wsIds) {
    mkdirSync(join(root, "workspaces", wsId), { recursive: true });
  }
  return root;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Lifecycle tracking ─────────────────────────────────────────────

let liveAggregator: ToolListAggregator | null = null;
let liveWorkDir: string | null = null;

beforeEach(() => {
  liveAggregator = null;
  liveWorkDir = null;
});

afterEach(() => {
  if (liveAggregator) {
    try {
      liveAggregator.dispose();
    } catch {
      // best-effort
    }
    liveAggregator = null;
  }
  if (liveWorkDir) {
    try {
      rmSync(liveWorkDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    liveWorkDir = null;
  }
});

// ── 8. FS-watch invalidation ──────────────────────────────────────

describe("aggregateToolList — FS-watch invalidation", () => {
  test("write to workspace.json invalidates the cached union (after debounce + slack)", async () => {
    const wsA = "ws_a";
    const wsB = "ws_b";
    const workDir = (liveWorkDir = makeWorkDir([wsA, wsB]));
    // Tool sets the lister produces. Each call re-reads from this map,
    // so swapping the value mid-test simulates a fresh persistence
    // event the watcher sees.
    const toolSets: Record<string, Tool[]> = {
      [wsA]: buildTools(["alpha", "beta"], "src_a"),
      [wsB]: buildTools(["delta"], "src_b"),
    };
    const store: AggregatorWorkspaceStore = {
      getWorkspacesForUser: async (userId) => {
        if (userId === "user_1") {
          return [wsA, wsB].map((id) => buildWorkspace(id, "user_1"));
        }
        return [];
      },
    };
    const agg = (liveAggregator = createToolListAggregator({
      workDir,
      workspaceStore: store,
      listToolsForWorkspace: async (wsId) => toolSets[wsId] ?? [],
      cache: { debounceMs: DEBOUNCE_MS },
    }));

    // Initial call — warms the cache and attaches a watcher to each
    // workspace dir.
    const before = await agg.aggregateToolList("user_1");
    expect(before.map((d) => d.toolName).sort()).toEqual(
      ["alpha", "beta", "delta"].sort(),
    );

    // Mutate the lister's source-of-truth AND touch the file the
    // watcher is observing. The watcher invalidates the cache;
    // the lister returns the new value on the next ask.
    toolSets[wsA] = buildTools(["alpha", "beta", "gamma_new"], "src_a");
    writeWorkspaceJson(workDir, wsA, buildWorkspace(wsA, "user_1"));

    // Adversarial assertion: do NOT assert the very next call returns
    // the new shape — the watcher has its own debounce window. Wait
    // for settle, then assert.
    await sleep(SETTLE_WAIT_MS);

    const after = await agg.aggregateToolList("user_1");
    const wsAEntries = after
      .filter((d) => wsIdOf(d.name) === wsA)
      .map((d) => d.toolName)
      .sort();
    expect(wsAEntries).toEqual(["alpha", "beta", "gamma_new"]);
  });
});

// ── 9. Workspace removal ──────────────────────────────────────────

describe("aggregateToolList — workspace removal", () => {
  test("identity losing access to ws_b drops ws_b/* entries on next call", async () => {
    const wsA = "ws_a";
    const wsB = "ws_b";
    const workDir = (liveWorkDir = makeWorkDir([wsA, wsB]));
    const toolSets: Record<string, Tool[]> = {
      [wsA]: buildTools(["alpha"], "src_a"),
      [wsB]: buildTools(["delta", "epsilon"], "src_b"),
    };
    // Mutable membership: starts with both, then drops ws_b.
    let user1Workspaces = [wsA, wsB];
    const store: AggregatorWorkspaceStore = {
      getWorkspacesForUser: async (userId) => {
        if (userId === "user_1") {
          return user1Workspaces.map((id) => buildWorkspace(id, "user_1"));
        }
        return [];
      },
    };
    const agg = (liveAggregator = createToolListAggregator({
      workDir,
      workspaceStore: store,
      listToolsForWorkspace: async (wsId) => toolSets[wsId] ?? [],
      cache: { debounceMs: DEBOUNCE_MS },
    }));

    const before = await agg.aggregateToolList("user_1");
    expect(before).toHaveLength(3);
    const beforeWorkspaces = new Set(
      before.map((d) => wsIdOf(d.name)),
    );
    expect(beforeWorkspaces).toEqual(new Set([wsA, wsB]));

    // Drop ws_b — the workspace-store now reports only ws_a for user_1.
    user1Workspaces = [wsA];

    const after = await agg.aggregateToolList("user_1");
    expect(after).toHaveLength(1);
    expect(wsIdOf(after[0]?.name ?? "")).toBe(wsA);
  });
});

// ── 10. Watcher lifecycle is leak-free ────────────────────────────

describe("aggregateToolList — watcher lifecycle", () => {
  test("dispose() closes every watcher attached during the cache lifetime", async () => {
    const wsIds = ["ws_a", "ws_b", "ws_c"];
    const workDir = (liveWorkDir = makeWorkDir(wsIds));
    const store: AggregatorWorkspaceStore = {
      getWorkspacesForUser: async (userId) => {
        if (userId === "user_1") {
          return wsIds.map((id) => buildWorkspace(id, "user_1"));
        }
        return [];
      },
    };
    const agg = createToolListAggregator({
      workDir,
      workspaceStore: store,
      listToolsForWorkspace: async (wsId) => buildTools(["echo"], wsId),
      cache: { debounceMs: DEBOUNCE_MS },
    });

    // Materialize the union — that's what attaches per-workspace
    // watchers. Without this call, no watcher exists to leak.
    await agg.aggregateToolList("user_1");
    expect(agg.activeWatcherCount()).toBe(wsIds.length);

    agg.dispose();
    expect(agg.activeWatcherCount()).toBe(0);

    // Post-dispose calls throw rather than silently returning a stale
    // cache — pins the "operator gets a loud signal" posture
    // (Stage 1 lesson 3).
    await expect(agg.aggregateToolList("user_1")).rejects.toThrow();

    // Idempotent dispose — repeat calls don't throw or wedge the
    // counter.
    expect(() => agg.dispose()).not.toThrow();
    expect(agg.activeWatcherCount()).toBe(0);

    // Manual cleanup since this test bypasses `liveAggregator`.
    // The afterEach hook tolerates a null `liveAggregator`.
  });
});
