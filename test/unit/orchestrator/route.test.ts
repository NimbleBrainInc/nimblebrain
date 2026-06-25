/**
 * Unit tests for `src/orchestrator/route.ts`.
 *
 * Pins the per-call routing contract under the workspace wall: a session is
 * bounded to ONE workspace (passed as `workspaceId`). A workspace-scoped call
 * to that workspace dispatches; a call to any other workspace is denied
 * (`CrossWorkspaceReachDenied`); a workspace call on a session with no
 * workspace (e.g. `/mcp`) is `WorkspaceToolUnavailable`. Identity (bare) calls
 * route to the identity door regardless of workspace.
 *
 * Test surface is structural: a stub `OrchestratorRuntime` is built per case,
 * exercising the orchestrator without booting a real `Runtime` or hitting the
 * filesystem.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { ToolResult } from "../../../src/engine/types.ts";
import { IdentityContext } from "../../../src/identity/context.ts";
import {
  CrossWorkspaceReachDenied,
  type OrchestratorRuntime,
  routeToolCall,
  UnknownIdentitySource,
  UnknownToolSource,
  WorkspaceAccessDenied,
  WorkspaceToolUnavailable,
} from "../../../src/orchestrator/index.ts";
import type { Tool, ToolSource } from "../../../src/tools/types.ts";
import { WorkspaceContext } from "../../../src/workspace/context.ts";
import { personalWorkspaceIdFor } from "../../../src/workspace/workspace-store.ts";

// ── Stub source ───────────────────────────────────────────────────

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
  /** Working directory passed to constructed `WorkspaceContext` instances. */
  workDir: string;
  /** Kernel identity sources by name (conversations, …). The identity door. */
  identitySources?: Map<string, ToolSource>;
  /** Optional self-heal hook exposed as `recoverWorkspaceSource`. */
  recoverWorkspaceSource?: (wsId: string, sourceName: string) => boolean | Promise<boolean>;
}

interface StubRuntime extends OrchestratorRuntime {
  /** Every `WorkspaceContext` returned, in call order — used to assert non-aliasing. */
  contextCallCount(): number;
  /** How many times `recoverWorkspaceSource` was invoked. */
  recoverCallCount(): number;
}

function makeStubRuntime(opts: StubRuntimeOpts): StubRuntime {
  const emitted: WorkspaceContext[] = [];
  let recoverCalls = 0;

  return {
    ...(opts.recoverWorkspaceSource
      ? {
          async recoverWorkspaceSource(wsId: string, sourceName: string): Promise<boolean> {
            recoverCalls += 1;
            return opts.recoverWorkspaceSource!(wsId, sourceName);
          },
        }
      : {}),
    getWorkspaceContext(wsId: string) {
      // Production behavior: fresh instance per call (the context-isolation
      // test relies on this).
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
    getIdentitySource(name: string): ToolSource | undefined {
      return opts.identitySources?.get(name);
    },
    getIdentityContext(identityId: string): IdentityContext {
      return new IdentityContext({ userId: identityId, workDir: opts.workDir });
    },
    listToolsForWorkspace() {
      return Promise.resolve([]);
    },
    contextCallCount() {
      return emitted.length;
    },
    recoverCallCount() {
      return recoverCalls;
    },
  };
}

// ── Test scaffolding ──────────────────────────────────────────────

const SHARED_WS = "ws_helix";
const OTHER_WS = "ws_acme";
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
    workDir,
  });
}

// ── Tests ─────────────────────────────────────────────────────────

describe("routeToolCall — happy path", () => {
  // A call to the session's own workspace routes end-to-end and produces a
  // context whose wsId matches the parsed namespace.
  test("returns a context whose wsId === parsed wsId and toolName stripped of prefix", async () => {
    const routed = await routeToolCall({
      identityId: USER_ID,
      namespacedName: `${SHARED_WS}-crm__search`,
      workspaceId: SHARED_WS,
      runtime: buildHappyRuntime(),
    });

    expect(routed.context.workspaceId).toBe(SHARED_WS);
    expect(routed.toolName).toBe("crm__search");
    expect(routed.source.name).toBe("crm");
  });
});

describe("routeToolCall — strict invariant (no silent workspace fallback)", () => {
  // A bare (un-namespaced) name routes to the identity door, NEVER to a
  // workspace. `crm` is a workspace app, not a kernel identity source, so it's
  // refused — and no WorkspaceContext is constructed.
  test("bare workspace-app name → UnknownIdentitySource, no WorkspaceContext", async () => {
    const runtime = buildHappyRuntime();

    let thrown: unknown = null;
    try {
      await routeToolCall({
        identityId: USER_ID,
        namespacedName: "crm__search",
        workspaceId: SHARED_WS,
        runtime,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UnknownIdentitySource);
    expect(runtime.contextCallCount()).toBe(0);
  });

  test("bare identity-source name routes to identity scope — no WorkspaceContext", async () => {
    const convSource = makeStubSource("conversations");
    const runtime = makeStubRuntime({
      registries: new Map(),
      workDir,
      identitySources: new Map([["conversations", convSource]]),
    });
    const routed = await routeToolCall({
      identityId: USER_ID,
      namespacedName: "conversations__list",
      workspaceId: SHARED_WS,
      runtime,
    });
    expect(routed.kind).toBe("identity");
    expect(routed.toolName).toBe("conversations__list");
    expect(routed.source).toBe(convSource);
    expect(runtime.contextCallCount()).toBe(0);
    if (routed.kind === "identity") {
      expect(routed.context).toBeInstanceOf(IdentityContext);
    }
  });
});

describe("routeToolCall — the wall (cross-workspace denial)", () => {
  // A session bounded to one workspace cannot reach another — even one the
  // identity is a member of. Denied before existence is checked, so no
  // WorkspaceContext is constructed.
  test("a call to a workspace other than the session's throws CrossWorkspaceReachDenied", async () => {
    const runtime = makeStubRuntime({
      registries: new Map([[OTHER_WS, [makeStubSource("crm")]]]),
      workDir,
    });

    let thrown: unknown = null;
    try {
      await routeToolCall({
        identityId: USER_ID,
        namespacedName: `${OTHER_WS}-crm__search`,
        workspaceId: SHARED_WS,
        runtime,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CrossWorkspaceReachDenied);
    // Maps through the existing WorkspaceAccessDenied error surface.
    expect(thrown).toBeInstanceOf(WorkspaceAccessDenied);
    expect((thrown as CrossWorkspaceReachDenied).wsId).toBe(OTHER_WS);
    expect((thrown as CrossWorkspaceReachDenied).focusedWorkspaceId).toBe(SHARED_WS);
    expect(runtime.contextCallCount()).toBe(0);
  });

  // An identity-scoped session with NO workspace (e.g. `/mcp`) cannot reach any
  // workspace tool — only identity tools.
  test("a workspace call on a session with no workspace throws WorkspaceToolUnavailable", async () => {
    const runtime = makeStubRuntime({
      registries: new Map([[SHARED_WS, [makeStubSource("crm")]]]),
      workDir,
    });

    let thrown: unknown = null;
    try {
      await routeToolCall({
        identityId: USER_ID,
        namespacedName: `${SHARED_WS}-crm__search`,
        // No workspaceId — identity-scoped session.
        runtime,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WorkspaceToolUnavailable);
    expect(thrown).toBeInstanceOf(WorkspaceAccessDenied);
    expect(runtime.contextCallCount()).toBe(0);
  });
});

describe("routeToolCall — personal workspace", () => {
  // A session bounded to the user's personal workspace routes its tools. The
  // wsId is derived via `personalWorkspaceIdFor(userId)` to guard against
  // hand-built `ws_user_<id>` forms.
  test("a call to the bound personal workspace succeeds", async () => {
    const routed = await routeToolCall({
      identityId: USER_ID,
      namespacedName: `${PERSONAL_WS}-gmail__send`,
      workspaceId: PERSONAL_WS,
      runtime: buildHappyRuntime(),
    });

    expect(routed.context.workspaceId).toBe(PERSONAL_WS);
    expect(routed.toolName).toBe("gmail__send");
    expect(routed.source.name).toBe("gmail");
  });
});

describe("routeToolCall — context isolation", () => {
  // Two routes (each bounded to its own workspace) return distinct
  // `WorkspaceContext` instances with distinct roots — no cross-tenant aliasing.
  test("two routes return non-aliased contexts whose getRoot() differ", async () => {
    const runtime = buildHappyRuntime();

    const first = await routeToolCall({
      identityId: USER_ID,
      namespacedName: `${SHARED_WS}-crm__search`,
      workspaceId: SHARED_WS,
      runtime,
    });
    const second = await routeToolCall({
      identityId: USER_ID,
      namespacedName: `${PERSONAL_WS}-gmail__send`,
      workspaceId: PERSONAL_WS,
      runtime,
    });

    expect(first.context).not.toBe(second.context);
    expect(first.context.getRoot()).not.toBe(second.context.getRoot());
    expect(first.context.workspaceId).toBe(SHARED_WS);
    expect(second.context.workspaceId).toBe(PERSONAL_WS);
    expect(runtime.contextCallCount()).toBe(2);
  });
});

describe("routeToolCall — no ambient state", () => {
  // The orchestrator derives wsId from the parsed namespace + the passed
  // `workspaceId` alone — never from a "current workspace" pointer. The stub
  // deliberately omits any such accessor.
  test("routing succeeds with no ambient 'current workspace' state", async () => {
    const routed = await routeToolCall({
      identityId: USER_ID,
      namespacedName: `${SHARED_WS}-crm__search`,
      workspaceId: SHARED_WS,
      runtime: buildHappyRuntime(),
    });

    expect(routed.context.workspaceId).toBe(SHARED_WS);
  });
});

describe("routeToolCall — unknown tool source", () => {
  test("source not registered in the workspace registry throws UnknownToolSource", async () => {
    const runtime = makeStubRuntime({
      // SHARED_WS is the session workspace but has no `crm` source.
      registries: new Map([[SHARED_WS, []]]),
      workDir,
    });

    let thrown: unknown = null;
    try {
      await routeToolCall({
        identityId: USER_ID,
        namespacedName: `${SHARED_WS}-crm__search`,
        workspaceId: SHARED_WS,
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

// ── Self-heal: a missing-but-recoverable source is re-registered ─────

describe("routeToolCall — self-heal on a recoverable source miss", () => {
  test("re-registers a missing source via recoverWorkspaceSource, then routes to it", async () => {
    const wsSources: ToolSource[] = [];
    const runtime = makeStubRuntime({
      registries: new Map([[SHARED_WS, wsSources]]),
      workDir,
      recoverWorkspaceSource(_wsId, sourceName) {
        wsSources.push(makeStubSource(sourceName));
        return true;
      },
    });

    const routed = await routeToolCall({
      identityId: USER_ID,
      namespacedName: `${SHARED_WS}-crm__search`,
      workspaceId: SHARED_WS,
      runtime,
    });

    expect(routed.source.name).toBe("crm");
    expect(routed.toolName).toBe("crm__search");
    expect(runtime.recoverCallCount()).toBe(1);
  });

  test("recovery that fails to register still throws UnknownToolSource (no masking)", async () => {
    const runtime = makeStubRuntime({
      registries: new Map([[SHARED_WS, []]]),
      workDir,
      recoverWorkspaceSource() {
        return false;
      },
    });

    let thrown: unknown = null;
    try {
      await routeToolCall({
        identityId: USER_ID,
        namespacedName: `${SHARED_WS}-crm__search`,
        workspaceId: SHARED_WS,
        runtime,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UnknownToolSource);
    expect((thrown as UnknownToolSource).sourceName).toBe("crm");
    expect(runtime.recoverCallCount()).toBe(1);
  });

  test("a recovery hook that throws is swallowed; the call fails with UnknownToolSource", async () => {
    const runtime = makeStubRuntime({
      registries: new Map([[SHARED_WS, []]]),
      workDir,
      recoverWorkspaceSource() {
        throw new Error("re-spawn blew up");
      },
    });

    let thrown: unknown = null;
    try {
      await routeToolCall({
        identityId: USER_ID,
        namespacedName: `${SHARED_WS}-crm__search`,
        workspaceId: SHARED_WS,
        runtime,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UnknownToolSource);
  });

  test("an already-registered source never invokes recovery", async () => {
    const runtime = makeStubRuntime({
      registries: new Map([[SHARED_WS, [makeStubSource("crm")]]]),
      workDir,
      recoverWorkspaceSource() {
        return true;
      },
    });

    const routed = await routeToolCall({
      identityId: USER_ID,
      namespacedName: `${SHARED_WS}-crm__search`,
      workspaceId: SHARED_WS,
      runtime,
    });

    expect(routed.source.name).toBe("crm");
    expect(runtime.recoverCallCount()).toBe(0);
  });
});
