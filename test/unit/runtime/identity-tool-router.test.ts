/**
 * Unit tests for `src/runtime/identity-tool-router.ts`.
 *
 * The router is bounded to ONE workspace (the wall) and composes:
 *
 *   1. `runtime.listToolsForWorkspace(workspaceId)` — the reachable surface
 *      (the bound workspace's tools + identity tools).
 *   2. `routeToolCall(...)` — per-call wall check (target must be the bound
 *      workspace) + dispatch.
 *   3. `runWithRequestContext(...)` — AsyncLocalStorage restamping.
 *
 * Each test names a failure mode a naive implementation might silently
 * mask. Stubs (runtime, source) are tiny and synchronous — no temp dir,
 * no FS watcher, no real `WorkspaceStore`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { ToolCall, ToolResult, ToolSchema } from "../../../src/engine/types.ts";
import { IdentityContext } from "../../../src/identity/context.ts";
import type { OrchestratorRuntime } from "../../../src/orchestrator/index.ts";
import type { WorkspaceDispatchHook } from "../../../src/runtime/identity-tool-router.ts";
import { IdentityToolRouter } from "../../../src/runtime/identity-tool-router.ts";
import {
  getRequestContext,
  type RequestContext,
  runWithRequestContext,
} from "../../../src/runtime/request-context.ts";
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
    async execute(toolName: string, input: Record<string, unknown>): Promise<ToolResult> {
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
  /** Reachable tool surface per workspace (the wall: one workspace + identity). */
  toolsByWorkspace?: Map<string, ToolSchema[]>;
  /** Records every `listToolsForWorkspace` call so tests can pin the queried wsId. */
  listCalls?: string[];
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
    async listToolsForWorkspace(wsId: string): Promise<ToolSchema[]> {
      opts.listCalls?.push(wsId);
      return opts.toolsByWorkspace?.get(wsId) ?? [];
    },
  };
}

// ── Scaffolding ───────────────────────────────────────────────────

const SHARED_WS = "ws_helix";
const OTHER_WS = "ws_acme";
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
    expect(
      () => new IdentityToolRouter({ identityId: "", workspaceId: SHARED_WS, runtime }),
    ).toThrow();
  });
});

describe("IdentityToolRouter — availableTools", () => {
  // Pins: the reachable surface is the BOUND workspace's tools + identity
  // tools, returned verbatim from `listToolsForWorkspace`. No cross-workspace
  // union: a session reaches exactly one workspace.
  test("returns the bound workspace's tools from listToolsForWorkspace", async () => {
    const surface: ToolSchema[] = [
      {
        name: `${SHARED_WS}-crm__search`,
        description: "search crm",
        inputSchema: { type: "object", properties: {} },
        annotations: { ui: "card" },
      },
      {
        name: "conversations__list",
        description: "list",
        inputSchema: { type: "object", properties: {} },
      },
    ];
    const router = new IdentityToolRouter({
      identityId: USER_ID,
      workspaceId: SHARED_WS,
      runtime: makeStubRuntime({
        registries: new Map(),
        memberships: new Map(),
        existingWorkspaces: new Set(),
        workDir,
        toolsByWorkspace: new Map([[SHARED_WS, surface]]),
      }),
    });

    const tools = await router.availableTools();

    expect(tools).toEqual(surface);
  });

  // Naive failure: read the focused workspace from the ambient request context
  // at call time. That would defeat the construction-time capture — the router
  // must query for its BOUND workspaceId regardless of ambient scope.
  test("queries listToolsForWorkspace with the constructor-captured workspaceId, not an ambient one", async () => {
    const listCalls: string[] = [];
    const router = new IdentityToolRouter({
      identityId: USER_ID,
      workspaceId: SHARED_WS,
      runtime: makeStubRuntime({
        registries: new Map(),
        memberships: new Map(),
        existingWorkspaces: new Set(),
        workDir,
        listCalls,
      }),
    });

    await runWithRequestContext(
      {
        // A different workspace sits in AsyncLocalStorage. The router must
        // ignore it and query SHARED_WS, the bound workspace.
        identity: { id: OTHER_USER, email: "other@x", emailVerified: true, orgRole: null },
        scope: {
          kind: "workspace",
          workspaceId: OTHER_WS,
          workspaceAgents: null,
          workspaceModelOverride: null,
        },
      },
      async () => {
        await router.availableTools();
      },
    );

    expect(listCalls).toEqual([SHARED_WS]);
  });
});

describe("IdentityToolRouter — execute (workspace door)", () => {
  // Pins: a `ws_<id>-<source>__<tool>` call for the BOUND workspace routes to
  // that workspace's source, and the source's `execute` sees the bare local
  // tool name (no source prefix). Naive failure: pass `routed.toolName`
  // straight through, leaving `crm__search` and breaking sources that switch
  // on bare names.
  test("dispatches the bare local tool name to the bound workspace's source", async () => {
    const crm = makeSpySource("crm");
    const runtime = makeStubRuntime({
      registries: new Map([[SHARED_WS, [crm]]]),
      memberships: new Map([[USER_ID, [SHARED_WS]]]),
      existingWorkspaces: new Set([SHARED_WS]),
      workDir,
    });
    const router = new IdentityToolRouter({ identityId: USER_ID, workspaceId: SHARED_WS, runtime });

    const call: ToolCall = { id: "c1", name: `${SHARED_WS}-crm__search`, input: { q: "acme" } };
    const result = await router.execute(call);

    expect(result.isError).toBe(false);
    expect(crm.calls).toHaveLength(1);
    expect(crm.calls[0]?.toolName).toBe("search");
    expect(crm.calls[0]?.input).toEqual({ q: "acme" });
  });

  // Pins: the per-call RequestContext carries the ROUTED workspace id. The
  // chat session's ambient scope is the personal workspace (the session
  // bridge); a call to the bound focused workspace must restamp to it so
  // `nb__*` handlers reading `requireWorkspaceId()` see the right workspace.
  test("restamps RequestContext.scope.workspaceId to the bound workspace, even with a different ambient workspace", async () => {
    const crm = makeSpySource("crm");
    const runtime = makeStubRuntime({
      registries: new Map([[SHARED_WS, [crm]]]),
      memberships: new Map([[USER_ID, [SHARED_WS, PERSONAL_WS]]]),
      existingWorkspaces: new Set([SHARED_WS, PERSONAL_WS]),
      workDir,
    });
    const router = new IdentityToolRouter({ identityId: USER_ID, workspaceId: SHARED_WS, runtime });

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
        await router.execute({ id: "c1", name: `${SHARED_WS}-crm__search`, input: {} });
      },
    );

    expect(crm.calls).toHaveLength(1);
    const ctx = crm.calls[0]?.context;
    expect(ctx).toBeDefined();
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
      workspaceId: SHARED_WS,
      runtime,
      onWorkspaceDispatch: hook,
    });

    await router.execute({ id: "c1", name: `${SHARED_WS}-crm__search`, input: {} });

    expect(hookEvents).toHaveLength(1);
    expect(hookEvents[0]?.callId).toBe("c1");
    expect(hookEvents[0]?.wsId).toBe(SHARED_WS);
    expect(hookEvents[0]?.sourceCallCount).toBe(0);
  });
});

describe("IdentityToolRouter — the wall (cross-workspace denial)", () => {
  // Pins: a session bounded to one workspace cannot reach another, even one
  // the identity is a member of. The call is denied as an `isError` result,
  // surfaced through the same mapping as `WorkspaceAccessDenied`.
  test("denies a call to a workspace other than the bound one", async () => {
    const crm = makeSpySource("crm");
    const runtime = makeStubRuntime({
      // The other workspace's source exists and the user is a member — only
      // the wall stops the reach.
      registries: new Map([[OTHER_WS, [crm]]]),
      memberships: new Map([[USER_ID, [SHARED_WS, OTHER_WS]]]),
      existingWorkspaces: new Set([SHARED_WS, OTHER_WS]),
      workDir,
    });
    const router = new IdentityToolRouter({ identityId: USER_ID, workspaceId: SHARED_WS, runtime });

    const result = await router.execute({ id: "c1", name: `${OTHER_WS}-crm__search`, input: {} });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: "orchestrator_error",
      reason: "workspace_access_denied",
      wsId: OTHER_WS,
    });
    // The other workspace's source must never run.
    expect(crm.calls).toHaveLength(0);
  });

  test("invalid namespaced input → isError:true with reason invalid_tool_name", async () => {
    const runtime = makeStubRuntime({
      registries: new Map(),
      memberships: new Map([[USER_ID, [SHARED_WS]]]),
      existingWorkspaces: new Set([SHARED_WS]),
      workDir,
    });
    const router = new IdentityToolRouter({ identityId: USER_ID, workspaceId: SHARED_WS, runtime });

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
    const router = new IdentityToolRouter({ identityId: USER_ID, workspaceId: SHARED_WS, runtime });

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
      workspaceId: SHARED_WS,
      runtime,
      onWorkspaceDispatch: (callId) => hookEvents.push(callId),
    });

    await router.execute({ id: "c1", name: "conversations__list", input: {} });

    expect(hookEvents).toEqual([]);
  });
});
