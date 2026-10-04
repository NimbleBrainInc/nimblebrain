import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { ConnectorCatalog } from "../../src/connectors/catalog/catalog.ts";
import type { CatalogListing } from "../../src/connectors/catalog/types.ts";
import { ConnectorLifecycleManager } from "../../src/connectors/runtime/lifecycle.ts";
import type { HookReconcileDeps } from "../../src/hooks/reconcile.ts";
import { ensureHooks } from "../../src/hooks/reconcile.ts";
import type { HookIdentity } from "../../src/hooks/token.ts";
import type { UserIdentity } from "../../src/identity/provider.ts";
import type { LifecycleNotifyDeps } from "../../src/lifecycle/notify.ts";
import {
  notifyReady,
  notifyReadyOnRunning,
  resetReadyNotifications,
} from "../../src/lifecycle/notify.ts";
import type { LifecycleBinding } from "../../src/lifecycle/types.ts";
import type { Runtime } from "../../src/runtime/runtime.ts";
import { LIFECYCLE_EXTENSION_ID } from "../../src/services/lifecycle-extension.ts";
import { stopAllToolSurfaceWatches } from "../../src/tools/connector-surface.ts";
import {
  createManageConnectorsTool,
  type ManageConnectorsContext,
} from "../../src/tools/connector-tools.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import type { Tool, ToolResult } from "../../src/tools/types.ts";
import { WorkspaceContext } from "../../src/workspace/context.ts";
import { WorkspaceStore } from "../../src/workspace/workspace-store.ts";
import { CONNECTOR_FIXTURE_DIR } from "../helpers/connector-fixtures.ts";
import { installTestCredentialStore } from "../helpers/credential-store.ts";
import { seedWorkspace } from "../helpers/test-workspace.ts";

/**
 * The kernel's two lifecycle calls, driven through the install and uninstall
 * handlers that make them.
 *
 * Three things are pinned here, and each is a bug that shipped or would have:
 *
 *   1. A fresh install calls `on_ready` with `reason: "install"`, and the
 *      handler's own words reach the user as a notice on the install result.
 *   2. `on_removing` is delivered BEFORE the source is torn down, and a
 *      handler that fails does not fail the uninstall.
 *   3. The hooks reconcile and this one race a fresh install differently, on
 *      purpose: the hooks callers COALESCE into one mint, and the lifecycle
 *      callers do NOT — two calls, one flavoured `install` and one `resume`.
 *      Aligning them looks like a tidy-up and would silently delete the
 *      install notice.
 */

const ADMIN: UserIdentity = {
  id: "usr_lifecycle",
  email: "admin@example.test",
  displayName: "Admin",
  orgRole: "member",
  preferences: {},
};

const SHARED_WS = "ws_003eba8844413cd9";
/** `slugifyServerName("ai.granola/mcp")`, which is what the install records. */
const CONNECTOR = "ai-granola-mcp";
const NOTICE = "Setting up your sending workspace — watch the panel.";

const DECL: LifecycleBinding = {
  on_ready: "workspace_ready",
  on_removing: "workspace_removing",
};

/**
 * A handler as a well-behaved server advertises it: marked for its event, with
 * no required arguments, and a `ready` handler declaring `reason`.
 */
function handler(name: string): Tool {
  const event = name.endsWith("_removing") ? "removing" : "ready";
  return {
    name,
    description: "Lifecycle handler",
    inputSchema: {
      type: "object",
      properties: event === "ready" ? { reason: { type: "string" } } : {},
    },
    source: CONNECTOR,
    meta: { [LIFECYCLE_EXTENSION_ID]: { event } },
  };
}

const REGISTER_TOOL: Tool = {
  name: "set_webhook_url",
  description: "Register a webhook URL",
  inputSchema: {
    type: "object",
    properties: { vendor: { type: "string" }, url: { type: "string" } },
  },
  source: CONNECTOR,
};

function granolaEntry(): CatalogListing {
  return {
    id: "ai.granola/mcp",
    name: "Granola",
    description: "Meeting notes",
    install: {
      kind: "remote-oauth",
      url: "https://api.granola.test/mcp",
      transportType: "streamable-http",
      auth: "dcr",
    },
  };
}

interface Harness {
  workDir: string;
  tool: ReturnType<typeof createManageConnectorsTool>;
  /** Every lifecycle / hook tool call the connector's server saw, in order. */
  calls: { tool: string; input: Record<string, unknown> }[];
  /** Ordered trace of the uninstall: the notification and the teardown. */
  trace: string[];
  hookDeps: HookReconcileDeps;
  lifecycleDeps: LifecycleNotifyDeps;
  failHandler(name: string): void;
}

async function buildHarness(
  opts: { declaration?: LifecycleBinding; hooks?: boolean } = {},
): Promise<Harness> {
  const workDir = mkdtempSync(join(tmpdir(), "nb-lifecycle-notify-"));
  const credStore = installTestCredentialStore(workDir);
  const workspaceStore = new WorkspaceStore(workDir);
  const lifecycle = new ConnectorLifecycleManager(new NoopEventSink());
  const workspaceRegistry = new ToolRegistry();

  await seedWorkspace(workspaceStore, SHARED_WS, { name: "Helix" });
  await workspaceStore.addMember(SHARED_WS, ADMIN.id, "admin");

  const calls: { tool: string; input: Record<string, unknown> }[] = [];
  const trace: string[] = [];
  const failing = new Set<string>();

  const port = {
    tools: async (): Promise<Tool[]> => [
      handler("workspace_ready"),
      handler("workspace_removing"),
      REGISTER_TOOL,
    ],
    execute: async (tool: string, input: Record<string, unknown>): Promise<ToolResult> => {
      // A real round-trip takes time; that latency is what lets two racing
      // callers interleave.
      await new Promise((r) => setTimeout(r, 5));
      calls.push({ tool, input });
      trace.push(tool);
      if (failing.has(tool)) {
        return { content: [{ type: "text", text: "vendor unreachable" }], isError: true };
      }
      return { content: [{ type: "text", text: NOTICE }], isError: false };
    },
  };

  const declaration = opts.declaration ?? DECL;
  const hookDeps: HookReconcileDeps = {
    workspaceStore,
    identity: { tid: "tenant-a", key: randomBytes(32) } satisfies HookIdentity,
    declarationsFor: async () =>
      opts.hooks
        ? [{ vendor: "acme", route: "/ingest/acme", register_tool: "set_webhook_url" }]
        : [],
    portFor: () => port,
  };
  const lifecycleDeps: LifecycleNotifyDeps = {
    declarationFor: async () => declaration,
    portFor: () => port,
  };

  const uninstall = lifecycle.uninstall.bind(lifecycle);
  const runtime = {
    getWorkDir: () => workDir,
    getCredentialStore: () => credStore,
    getWorkspaceStore: () => workspaceStore,
    getWorkspaceContext: (id: string) => new WorkspaceContext({ wsId: id, workDir }),
    getConnectorCatalog: () => new ConnectorCatalog(CONNECTOR_FIXTURE_DIR),
    getLifecycle: () => ({
      ...lifecycle,
      getInstance: lifecycle.getInstance.bind(lifecycle),
      getInstances: lifecycle.getInstances.bind(lifecycle),
      seedInstance: lifecycle.seedInstance.bind(lifecycle),
      notifyInstalled: lifecycle.notifyInstalled.bind(lifecycle),
      syncBoundSkills: lifecycle.syncBoundSkills.bind(lifecycle),
      setConnectorSkillFetch: lifecycle.setConnectorSkillFetch.bind(lifecycle),
      // Wrapped so the ORDER of the notification and the teardown is
      // observable. "Before teardown" is the whole contract: after it there is
      // no source to call.
      uninstall: async (...args: Parameters<typeof uninstall>) => {
        trace.push("uninstall");
        return uninstall(...args);
      },
    }),
    getRegistryForWorkspace: () => workspaceRegistry,
    getPermissionStore: () => ({ deleteConnector: async () => {} }),
    getUserStore: () => ({ get: async () => null }),
    getUserConnectorStore: () => ({ get: async () => null }),
    getConnectorInstancesForWorkspace: () => lifecycle.getInstances(),
    getAllowInsecureRemotes: () => false,
    getHookReconcileDeps: () => hookDeps,
    getLifecycleNotifyDeps: () => lifecycleDeps,
  } as unknown as Runtime;

  const ctx: ManageConnectorsContext = {
    runtime,
    getIdentity: () => ADMIN,
    getWorkspaceId: () => SHARED_WS,
  };

  return {
    workDir,
    tool: createManageConnectorsTool(ctx),
    calls,
    trace,
    hookDeps,
    lifecycleDeps,
    failHandler: (name: string) => failing.add(name),
  };
}

let h: Harness;

beforeEach(async () => {
  resetReadyNotifications();
  h = await buildHarness();
});

afterEach(() => {
  stopAllToolSurfaceWatches();
  resetReadyNotifications();
  rmSync(h.workDir, { recursive: true, force: true });
});

async function install(): Promise<ToolResult> {
  return h.tool.handler({ action: "install", entry: granolaEntry(), wsId: SHARED_WS });
}

function messageOf(result: ToolResult): string {
  return (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
}

describe("a fresh install", () => {
  test("calls on_ready with reason 'install' and surfaces the handler's words", async () => {
    const result = await install();

    expect(result.isError).toBe(false);
    expect(h.calls).toEqual([{ tool: "workspace_ready", input: { reason: "install" } }]);

    // The notice is a bundle telling the user what is now happening — the one
    // place somebody waiting on install-time setup is told to wait. It is its
    // own field, not folded into `warning`, which means something is wrong.
    const sc = result.structuredContent as { notice?: string; warning?: string };
    expect(sc.notice).toBe(NOTICE);
    expect(sc.warning).toBeUndefined();
    expect(messageOf(result)).toContain(NOTICE);
  });

  test("a connector that does not advertise the extension installs with no notice and no call", async () => {
    h = await buildHarness({ declaration: undefined });
    // `declarationFor` answering `undefined` is the ordinary case: almost no
    // connector advertises the extension, and the seam is inert until one does.
    h.lifecycleDeps.declarationFor = async () => undefined;
    const result = await install();
    expect(result.isError).toBe(false);
    expect(h.calls).toHaveLength(0);
    expect((result.structuredContent as { notice?: string }).notice).toBeUndefined();
  });
});

describe("uninstall", () => {
  test("delivers on_removing before the source is torn down", async () => {
    await install();
    h.trace.length = 0;
    h.calls.length = 0;

    const result = await h.tool.handler({
      action: "uninstall",
      serverName: CONNECTOR,
      wsId: SHARED_WS,
    });

    expect(result.isError).toBe(false);
    expect(h.calls).toEqual([{ tool: "workspace_removing", input: {} }]);
    // Order is the contract: after the teardown there is nothing left to call,
    // which is the one place `on_ready`/`on_removing`'s asymmetry bites.
    expect(h.trace).toEqual(["workspace_removing", "uninstall"]);
  });

  test("a failing on_removing does not fail the uninstall", async () => {
    await install();
    h.failHandler("workspace_removing");

    const result = await h.tool.handler({
      action: "uninstall",
      serverName: CONNECTOR,
      wsId: SHARED_WS,
    });

    // Blocking a user's uninstall on a vendor's availability would be the wrong
    // trade in both directions.
    expect(result.isError).toBe(false);
    expect(h.trace).toContain("uninstall");
  });
});

describe("the two reconciles racing a fresh install", () => {
  test("hooks coalesce into one mint; the lifecycle calls do not coalesce at all", async () => {
    h = await buildHarness({ hooks: true });
    // Installed, because the hook reconcile reads the connector's MCP endpoint from its ref.
    await new WorkspaceStore(h.workDir).update(SHARED_WS, {
      connectors: [{ url: "https://granola.internal/mcp", serverName: CONNECTOR }],
    });

    // The connection-running observer's shape and the install handler's shape,
    // started together — the exact overlap `eagerStartRemoteSource` produces.
    notifyReadyOnRunning(h.lifecycleDeps, SHARED_WS, CONNECTOR);
    await Promise.all([
      ensureHooks(h.hookDeps, SHARED_WS, CONNECTOR, { onlyMissing: true }),
      ensureHooks(h.hookDeps, SHARED_WS, CONNECTOR),
      notifyReady(h.lifecycleDeps, SHARED_WS, CONNECTOR, "install"),
    ]);

    const registered = h.calls.filter((c) => c.tool === "set_webhook_url");
    const ready = h.calls.filter((c) => c.tool === "workspace_ready");
    // One mint: two divergent kids would leave the server registered on a URL
    // the door never admits.
    expect(registered).toHaveLength(1);
    // Two notifications, one of each flavour: `on_ready` mints nothing, so the
    // flight buys no safety and would destroy the only thing `reason` carries.
    expect(ready.map((c) => c.input.reason).sort()).toEqual(["install", "resume"]);
  });
});
