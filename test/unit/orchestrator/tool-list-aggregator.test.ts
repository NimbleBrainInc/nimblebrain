/**
 * Unit tests for `src/orchestrator/tool-list-aggregator.ts`.
 *
 * Each case is mapped to the task spec's "Tests Required" list and
 * names the failure mode it pins:
 *
 *  1. Happy path — two workspaces, 3+2 tools, union of 5 with the
 *     namespacing primitive applied to every entry. Pins
 *     "aggregate is just the per-source list concatenated and renamed."
 *  2. Collision — both workspaces expose `crm.search`; the union has
 *     both, because namespacing makes them distinct. Pins the dedupe
 *     posture (we do NOT dedupe).
 *  3. Cache hit — second call without an FS event reuses the union.
 *     Pins the lazy-then-memoize shape. Spy on the lister; assert
 *     it was called exactly once per workspace.
 *  4. Perf-regression guard (Stage 1 lesson 5) — N=50 calls in a tight
 *     loop, lister called exactly once per workspace. A naive re-scan
 *     impl would call it 100×; this is the test that pins the bug.
 *  5. Concurrent enumeration — 5 workspaces each delaying `listTools`
 *     by 100ms; total wall time ~100ms (Promise.all), not 500ms.
 *  6. Per-identity isolation — two identities with disjoint workspace
 *     sets see disjoint tool lists. Pins "no cross-user cache
 *     pollution."
 *  7. Namespace primitive is the only constructor — the test file
 *     itself does NOT build `ws_X/Y` literals by hand; the assertion
 *     reads back the aggregator output and parses it via
 *     `parseNamespacedToolName`, never via string ops.
 *
 * Tests use a tmpdir workDir + a synthetic in-memory workspace store.
 * No `Runtime.start()`, no `Bun.serve()` — pure logic; lives in unit
 * tier per `CLAUDE.md` classification rule.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createToolListAggregator,
  type AggregatorWorkspaceStore,
  type WorkspaceToolLister,
} from "../../../src/orchestrator/tool-list-aggregator.ts";
import { parseNamespacedToolName } from "../../../src/tools/namespace.ts";
import type { Tool } from "../../../src/tools/types.ts";
import type { Workspace } from "../../../src/workspace/types.ts";

// The aggregator emits workspace-scoped names today; these tests assert
// workspace colocation. Narrow the parsed scope to `{ wsId, toolName }`
// so the `.wsId` / `.toolName` reads below stay unchanged. Throws if a
// name ever parses to identity scope (would be a real regression here).
function parseWs(name: string): { wsId: string; toolName: string } {
  const { scope, toolName } = parseNamespacedToolName(name);
  if (scope.kind !== "workspace") {
    throw new Error(`expected workspace scope, got global for "${name}"`);
  }
  return { wsId: scope.wsId, toolName };
}

// ── Fixtures ───────────────────────────────────────────────────────

/**
 * Build a minimal `Workspace` whose only load-bearing field is `id` +
 * (for `getWorkspacesForUser`) membership. The aggregator only reads
 * `.id`; the rest is shape-compliance for the typed return.
 */
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

/**
 * Synthetic workspace store: in-memory, no JSON files, no temp dir
 * traversal. Returns the recorded workspaces filtered by membership.
 * The aggregator only uses `getWorkspacesForUser`, so this is the
 * minimum surface.
 */
function buildStore(membership: Record<string, string[]>): AggregatorWorkspaceStore {
  const byUser = new Map<string, Workspace[]>();
  for (const [userId, wsIds] of Object.entries(membership)) {
    byUser.set(
      userId,
      wsIds.map((id) => buildWorkspace(id, userId)),
    );
  }
  return {
    getWorkspacesForUser: async (userId) => byUser.get(userId) ?? [],
  };
}

/**
 * Build a `Tool[]` from a list of bare tool names. The aggregator only
 * reads `name`, `description`, `inputSchema`, `annotations`, `execution`
 * — defaults for the rest.
 */
function buildTools(bareNames: readonly string[], sourceTag: string): Tool[] {
  return bareNames.map((n) => ({
    name: n,
    description: `${sourceTag} ${n}`,
    inputSchema: { type: "object", properties: {} },
    source: sourceTag,
  }));
}

/**
 * Spying lister wrapper: records every `(wsId, callIndex)` invocation
 * so tests can assert per-workspace call counts. The wrapped lister is
 * still asynchronous to keep concurrency semantics realistic.
 */
function spyingLister(impl: WorkspaceToolLister): {
  lister: WorkspaceToolLister;
  callCount: (wsId: string) => number;
  totalCalls: () => number;
} {
  const counts = new Map<string, number>();
  const lister: WorkspaceToolLister = async (wsId) => {
    counts.set(wsId, (counts.get(wsId) ?? 0) + 1);
    return impl(wsId);
  };
  return {
    lister,
    callCount: (wsId) => counts.get(wsId) ?? 0,
    totalCalls: () => [...counts.values()].reduce((a, b) => a + b, 0),
  };
}

/**
 * Make a workDir + a `workspaces/` subdir on it. The aggregator's
 * watcher attaches to the per-workspace subdirectory; the directory
 * must exist before `fs.watch` is called or the watcher fires an
 * `ENOENT` error.
 */
function makeWorkDir(wsIds: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), "nb-aggregator-unit-"));
  mkdirSync(join(root, "workspaces"), { recursive: true });
  for (const wsId of wsIds) {
    mkdirSync(join(root, "workspaces", wsId), { recursive: true });
  }
  return root;
}

// ── Cleanup tracker ────────────────────────────────────────────────

/**
 * Every test that creates an aggregator registers it here. The
 * `afterEach` hook disposes anything still alive — defense against a
 * test that throws before its own cleanup runs. Watcher leaks across
 * the suite were a Stage 1 failure mode (the index-cache carries the
 * same risk); the per-test tracker keeps us honest.
 */
const liveAggregators: Array<{ dispose: () => void }> = [];
const liveWorkDirs: string[] = [];
function track<T extends { dispose: () => void }>(a: T): T {
  liveAggregators.push(a);
  return a;
}
function trackDir(d: string): string {
  liveWorkDirs.push(d);
  return d;
}

afterEach(() => {
  while (liveAggregators.length > 0) {
    const a = liveAggregators.pop();
    if (a) {
      try {
        a.dispose();
      } catch {
        // best-effort
      }
    }
  }
  while (liveWorkDirs.length > 0) {
    const d = liveWorkDirs.pop();
    if (d) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  }
});

// ── 1. Happy path ──────────────────────────────────────────────────

describe("aggregateToolList — happy path", () => {
  test("two workspaces (3+2 tools) → union of 5 entries, each namespaced", async () => {
    const wsA = "ws_a";
    const wsB = "ws_b";
    const workDir = trackDir(makeWorkDir([wsA, wsB]));
    const toolsA = buildTools(["alpha", "beta", "gamma"], "src_a");
    const toolsB = buildTools(["delta", "epsilon"], "src_b");
    const { lister } = spyingLister(async (wsId) => {
      if (wsId === wsA) return toolsA;
      if (wsId === wsB) return toolsB;
      throw new Error(`unexpected wsId ${wsId}`);
    });
    const store = buildStore({ user_1: [wsA, wsB] });
    const agg = track(
      createToolListAggregator({
        workDir,
        workspaceStore: store,
        listToolsForWorkspace: lister,
      }),
    );

    const out = await agg.aggregateToolList("user_1");

    expect(out).toHaveLength(5);
    // Parse every entry back through the primitive — no hand-built
    // `ws_X/Y` literals in this test. Doubles as a contract check
    // that every aggregator entry IS a well-formed namespaced name.
    const parsed = out.map((d) => parseWs(d.name));
    const wsAEntries = parsed.filter((p) => p.wsId === wsA).map((p) => p.toolName);
    const wsBEntries = parsed.filter((p) => p.wsId === wsB).map((p) => p.toolName);
    expect(wsAEntries.sort()).toEqual(["alpha", "beta", "gamma"]);
    expect(wsBEntries.sort()).toEqual(["delta", "epsilon"]);
    // No duplicates in the union.
    const allNames = out.map((d) => d.name);
    expect(new Set(allNames).size).toBe(allNames.length);
  });
});

// ── 2. Collision ───────────────────────────────────────────────────

describe("aggregateToolList — collision across workspaces", () => {
  test("same bare name in two workspaces produces two distinct namespaced entries", async () => {
    const wsA = "ws_a";
    const wsB = "ws_b";
    const workDir = trackDir(makeWorkDir([wsA, wsB]));
    // Both workspaces expose `crm.search` — the namespace makes them
    // distinct. The naive "Set-by-bare-name" dedupe would drop one;
    // this case pins "we do NOT dedupe."
    const sameNameTool: Tool[] = [
      {
        name: "crm.search",
        description: "CRM search",
        inputSchema: { type: "object" },
        source: "crm",
      },
    ];
    const { lister } = spyingLister(async () => sameNameTool);
    const store = buildStore({ user_1: [wsA, wsB] });
    const agg = track(
      createToolListAggregator({
        workDir,
        workspaceStore: store,
        listToolsForWorkspace: lister,
      }),
    );

    const out = await agg.aggregateToolList("user_1");

    expect(out).toHaveLength(2);
    // Parse the names back to assert both colocations exist; the test
    // never constructs `ws_X/crm.search` itself.
    const parsed = out.map((d) => parseWs(d.name));
    const owners = parsed.map((p) => p.wsId).sort();
    expect(owners).toEqual([wsA, wsB]);
    // Each entry still carries its own `wsId` + bare `toolName`
    // bookkeeping so the orchestrator doesn't have to re-parse.
    expect(out.every((d) => d.toolName === "crm.search")).toBe(true);
  });
});

// ── 3. Cache hit ───────────────────────────────────────────────────

describe("aggregateToolList — cache hit", () => {
  test("second call without FS change reuses memoized union (lister fires once per workspace)", async () => {
    const wsA = "ws_a";
    const wsB = "ws_b";
    const workDir = trackDir(makeWorkDir([wsA, wsB]));
    const { lister, callCount, totalCalls } = spyingLister(async (wsId) =>
      buildTools(["one", "two"], wsId),
    );
    const store = buildStore({ user_1: [wsA, wsB] });
    const agg = track(
      createToolListAggregator({
        workDir,
        workspaceStore: store,
        listToolsForWorkspace: lister,
      }),
    );

    const first = await agg.aggregateToolList("user_1");
    const second = await agg.aggregateToolList("user_1");

    // Reference equality on the cached union — the same promise's
    // value flows through both calls, so the array is identical.
    expect(first).toBe(second);
    expect(callCount(wsA)).toBe(1);
    expect(callCount(wsB)).toBe(1);
    expect(totalCalls()).toBe(2);
  });
});

// ── 4. Perf-regression guard (Stage 1 lesson 5) ────────────────────

describe("aggregateToolList — perf-regression guard (lesson 5)", () => {
  test("N=50 calls invoke the per-workspace lister exactly once per workspace", async () => {
    const wsA = "ws_a";
    const wsB = "ws_b";
    const workDir = trackDir(makeWorkDir([wsA, wsB]));
    // The bug this test pins: a naive re-scan implementation would
    // call the lister 50× per workspace (100 total). The watcher-
    // backed cache calls it once per workspace (2 total). Without
    // this test, the regression would silently pass — the happy-
    // path test in case 1 would still go green.
    const { lister, totalCalls, callCount } = spyingLister(async (wsId) =>
      buildTools(["echo"], wsId),
    );
    const store = buildStore({ user_1: [wsA, wsB] });
    const agg = track(
      createToolListAggregator({
        workDir,
        workspaceStore: store,
        listToolsForWorkspace: lister,
      }),
    );

    for (let i = 0; i < 50; i++) {
      // No `await` interleaving with FS — pure cache reads after the
      // first call. If the cache were "lazy but per-call," each
      // iteration would re-list both workspaces.
      // biome-ignore lint/nursery/noAwaitInLoop: per-call ordering is the contract
      await agg.aggregateToolList("user_1");
    }

    expect(callCount(wsA)).toBe(1);
    expect(callCount(wsB)).toBe(1);
    // The cumulative assertion — the headline metric the audit
    // checks. A re-scan-per-call impl returns 100; the cache returns 2.
    expect(totalCalls()).toBe(2);
  });
});

// ── 5. Concurrent enumeration ─────────────────────────────────────

describe("aggregateToolList — concurrent enumeration", () => {
  test("5 workspaces each delaying 100ms list concurrently (~100ms total, not 500ms)", async () => {
    const wsIds = ["ws_a", "ws_b", "ws_c", "ws_d", "ws_e"];
    const workDir = trackDir(makeWorkDir(wsIds));
    const DELAY_MS = 100;
    const lister: WorkspaceToolLister = async (wsId) => {
      await new Promise((r) => setTimeout(r, DELAY_MS));
      return buildTools(["sole"], wsId);
    };
    const store = buildStore({ user_1: wsIds });
    const agg = track(
      createToolListAggregator({
        workDir,
        workspaceStore: store,
        listToolsForWorkspace: lister,
      }),
    );

    const t0 = Date.now();
    const out = await agg.aggregateToolList("user_1");
    const elapsed = Date.now() - t0;

    expect(out).toHaveLength(5);
    // Sequential listing would be ~500ms (5 × 100ms). Promise.all
    // brings it to ~100ms plus a small overhead. We accept up to
    // 300ms to keep the test stable under CI noise — well below
    // the 500ms threshold where the regression would show.
    expect(elapsed).toBeLessThan(300);
  });
});

// ── 6. Per-identity isolation ─────────────────────────────────────

describe("aggregateToolList — per-identity isolation", () => {
  test("two identities with disjoint workspace sets see disjoint tool lists", async () => {
    const wsA = "ws_a";
    const wsB = "ws_b";
    const workDir = trackDir(makeWorkDir([wsA, wsB]));
    const { lister } = spyingLister(async (wsId) =>
      buildTools([`tool_for_${wsId}`], wsId),
    );
    const store = buildStore({
      user_1: [wsA],
      user_2: [wsB],
    });
    const agg = track(
      createToolListAggregator({
        workDir,
        workspaceStore: store,
        listToolsForWorkspace: lister,
      }),
    );

    const outUser1 = await agg.aggregateToolList("user_1");
    const outUser2 = await agg.aggregateToolList("user_2");

    // Parse every entry through the primitive — verifies the
    // namespacing invariant + serves as the "no hand-built ws_X/Y"
    // assertion in the test itself.
    const user1Workspaces = outUser1.map((d) => parseWs(d.name).wsId);
    const user2Workspaces = outUser2.map((d) => parseWs(d.name).wsId);
    expect(new Set(user1Workspaces)).toEqual(new Set([wsA]));
    expect(new Set(user2Workspaces)).toEqual(new Set([wsB]));
    // user_1 must NOT see ws_b's tools and vice versa — pins the
    // "no cross-user cache pollution" audit criterion.
    expect(outUser1.some((d) => d.wsId === wsB)).toBe(false);
    expect(outUser2.some((d) => d.wsId === wsA)).toBe(false);
  });

  test("membership change drops the cached union for the affected identity", async () => {
    const wsA = "ws_a";
    const wsB = "ws_b";
    const workDir = trackDir(makeWorkDir([wsA, wsB]));
    const { lister } = spyingLister(async (wsId) =>
      buildTools([`tool_for_${wsId}`], wsId),
    );
    // Mutable store: user_1 starts with both workspaces, then loses ws_b.
    let user1Workspaces = [wsA, wsB];
    const store: AggregatorWorkspaceStore = {
      getWorkspacesForUser: async (userId) => {
        if (userId === "user_1") {
          return user1Workspaces.map((id) => buildWorkspace(id, "user_1"));
        }
        return [];
      },
    };
    const agg = track(
      createToolListAggregator({
        workDir,
        workspaceStore: store,
        listToolsForWorkspace: lister,
      }),
    );

    const before = await agg.aggregateToolList("user_1");
    expect(before).toHaveLength(2);

    // Drop ws_b from user_1's membership.
    user1Workspaces = [wsA];
    const after = await agg.aggregateToolList("user_1");
    expect(after).toHaveLength(1);
    expect(parseWs(after[0]?.name ?? "").wsId).toBe(wsA);
  });
});

// ── 7. Namespace primitive is the only constructor ────────────────

describe("aggregateToolList — namespacing primitive enforcement", () => {
  test("every aggregator output name parses cleanly via parseNamespacedToolName", async () => {
    // Defense-in-depth: even if a future contributor regresses the
    // aggregator to hand-build a `ws_X/Y` string, this test rejects
    // any output whose parsing throws. Combined with
    // `check:tool-namespace` (AST lint), the contract is enforced
    // at both the source and runtime layers.
    const wsId = "ws_helix";
    const workDir = trackDir(makeWorkDir([wsId]));
    const { lister } = spyingLister(async () =>
      buildTools(["alpha", "beta/with/slashes"], "src"),
    );
    const store = buildStore({ user_1: [wsId] });
    const agg = track(
      createToolListAggregator({
        workDir,
        workspaceStore: store,
        listToolsForWorkspace: lister,
      }),
    );

    const out = await agg.aggregateToolList("user_1");
    for (const d of out) {
      // Will throw `UnknownNamespacedToolName` on any malformed entry.
      const parsed = parseWs(d.name);
      expect(parsed.wsId).toBe(wsId);
      // Tool names containing `/` round-trip (primitive splits on
      // first slash) — pins the contract documented in
      // `src/tools/namespace.ts` design rule 3.
      expect(d.toolName).toBe(parsed.toolName);
    }
  });
});

describe("aggregateToolList — graceful degradation (one workspace fails)", () => {
  test("a rejecting workspace lister is skipped; the union keeps the healthy workspaces' tools", async () => {
    // Pins the S3 contract: `getUnionForIdentity` uses Promise.allSettled,
    // NOT Promise.all — a single workspace whose listing rejects (e.g. its
    // registry can't be constructed) must not nuke the identity's entire
    // tool list. Without this test a refactor back to all-or-nothing stays
    // green.
    const wsA = "ws_a";
    const wsBad = "ws_bad"; // lister rejects for this one
    const wsC = "ws_c";
    const workDir = trackDir(makeWorkDir([wsA, wsBad, wsC]));
    const toolsA = buildTools(["alpha", "beta"], "src_a");
    const toolsC = buildTools(["gamma"], "src_c");
    const lister: WorkspaceToolLister = async (wsId) => {
      if (wsId === wsA) return toolsA;
      if (wsId === wsC) return toolsC;
      throw new Error(`registry construction failed for ${wsId}`);
    };
    const store = buildStore({ user_1: [wsA, wsBad, wsC] });
    const agg = track(
      createToolListAggregator({
        workDir,
        workspaceStore: store,
        listToolsForWorkspace: lister,
      }),
    );

    const out = await agg.aggregateToolList("user_1");

    // The union did NOT reject; it returns exactly the healthy workspaces'
    // tools, and the failed workspace is absent.
    expect(out).toHaveLength(toolsA.length + toolsC.length);
    const owners = new Set(out.map((d) => parseWs(d.name).wsId));
    expect(owners).toEqual(new Set([wsA, wsC]));
    expect(out.some((d) => parseWs(d.name).wsId === wsBad)).toBe(false);
  });
});

// ── Reactive invalidation on source-readiness transitions ─────────
//
// Regression for the stale-union bug: a workspace's tool set can change
// WITHOUT `workspace.json` changing — a bundle subprocess (re)connecting after
// a slow boot or a HealthMonitor restart makes new tools enumerable. Before
// the fix the only invalidation channels were the `workspace.json` fs.watch +
// membership change, so a union memoized while a source was unreachable was
// served stale for the process lifetime. `invalidateWorkspace(wsId)` is the
// reactive channel `ToolRegistry.setInvalidationListener` drives.
describe("aggregateToolList — invalidateWorkspace re-lists after a source comes online", () => {
  test("union memoized while a bundle was unreachable refreshes after invalidateWorkspace", async () => {
    const wsId = "ws_shared";
    const workDir = trackDir(makeWorkDir([wsId]));
    // Simulate the prod sequence: at first the bundle subprocess isn't
    // connected, so the workspace lists only the platform `nb` tools; after it
    // comes online the same workspace lists nb + the bundle's tools.
    let bundleOnline = false;
    const { lister, callCount } = spyingLister(async () =>
      bundleOnline
        ? buildTools(["nb__search", "synapse_collateral__create_document"], "src")
        : buildTools(["nb__search"], "src"),
    );
    const store = buildStore({ user_1: [wsId] });
    const agg = track(
      createToolListAggregator({
        workDir,
        workspaceStore: store,
        listToolsForWorkspace: lister,
      }),
    );

    const before = await agg.aggregateToolList("user_1");
    expect(before.map((d) => parseWs(d.name).toolName)).toEqual(["nb__search"]);
    // Second call without any change is a cache hit — lister fired once.
    await agg.aggregateToolList("user_1");
    expect(callCount(wsId)).toBe(1);

    // The bundle subprocess finishes connecting and the registry fires its
    // readiness signal → aggregator.invalidateWorkspace(wsId).
    bundleOnline = true;
    agg.invalidateWorkspace(wsId);

    const after = await agg.aggregateToolList("user_1");
    expect(after.map((d) => parseWs(d.name).toolName)).toEqual([
      "nb__search",
      "synapse_collateral__create_document",
    ]);
    // Re-listed exactly once on invalidation (not on every call).
    expect(callCount(wsId)).toBe(2);
  });

  test("invalidateWorkspace is a no-op when nothing is cached for that workspace", async () => {
    const wsId = "ws_shared";
    const workDir = trackDir(makeWorkDir([wsId]));
    const { lister } = spyingLister(async () => buildTools(["nb__search"], "src"));
    const agg = track(
      createToolListAggregator({
        workDir,
        workspaceStore: buildStore({ user_1: [wsId] }),
        listToolsForWorkspace: lister,
      }),
    );
    // No aggregateToolList yet → nothing cached. Must not throw (covers the
    // boot-time `addSource` storm firing invalidations before any union exists).
    expect(() => agg.invalidateWorkspace(wsId)).not.toThrow();
    expect(() => agg.invalidateWorkspace("ws_never_seen")).not.toThrow();
  });
});

// ── Identity-descriptor memo must not stick on empty ──────────────
//
// The identity-side half of the stale-union bug: `getIdentityDescriptors`
// memoized its first result, clearing only on rejection. An empty read at
// boot (in-process identity sources not yet enumerable) stranded
// `files__read` & friends out of every session for the process lifetime.
// Kernel identity sources always exist, so an empty list is always transient.
describe("aggregateToolList — identity descriptors retry while empty, memoize when present", () => {
  test("an empty identity listing is not memoized; the next call picks up the tools", async () => {
    const wsId = "ws_a";
    const workDir = trackDir(makeWorkDir([wsId]));
    const { lister } = spyingLister(async () => buildTools(["ws_tool"], "src"));

    // First identity listing returns [] (sources not ready), then the real set.
    let identityReady = false;
    let identityCalls = 0;
    const agg = track(
      createToolListAggregator({
        workDir,
        workspaceStore: buildStore({ user_1: [wsId] }),
        listToolsForWorkspace: lister,
        listIdentityTools: async () => {
          identityCalls++;
          return identityReady ? buildTools(["files__read", "conversations__list"], "identity") : [];
        },
      }),
    );

    const before = await agg.aggregateToolList("user_1");
    // Only the workspace tool — identity prepend was empty.
    expect(before.map((d) => d.name)).toEqual([parseAny(before, "ws_tool")]);
    expect(before.some((d) => d.name === "files__read")).toBe(false);

    // Sources finish connecting.
    identityReady = true;
    const after = await agg.aggregateToolList("user_1");
    // Bare identity tools now prepend the union (no `ws_` prefix, wsId null).
    const bareNames = after.filter((d) => d.wsId === null).map((d) => d.name);
    expect(bareNames).toEqual(["files__read", "conversations__list"]);
    // Retried because the first result was empty — not stuck on the empty memo.
    expect(identityCalls).toBeGreaterThanOrEqual(2);
  });

  test("a non-empty identity listing is memoized (no re-list loop in steady state)", async () => {
    const wsId = "ws_a";
    const workDir = trackDir(makeWorkDir([wsId]));
    const { lister } = spyingLister(async () => buildTools(["ws_tool"], "src"));
    let identityCalls = 0;
    const agg = track(
      createToolListAggregator({
        workDir,
        workspaceStore: buildStore({ user_1: [wsId] }),
        listToolsForWorkspace: lister,
        listIdentityTools: async () => {
          identityCalls++;
          return buildTools(["files__read"], "identity");
        },
      }),
    );

    await agg.aggregateToolList("user_1");
    await agg.aggregateToolList("user_1");
    await agg.aggregateToolList("user_1");
    // Non-empty from the first call → memoized once, never re-listed.
    expect(identityCalls).toBe(1);
  });
});

// Helper: identity-descriptor test asserts a bare workspace tool's namespaced
// name without hand-building it.
function parseAny(out: readonly { name: string }[], bareToolName: string): string {
  const match = out.find((d) => d.name.endsWith(`-${bareToolName}`) || d.name === bareToolName);
  if (!match) throw new Error(`no aggregated entry for "${bareToolName}"`);
  return match.name;
}
