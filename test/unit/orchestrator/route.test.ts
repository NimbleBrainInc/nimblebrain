/**
 * Unit tests for `src/orchestrator/route.ts`.
 *
 * Pins the per-call workspace routing contract for Stage 2 of the
 * cross-workspace refactor. Each test names the failure mode a naive
 * implementation might silently mask — matching the
 * `004-orchestrator-skeleton.md` "Tests Required" list 1:1.
 *
 * Test surface is structural: a stub `OrchestratorRuntime` is built
 * per case, exercising the orchestrator without booting a real
 * `Runtime` or hitting the filesystem. The stub mirrors the
 * production runtime's three accessors (workspace store, workspace
 * context factory, per-workspace registry).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  GlobalScopeNotRoutable,
  routeToolCall,
  UnknownToolSource,
  UnknownWorkspace,
  WorkspaceAccessDenied,
  type OrchestratorRuntime,
} from "../../../src/orchestrator/index.ts";
import type { Tool, ToolSource } from "../../../src/tools/types.ts";
import type { ToolResult } from "../../../src/engine/types.ts";
import { WorkspaceContext } from "../../../src/workspace/context.ts";
import { personalWorkspaceIdFor } from "../../../src/workspace/workspace-store.ts";

// ── Stub source ───────────────────────────────────────────────────

/**
 * Minimal `ToolSource` that returns its constructor name on dispatch.
 * The orchestrator's tests never call `execute` — they assert which
 * source instance was returned — but the source still has to satisfy
 * the structural contract so TS accepts it.
 */
function makeStubSource(name: string): ToolSource {
  return {
    name,
    async start(): Promise<void> {},
    async stop(): Promise<void> {},
    async tools(): Promise<Tool[]> {
      return [];
    },
    async execute(): Promise<ToolResult> {
      return { content: [{ type: "text" as const, text: `[${name}] dispatched` }] };
    },
  };
}

// ── Stub runtime ──────────────────────────────────────────────────

interface StubRuntimeOpts {
  /** Map of wsId → list of source instances registered in that workspace. */
  registries: Map<string, ToolSource[]>;
  /** Map of userId → list of wsIds the identity belongs to. */
  memberships: Map<string, string[]>;
  /** Set of wsIds known to the store. */
  existingWorkspaces: Set<string>;
  /** Working directory passed to constructed `WorkspaceContext` instances. */
  workDir: string;
}

interface StubRuntime extends OrchestratorRuntime {
  /** How many times `getWorkspaceContext` has been called — used to assert per-call freshness. */
  contextCallCount(): number;
  /** Every `WorkspaceContext` returned, in call order — used to assert non-aliasing. */
  emittedContexts(): WorkspaceContext[];
}

function makeStubRuntime(opts: StubRuntimeOpts): StubRuntime {
  const emitted: WorkspaceContext[] = [];

  return {
    getWorkspaceStore() {
      return {
        async get(wsId: string) {
          return opts.existingWorkspaces.has(wsId) ? { id: wsId } : null;
        },
        async getWorkspacesForUser(userId: string) {
          const ids = opts.memberships.get(userId) ?? [];
          return ids.map((id) => ({ id }));
        },
      };
    },
    getWorkspaceContext(wsId: string) {
      // Production behavior: fresh instance per call. The cache-
      // isolation test relies on this. Construct directly rather than
      // through any cache.
      const ctx = new WorkspaceContext({ wsId, workDir: opts.workDir });
      emitted.push(ctx);
      return ctx;
    },
    getRegistryForWorkspace(wsId: string) {
      const sources = opts.registries.get(wsId) ?? [];
      return {
        getSource(name: string): ToolSource | undefined {
          return sources.find((s) => s.name === name);
        },
      };
    },
    contextCallCount() {
      return emitted.length;
    },
    emittedContexts() {
      return emitted;
    },
  };
}

// ── Test scaffolding ──────────────────────────────────────────────

const SHARED_WS = "ws_helix";
const USER_ID = "u1";
const PERSONAL_WS = personalWorkspaceIdFor(USER_ID); // ws_user_u1

let workDir = "";

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "nb-orchestrator-route-"));
});

afterEach(() => {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

function buildHappyRuntime(): StubRuntime {
  return makeStubRuntime({
    registries: new Map([
      [SHARED_WS, [makeStubSource("crm")]],
      [PERSONAL_WS, [makeStubSource("gmail")]],
    ]),
    memberships: new Map([[USER_ID, [SHARED_WS, PERSONAL_WS]]]),
    existingWorkspaces: new Set([SHARED_WS, PERSONAL_WS]),
    workDir,
  });
}

// ── Tests ─────────────────────────────────────────────────────────

describe("routeToolCall — happy path", () => {
  // Pins: "routing flows end-to-end and produces a context whose
  // wsId matches the parsed namespace." Naive failure: orchestrator
  // hard-codes a workspace or reads from ambient state, returning a
  // context that doesn't match the input.
  test("returns a context whose wsId === parsed wsId and toolName stripped of prefix", async () => {
    const runtime = buildHappyRuntime();

    const routed = await routeToolCall({
      identityId: USER_ID,
      namespacedName: `${SHARED_WS}-crm__search`,
      runtime,
    });

    expect(routed.context.workspaceId).toBe(SHARED_WS);
    expect(routed.toolName).toBe("crm__search");
    expect(routed.source.name).toBe("crm");
  });
});

describe("routeToolCall — strict invariant (Stage 1 lesson 3)", () => {
  // Pins: un-namespaced names MUST throw rather than silently fall
  // back to "the user's personal workspace." A defensive default
  // would mask the failure mode where the LLM emits a bare tool
  // name and the call lands somewhere unintended.
  test("bare name routes to global (not the personal workspace) — fails closed pre-W3, builds no workspace context", async () => {
    const runtime = buildHappyRuntime();

    let thrown: unknown = null;
    try {
      await routeToolCall({
        identityId: USER_ID,
        namespacedName: "crm__search",
        runtime,
      });
    } catch (err) {
      thrown = err;
    }
    // Bare name → global scope. Until W3 wires global dispatch this fails
    // closed via GlobalScopeNotRoutable. The load-bearing invariant holds
    // either way: a bare name is NEVER silently routed to the personal
    // workspace — no WorkspaceContext is constructed.
    expect(thrown).toBeInstanceOf(GlobalScopeNotRoutable);
    expect(runtime.contextCallCount()).toBe(0);
  });
});

describe("routeToolCall — authorization fails loud", () => {
  // Pins: identity whose workspaces don't include the target throws
  // WorkspaceAccessDenied. Naive failure: returning a context anyway
  // (membership not checked) — bypassing the workspace isolation
  // invariant.
  test("non-member identity throws WorkspaceAccessDenied — does NOT return a context", async () => {
    const runtime = makeStubRuntime({
      registries: new Map([[SHARED_WS, [makeStubSource("crm")]]]),
      // u1's only workspace is the personal one; SHARED_WS is NOT in the list.
      memberships: new Map([[USER_ID, [PERSONAL_WS]]]),
      existingWorkspaces: new Set([SHARED_WS, PERSONAL_WS]),
      workDir,
    });

    let thrown: unknown = null;
    try {
      await routeToolCall({
        identityId: USER_ID,
        namespacedName: `${SHARED_WS}-crm__search`,
        runtime,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WorkspaceAccessDenied);
    expect((thrown as WorkspaceAccessDenied).identityId).toBe(USER_ID);
    expect((thrown as WorkspaceAccessDenied).wsId).toBe(SHARED_WS);
    // No context constructed — the error fires before step 4.
    expect(runtime.contextCallCount()).toBe(0);
  });
});

describe("routeToolCall — personal workspace authorization", () => {
  // Pins: identity calling its OWN personal workspace succeeds.
  // The wsId is derived via `personalWorkspaceIdFor(userId)` to
  // guard against hand-built `ws_user_<id>` forms that drift from
  // the canonical helper.
  test("identity u1 calling ws_user_u1/... succeeds (wsId from personalWorkspaceIdFor)", async () => {
    const runtime = buildHappyRuntime();

    const routed = await routeToolCall({
      identityId: USER_ID,
      namespacedName: `${PERSONAL_WS}-gmail__send`,
      runtime,
    });

    expect(routed.context.workspaceId).toBe(PERSONAL_WS);
    expect(routed.toolName).toBe("gmail__send");
    expect(routed.source.name).toBe("gmail");
  });
});

describe("routeToolCall — context isolation (Stage 1 lesson 1)", () => {
  // Pins: two consecutive routes for different wsIds return
  // distinct `WorkspaceContext` instances with distinct `getRoot()`s.
  // Naive failure: a cache keyed only on the first wsId returns the
  // first context for both calls — cross-tenant aliasing.
  test("two consecutive routes return non-aliased contexts whose getRoot() differ", async () => {
    const runtime = buildHappyRuntime();

    const first = await routeToolCall({
      identityId: USER_ID,
      namespacedName: `${SHARED_WS}-crm__search`,
      runtime,
    });
    const second = await routeToolCall({
      identityId: USER_ID,
      namespacedName: `${PERSONAL_WS}-gmail__send`,
      runtime,
    });

    // Identity-distinct (different object).
    expect(first.context).not.toBe(second.context);
    // Root paths differ (the load-bearing assertion — a single
    // cached context that ignored the second wsId would return
    // identical roots).
    expect(first.context.getRoot()).not.toBe(second.context.getRoot());
    expect(first.context.workspaceId).toBe(SHARED_WS);
    expect(second.context.workspaceId).toBe(PERSONAL_WS);
    // Two calls, two distinct emissions — the orchestrator never
    // reuses an existing context across wsIds.
    expect(runtime.contextCallCount()).toBe(2);
  });
});

describe("routeToolCall — no ambient state", () => {
  // Pins: routing succeeds without any "current workspace" pointer.
  // The orchestrator must derive wsId from the parsed namespace
  // alone, not from `runtime.requireWorkspaceId()` or
  // `getCurrentWorkspaceId()`. Our stub doesn't even expose those
  // accessors — if the orchestrator reached for them this test
  // would surface a type error or a runtime crash.
  test("orchestrator does not read any ambient 'current workspace' — routing succeeds with no such state", async () => {
    const runtime = buildHappyRuntime();
    // No setup needed beyond the bare stub. The stub deliberately
    // omits `requireWorkspaceId` / `getCurrentWorkspaceId`. If the
    // orchestrator ever depends on them, this test breaks first.

    const routed = await routeToolCall({
      identityId: USER_ID,
      namespacedName: `${SHARED_WS}-crm__search`,
      runtime,
    });

    expect(routed.context.workspaceId).toBe(SHARED_WS);
  });
});

describe("routeToolCall — unknown workspace", () => {
  // Pins: `ws_doesnotexist/foo` throws `UnknownWorkspace`,
  // distinct from `WorkspaceAccessDenied`. The two are conflated
  // dangerously easy ("any unknown / inaccessible workspace → 403")
  // — operators need them split to triage cross-tenant accidents
  // (workspace bogus) from permissions misconfiguration (workspace
  // exists, identity not a member).
  test("ws_doesnotexist throws UnknownWorkspace, NOT WorkspaceAccessDenied", async () => {
    const runtime = makeStubRuntime({
      registries: new Map(),
      memberships: new Map([[USER_ID, [SHARED_WS, PERSONAL_WS]]]),
      existingWorkspaces: new Set([SHARED_WS, PERSONAL_WS]),
      workDir,
    });

    let thrown: unknown = null;
    try {
      await routeToolCall({
        identityId: USER_ID,
        namespacedName: "ws_doesnotexist-foo__bar",
        runtime,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(UnknownWorkspace);
    // Critical: NOT a WorkspaceAccessDenied — the distinction is the
    // whole point of the separate error class.
    expect(thrown).not.toBeInstanceOf(WorkspaceAccessDenied);
    expect((thrown as UnknownWorkspace).wsId).toBe("ws_doesnotexist");
  });
});

// ── Bonus: source-not-registered surfaces UnknownToolSource ──────
//
// Not in the task spec's "Tests Required" list, but the orchestrator
// returns a typed `source` and the failure mode (a tool name whose
// source prefix isn't installed in the workspace) needs a structured
// error rather than a bare `Error`. Documented as a fourth distinct
// error class in the task report; tested here to keep its contract
// from drifting.

describe("routeToolCall — unknown tool source", () => {
  test("source not registered in workspace registry throws UnknownToolSource", async () => {
    const runtime = makeStubRuntime({
      // SHARED_WS exists and identity belongs, but no `crm` source
      // is registered.
      registries: new Map([[SHARED_WS, []]]),
      memberships: new Map([[USER_ID, [SHARED_WS]]]),
      existingWorkspaces: new Set([SHARED_WS]),
      workDir,
    });

    let thrown: unknown = null;
    try {
      await routeToolCall({
        identityId: USER_ID,
        namespacedName: `${SHARED_WS}-crm__search`,
        runtime,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UnknownToolSource);
    expect((thrown as UnknownToolSource).wsId).toBe(SHARED_WS);
    expect((thrown as UnknownToolSource).sourceName).toBe("crm");
  });
});
