import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { AgentEngine } from "../../src/engine/engine.ts";
import { textContent } from "../../src/engine/content-helpers.ts";
import type {
  EngineConfig,
  ToolResult,
  ToolSchema,
} from "../../src/engine/types.ts";
import { IdentityContext } from "../../src/identity/context.ts";
import type { OrchestratorRuntime } from "../../src/orchestrator/index.ts";
import { PermissionStore } from "../../src/permissions/permission-store.ts";
import { IdentityToolRouter } from "../../src/runtime/identity-tool-router.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import type { Tool, ToolSource } from "../../src/tools/types.ts";
import { WorkspaceContext } from "../../src/workspace/context.ts";
import { createEchoModel } from "../helpers/echo-model.ts";

/**
 * The connector permission policy (`disallow`) must be enforced on EVERY
 * door that dispatches a workspace tool — not only the REST door that routes
 * through `ToolRegistry.execute`. This drives the highest-traffic door (the
 * chat engine → `IdentityToolRouter` → `routed.source.execute`) and asserts a
 * `disallow`ed tool is blocked BEFORE the source runs, with the same
 * `tool_permission_denied` envelope the registry gate returns.
 *
 * Registry parity (the REST door) is asserted alongside so the two doors are
 * provably in agreement. The external `/mcp` door shares the same
 * `assertToolAllowed` gate (wired in `mcp-server.ts` before task negotiation);
 * an HTTP-level `/mcp` parity case is left as a follow-up — it needs the full
 * `startServer()` transport, which this engine-path test deliberately avoids.
 */

const WS_ID = "ws_acme";
const IDENTITY_ID = "usr_admin";

/** A workspace source with one safe and one destructive tool; logs executions. */
class MockSource implements ToolSource {
  readonly name = "mock";
  readonly callLog: string[] = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async tools(): Promise<Tool[]> {
    return [
      { name: "mock__safe_read", description: "Safe read.", inputSchema: {}, source: this.name },
      {
        name: "mock__destructive_write",
        description: "Destructive write.",
        inputSchema: {},
        source: this.name,
      },
    ];
  }
  async execute(toolName: string): Promise<ToolResult> {
    this.callLog.push(toolName);
    return { content: textContent(`mock ${toolName} ok`), isError: false };
  }
}

/** Namespaced schemas the engine treats as the active reachable set. */
const ACTIVE_TOOLS: ToolSchema[] = [
  { name: `${WS_ID}-mock__safe_read`, description: "Safe read.", inputSchema: {} },
  { name: `${WS_ID}-mock__destructive_write`, description: "Destructive write.", inputSchema: {} },
];

const ENGINE_CONFIG: EngineConfig = {
  model: "test-model",
  maxIterations: 4,
  maxInputTokens: 500_000,
  maxOutputTokens: 16_384,
};

/**
 * Minimal `OrchestratorRuntime` that resolves one workspace source and exposes
 * the real `PermissionStore`. `routeToolCall` only touches
 * `getWorkspaceContext`, `getRegistryForWorkspace`, and `getPermissionStore`
 * on the workspace path; the identity accessors are present to satisfy the
 * structural type and never invoked here.
 */
function makeRuntime(workDir: string, source: ToolSource, store: PermissionStore): OrchestratorRuntime {
  return {
    getWorkspaceContext: (wsId: string) => new WorkspaceContext({ wsId, workDir }),
    getRegistryForWorkspace: () => ({
      getSource: (n: string) => (n === source.name ? source : undefined),
    }),
    getIdentitySource: () => undefined,
    getIdentityContext: (identityId: string) => new IdentityContext({ userId: identityId, workDir }),
    listToolsForWorkspace: async () => ACTIVE_TOOLS,
    getPermissionStore: () => store,
  };
}

interface Harness {
  workDir: string;
  store: PermissionStore;
  source: MockSource;
  router: IdentityToolRouter;
}

function buildHarness(): Harness {
  const workDir = mkdtempSync(join(tmpdir(), "nb-perm-doors-"));
  const store = new PermissionStore(workDir);
  const source = new MockSource();
  const router = new IdentityToolRouter({
    identityId: IDENTITY_ID,
    workspaceId: WS_ID,
    runtime: makeRuntime(workDir, source, store),
  });
  return { workDir, store, source, router };
}

/** Run one chat turn whose model emits a single tool call by namespaced name. */
async function runTurnCalling(
  router: IdentityToolRouter,
  toolName: string,
): Promise<{ captured: ToolResult | null }> {
  let captured: ToolResult | null = null;
  const model = createEchoModel({
    responses: [{ toolCalls: [{ toolCallId: "call_1", toolName, input: "{}" }] }],
  });
  const engine = new AgentEngine(model, router, new NoopEventSink());
  await engine.run(
    {
      ...ENGINE_CONFIG,
      hooks: {
        afterToolCall: (_call, result) => {
          captured = result;
          return result;
        },
      },
    },
    "You are a test.",
    [{ role: "user", content: [{ type: "text", text: "do it" }] }],
    ACTIVE_TOOLS,
  );
  return { captured };
}

describe("connector permission gate — enforced on the engine door", () => {
  let h: Harness;

  beforeEach(() => {
    h = buildHarness();
  });

  afterEach(() => {
    rmSync(h.workDir, { recursive: true, force: true });
  });

  test("disallow blocks a chat-turn tool call before source.execute", async () => {
    await h.store.setConnector(
      { scope: "workspace", wsId: WS_ID },
      "mock",
      { destructive_write: "disallow" },
    );

    const { captured } = await runTurnCalling(h.router, `${WS_ID}-mock__destructive_write`);

    expect(captured).not.toBeNull();
    expect(captured!.isError).toBe(true);
    expect(captured!.structuredContent).toMatchObject({
      error: "tool_permission_denied",
      connector: "mock",
      tool: "destructive_write",
      scope: "workspace",
    });
    // The gate short-circuited BEFORE dispatch — the source never ran.
    expect(h.source.callLog).toEqual([]);
  });

  test("a tool without a disallow policy still runs through the engine door", async () => {
    await h.store.setConnector(
      { scope: "workspace", wsId: WS_ID },
      "mock",
      { destructive_write: "disallow" },
    );

    const { captured } = await runTurnCalling(h.router, `${WS_ID}-mock__safe_read`);

    expect(captured).not.toBeNull();
    expect(captured!.isError).toBe(false);
    expect(h.source.callLog).toEqual(["safe_read"]);
  });

  test("registry door (REST) denies the same call identically — doors agree", async () => {
    await h.store.setConnector(
      { scope: "workspace", wsId: WS_ID },
      "mock",
      { destructive_write: "disallow" },
    );

    const registry = new ToolRegistry();
    const registrySource = new MockSource();
    registry.addSource(registrySource);
    registry.setPermissionContext(WS_ID, h.store);

    const result = await registry.execute({ name: "mock__destructive_write", input: {} });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: "tool_permission_denied" });
    expect(registrySource.callLog).toEqual([]);
  });
});
