/**
 * Unit tests for `src/runtime/identity-tool-router.ts`.
 *
 * The router composes three primitives:
 *
 *   1. `ToolListAggregator.aggregateToolList(identityId)` — union surface.
 *   2. `routeToolCall(...)` — per-call workspace existence + membership.
 *   3. `runWithRequestContext(...)` — AsyncLocalStorage restamping.
 *
 * Each test names a failure mode a naive implementation might silently
 * mask. Stubs (aggregator, runtime, source) are tiny and synchronous —
 * no temp dir, no FS watcher, no real `WorkspaceStore`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { ToolCall, ToolResult } from "../../../src/engine/types.ts";
import { IdentityContext } from "../../../src/identity/context.ts";
import type { OrchestratorRuntime } from "../../../src/orchestrator/index.ts";
import type {
  IdentityToolRouterAggregator,
  WorkspaceDispatchHook,
} from "../../../src/runtime/identity-tool-router.ts";
import { IdentityToolRouter } from "../../../src/runtime/identity-tool-router.ts";
import {
  getRequestContext,
  type RequestContext,
  runWithRequestContext,
} from "../../../src/runtime/request-context.ts";
import { namespacedToolName } from "../../../src/tools/namespace.ts";
import type { Tool, ToolSource } from "../../../src/tools/types.ts";
import { WorkspaceContext } from "../../../src/workspace/context.ts";
import { personalWorkspaceIdFor } from "../../../src/workspace/workspace-store.ts";

// ── Stubs ─────────────────────────────────────────────────────────

interface SpyCall {
  toolName: string;
  input: Record<string, unknown>;
  /** RequestContext observed at dispatch time. Captured from AsyncLocalStorage. */
  context: RequestContext | undefined;
}

interface SpySource extends ToolSource {
  /** Calls observed at `execute(...)` time. */
  calls: SpyCall[];
  /** Last result returned. Overridable per test for error paths. */
  resultFor(input: Record<string, unknown>): ToolResult;
}

function makeSpySource(
  name: string,
  resultText = "ok",
  resultFn?: (input: Record<string, unknown>) => ToolResult,
): SpySource {
  const calls: SpyCall[] = [];
  return {
    name,
    calls,
    async start(): Promise<void> {},
    async stop(): Promise<void> {},
    async tools(): Promise<Tool[]> {
      return [];
    },
    resultFor:
      resultFn ??
      ((): ToolResult => ({
        content: [{ type: "text" as const, text: `[${name}] ${resultText}` }],
        isError: false,
      })),
    async execute(
      toolName: string,
      input: Record<string, unknown>,
    ): Promise<ToolResult> {
      calls.push({ toolName, input, context: getRequestContext() });
      return this.resultFor(input);
    },
  };
}

interface StubRuntimeOpts {
  registries: Map<string, ToolSource[]>;
  memberships: Map<string, string[]>;
  existingWorkspaces: Set<string>;
  workDir: string;
  identitySources?: Map<string, ToolSource>;
}

function makeStubRuntime(opts: StubRuntimeOpts): OrchestratorRuntime {
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
      return new WorkspaceContext({ wsId, workDir: opts.workDir });
    },
    getRegistryForWorkspace(wsId: string) {
      const sources = opts.registries.get(wsId) ?? [];
      return {
        getSource(name: string): ToolSource | undefined {
          return sources.find((s) => s.name === name);
        },
      };
    },
    getIdentitySource(name: string): ToolSource | undefined {
      return opts.identitySources?.get(name);
    },
    getIdentityContext(identityId: string): IdentityContext {
      return new IdentityContext({ userId: identityId, workDir: opts.workDir });
    },
  };
}

function makeStubAggregator(
  byIdentity: Map<string, Array<{ name: string; description: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown>; wsId: string | null; toolName: string }>>,
): IdentityToolRouterAggregator {
  return {
    async aggregateToolList(identityId: string) {
      return byIdentity.get(identityId) ?? [];
    },
    async aggregateScopedToolList(identityId: string, scopeWsIds: readonly string[]) {
      const scope = new Set(scopeWsIds);
      // Identity tools (wsId null) always included; workspace tools filtered to scope.
      return (byIdentity.get(identityId) ?? []).filter((d) => d.wsId === null || scope.has(d.wsId));
    },
  };
}

// ── Scaffolding ───────────────────────────────────────────────────

const SHARED_WS = "ws_helix";
const USER_ID = "u1";
const OTHER_USER = "u2";
const PERSONAL_WS = personalWorkspaceIdFor(USER_ID);

let workDir = "";
beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "nb-identity-tool-router-"));
});
afterEach(() => {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// ── Tests ─────────────────────────────────────────────────────────

describe("IdentityToolRouter — construction", () => {
  test("rejects an empty identityId", () => {
    const runtime = makeStubRuntime({
      registries: new Map(),
      memberships: new Map(),
      existingWorkspaces: new Set(),
      workDir,
    });
    const aggregator = makeStubAggregator(new Map());
    expect(
      () =>
        new IdentityToolRouter({
          identityId: "",
          runtime,
          aggregator,
        }),
    ).toThrow();
  });
});

describe("IdentityToolRouter — availableTools", () => {
  // Pins: the union returned to the engine is a narrowed ToolSchema[]. A naive
  // implementation might pass through the descriptor's extra fields, leaking
  // `wsId` / `toolName` / `execution` into the engine's `allToolSchemaMap` and
  // changing what the LLM sees.
  test("narrows aggregator descriptors to ToolSchema and preserves namespaced names", async () => {
    const aggregator = makeStubAggregator(
      new Map([
        [
          USER_ID,
          [
            {
              name: namespacedToolName(SHARED_WS, "crm__search"),
              description: "search crm",
              inputSchema: { type: "object", properties: {} },
              wsId: SHARED_WS,
              toolName: "crm__search",
              annotations: { ui: "card" } as Record<string, unknown>,
            },
            {
              name: "conversations__list",
              description: "list",
              inputSchema: { type: "object", properties: {} },
              wsId: null,
              toolName: "conversations__list",
            },
          ],
        ],
      ]),
    );
    const router = new IdentityToolRouter({
      identityId: USER_ID,
      runtime: makeStubRuntime({
        registries: new Map(),
        memberships: new Map(),
        existingWorkspaces: new Set(),
        workDir,
      }),
      aggregator,
    });

    const tools = await router.availableTools();

    expect(tools).toHaveLength(2);
    expect(tools[0]).toEqual({
      name: `${SHARED_WS}-crm__search`,
      description: "search crm",
      inputSchema: { type: "object", properties: {} },
      annotations: { ui: "card" },
    });
    // The bare identity-source name is preserved verbatim.
    expect(tools[1]?.name).toBe("conversations__list");
    // No leaked descriptor-only fields. The engine never reads these, but
    // exposing them couples the router to descriptor evolution.
    for (const t of tools) {
      expect((t as Record<string, unknown>).wsId).toBeUndefined();
      expect((t as Record<string, unknown>).toolName).toBeUndefined();
      expect((t as Record<string, unknown>).execution).toBeUndefined();
    }
  });

  test("queries the aggregator with the constructor-captured identityId, not an ambient one", async () => {
    // Naive failure: the router reads identity from the request context at
    // execute time. That would defeat the construction-time trust capture.
    const calls: string[] = [];
    const aggregator: IdentityToolRouterAggregator = {
      async aggregateToolList(id: string) {
        calls.push(id);
        return [];
      },
    };
    const router = new IdentityToolRouter({
      identityId: USER_ID,
      runtime: makeStubRuntime({
        registries: new Map(),
        memberships: new Map(),
        existingWorkspaces: new Set(),
        workDir,
      }),
      aggregator,
    });

    await runWithRequestContext(
      {
        // A different identity sits in AsyncLocalStorage. The router must
        // ignore it — it must query for USER_ID, the captured identity.
        identity: { id: OTHER_USER, email: "other@x", emailVerified: true, orgRole: null },
        scope: { kind: "identity" },
      },
      async () => {
        await router.availableTools();
      },
    );

    expect(calls).toEqual([USER_ID]);
  });
});

describe("IdentityToolRouter — execute (workspace door)", () => {
  // Pins: a `ws_<id>-<source>__<tool>` call routes to that workspace's
  // source via the orchestrator's membership check, and the source's
  // `execute` sees the bare local tool name (no source prefix). Naive
  // failure: pass `routed.toolName` straight through, leaving `crm__search`
  // and breaking every source whose execute switches on bare names.
  test("dispatches the bare local tool name to the routed workspace's source", async () => {
    const crm = makeSpySource("crm");
    const runtime = makeStubRuntime({
      registries: new Map([[SHARED_WS, [crm]]]),
      memberships: new Map([[USER_ID, [SHARED_WS]]]),
      existingWorkspaces: new Set([SHARED_WS]),
      workDir,
    });
    const aggregator = makeStubAggregator(new Map());
    const router = new IdentityToolRouter({ identityId: USER_ID, runtime, aggregator });

    const call: ToolCall = {
      id: "c1",
      name: `${SHARED_WS}-crm__search`,
      input: { q: "acme" },
    };
    const result = await router.execute(call);

    expect(result.isError).toBe(false);
    expect(crm.calls).toHaveLength(1);
    expect(crm.calls[0]?.toolName).toBe("search");
    expect(crm.calls[0]?.input).toEqual({ q: "acme" });
  });

  // Pins: the per-call RequestContext carries the ROUTED workspace id, not
  // an ambient one. Without this, `nb__*` handlers that read
  // `requireWorkspaceId()` would see the chat session's focused workspace
  // on a cross-workspace dispatch — the exact failure mode the orchestrator
  // exists to prevent.
  test("restamps RequestContext.scope.workspaceId to the routed workspace, even with a different ambient workspace", async () => {
    const crm = makeSpySource("crm");
    const runtime = makeStubRuntime({
      registries: new Map([[SHARED_WS, [crm]]]),
      memberships: new Map([[USER_ID, [SHARED_WS, PERSONAL_WS]]]),
      existingWorkspaces: new Set([SHARED_WS, PERSONAL_WS]),
      workDir,
    });
    const router = new IdentityToolRouter({
      identityId: USER_ID,
      runtime,
      aggregator: makeStubAggregator(new Map()),
    });

    // Outer scope says PERSONAL_WS; the call routes to SHARED_WS. The
    // source must observe SHARED_WS on its RequestContext.
    await runWithRequestContext(
      {
        identity: { id: USER_ID, email: "u1@x", emailVerified: true, orgRole: null },
        scope: {
          kind: "workspace",
          workspaceId: PERSONAL_WS,
          workspaceAgents: null,
          workspaceModelOverride: null,
        },
      },
      async () => {
        await router.execute({
          id: "c1",
          name: `${SHARED_WS}-crm__search`,
          input: {},
        });
      },
    );

    expect(crm.calls).toHaveLength(1);
    const ctx = crm.calls[0]?.context;
    expect(ctx).toBeDefined();
    expect(ctx?.scope.kind).toBe("workspace");
    if (ctx?.scope.kind !== "workspace") throw new Error("scope kind mismatch");
    expect(ctx.scope.workspaceId).toBe(SHARED_WS);
  });

  test("fires onWorkspaceDispatch with the routed wsId BEFORE source.execute observes a context", async () => {
    const hookEvents: Array<{ callId: string; wsId: string; sourceCallCount: number }> = [];
    const crm = makeSpySource("crm");
    const runtime = makeStubRuntime({
      registries: new Map([[SHARED_WS, [crm]]]),
      memberships: new Map([[USER_ID, [SHARED_WS]]]),
      existingWorkspaces: new Set([SHARED_WS]),
      workDir,
    });
    const hook: WorkspaceDispatchHook = (callId, wsId) => {
      hookEvents.push({ callId, wsId, sourceCallCount: crm.calls.length });
    };
    const router = new IdentityToolRouter({
      identityId: USER_ID,
      runtime,
      aggregator: makeStubAggregator(new Map()),
      onWorkspaceDispatch: hook,
    });

    await router.execute({ id: "c1", name: `${SHARED_WS}-crm__search`, input: {} });

    expect(hookEvents).toHaveLength(1);
    expect(hookEvents[0]?.callId).toBe("c1");
    expect(hookEvents[0]?.wsId).toBe(SHARED_WS);
    // Hook fires BEFORE source.execute — audit attribution must be live the
    // moment any tool.progress event from a task-augmented call could fire.
    expect(hookEvents[0]?.sourceCallCount).toBe(0);
  });
});

describe("IdentityToolRouter — execute (identity door)", () => {
  test("routes a bare <identity-source>__<tool> to the identity source with an identity-scoped RequestContext", async () => {
    const conversations = makeSpySource("conversations");
    const runtime = makeStubRuntime({
      registries: new Map(),
      memberships: new Map([[USER_ID, []]]),
      existingWorkspaces: new Set(),
      workDir,
      identitySources: new Map([["conversations", conversations]]),
    });
    const router = new IdentityToolRouter({
      identityId: USER_ID,
      runtime,
      aggregator: makeStubAggregator(new Map()),
    });

    await router.execute({ id: "c1", name: "conversations__list", input: {} });

    expect(conversations.calls).toHaveLength(1);
    expect(conversations.calls[0]?.toolName).toBe("list");
    const ctx = conversations.calls[0]?.context;
    expect(ctx?.scope.kind).toBe("identity");
  });

  test("does NOT fire onWorkspaceDispatch for identity-routed calls (no workspace to stamp)", async () => {
    const hookEvents: string[] = [];
    const conversations = makeSpySource("conversations");
    const runtime = makeStubRuntime({
      registries: new Map(),
      memberships: new Map([[USER_ID, []]]),
      existingWorkspaces: new Set(),
      workDir,
      identitySources: new Map([["conversations", conversations]]),
    });
    const router = new IdentityToolRouter({
      identityId: USER_ID,
      runtime,
      aggregator: makeStubAggregator(new Map()),
      onWorkspaceDispatch: (callId) => hookEvents.push(callId),
    });

    await router.execute({ id: "c1", name: "conversations__list", input: {} });

    expect(hookEvents).toEqual([]);
  });
});

describe("IdentityToolRouter — orchestrator errors", () => {
  // Pins: orchestrator errors surface as `isError: true` tool results
  // with structured `reason` payloads, NOT thrown engine errors. A naive
  // implementation might throw — the engine maps thrown errors to
  // `run.error`, which is the wrong shape for "your tool name didn't route."
  test("WorkspaceAccessDenied → isError:true with reason workspace_access_denied", async () => {
    // Identity has no membership of SHARED_WS; the orchestrator throws.
    const runtime = makeStubRuntime({
      registries: new Map([[SHARED_WS, [makeSpySource("crm")]]]),
      memberships: new Map([[USER_ID, []]]),
      existingWorkspaces: new Set([SHARED_WS]),
      workDir,
    });
    const router = new IdentityToolRouter({
      identityId: USER_ID,
      runtime,
      aggregator: makeStubAggregator(new Map()),
    });

    const result = await router.execute({
      id: "c1",
      name: `${SHARED_WS}-crm__search`,
      input: {},
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: "orchestrator_error",
      reason: "workspace_access_denied",
      identityId: USER_ID,
      wsId: SHARED_WS,
    });
  });

  test("UnknownWorkspace → isError:true with reason unknown_workspace; onWorkspaceDispatch never fires", async () => {
    const hookEvents: string[] = [];
    const runtime = makeStubRuntime({
      registries: new Map(),
      memberships: new Map([[USER_ID, []]]),
      existingWorkspaces: new Set(), // SHARED_WS is unknown
      workDir,
    });
    const router = new IdentityToolRouter({
      identityId: USER_ID,
      runtime,
      aggregator: makeStubAggregator(new Map()),
      onWorkspaceDispatch: (callId) => hookEvents.push(callId),
    });

    const result = await router.execute({
      id: "c1",
      name: `${SHARED_WS}-crm__search`,
      input: {},
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ reason: "unknown_workspace" });
    expect(hookEvents).toEqual([]);
  });

  test("invalid namespaced input → isError:true with reason invalid_tool_name", async () => {
    const runtime = makeStubRuntime({
      registries: new Map(),
      memberships: new Map([[USER_ID, []]]),
      existingWorkspaces: new Set(),
      workDir,
    });
    const router = new IdentityToolRouter({
      identityId: USER_ID,
      runtime,
      aggregator: makeStubAggregator(new Map()),
    });

    const result = await router.execute({
      id: "c1",
      // No `__` — fails the bare-name source split before reaching workspace logic.
      name: "ws_helix-noprefixhere",
      input: {},
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: "orchestrator_error" });
  });
});

describe("IdentityToolRouter — workspace lockdown (allowedWsIds)", () => {
  const OTHER_WS = "ws_other";

  test("availableTools uses the scoped path — out-of-scope workspace tools excluded, identity tools kept", async () => {
    const aggregator = makeStubAggregator(
      new Map([
        [
          USER_ID,
          [
            {
              name: namespacedToolName(SHARED_WS, "crm__search"),
              description: "d",
              inputSchema: { type: "object", properties: {} },
              wsId: SHARED_WS,
              toolName: "crm__search",
            },
            {
              name: namespacedToolName(OTHER_WS, "x__run"),
              description: "d",
              inputSchema: { type: "object", properties: {} },
              wsId: OTHER_WS,
              toolName: "x__run",
            },
            {
              name: "conversations__list",
              description: "d",
              inputSchema: { type: "object", properties: {} },
              wsId: null,
              toolName: "conversations__list",
            },
          ],
        ],
      ]),
    );
    const router = new IdentityToolRouter({
      identityId: USER_ID,
      runtime: makeStubRuntime({
        registries: new Map(),
        memberships: new Map(),
        existingWorkspaces: new Set(),
        workDir,
      }),
      aggregator,
      allowedWsIds: [SHARED_WS, PERSONAL_WS], // OTHER_WS is not focused
    });

    const names = (await router.availableTools()).map((t) => t.name);
    expect(names).toContain(`${SHARED_WS}-crm__search`);
    expect(names).toContain("conversations__list"); // identity tools always reachable
    expect(names).not.toContain(`${OTHER_WS}-x__run`); // out-of-scope → excluded
  });

  test("execute denies a directly-named out-of-scope tool even when the caller is a member (focus gate)", async () => {
    const otherSource = makeSpySource("x");
    const runtime = makeStubRuntime({
      registries: new Map([[OTHER_WS, [otherSource]]]),
      // The user IS a member of OTHER_WS — only the focus gate stops the call.
      memberships: new Map([[USER_ID, [SHARED_WS, PERSONAL_WS, OTHER_WS]]]),
      existingWorkspaces: new Set([SHARED_WS, PERSONAL_WS, OTHER_WS]),
      workDir,
    });
    const router = new IdentityToolRouter({
      identityId: USER_ID,
      runtime,
      aggregator: makeStubAggregator(new Map()),
      allowedWsIds: [SHARED_WS, PERSONAL_WS], // OTHER_WS not in scope
    });

    const res = await router.execute({ id: "c1", name: `${OTHER_WS}-x__run`, input: {} });
    expect(res.isError).toBe(true); // WorkspaceAccessDenied → mapped to an error result
    expect(otherSource.calls).toHaveLength(0); // the out-of-scope source never ran
  });
});
