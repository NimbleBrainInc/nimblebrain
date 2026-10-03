/**
 * The host reading `ai.nimblebrain/lifecycle` from the wire, with the catalog
 * block as the fallback, through a real `Runtime` and real MCP connections on
 * both eras.
 *
 * Pinned here:
 *  - a connector that advertises the extension gets both events through the
 *    tools it marked, and its catalog `lifecycle` block is not used (and is
 *    reported superseded once);
 *  - a marker from a server that does not advertise is not a handler;
 *  - the binding is read from a 2025-era `initialize` and from a 2026-07-28
 *    `server/discover`;
 *  - wire-declared handlers are absent from every listing and refused on every
 *    door, for an admin as well as a member, through the one `isHostOnlyTool`
 *    gate;
 *  - `reason` goes only to a handler that declares it;
 *  - every lifecycle call is inline, on a connection that advertises tasks and
 *    for a handler marked `taskSupport: "optional"`;
 *  - an uninstall with no binding held and the connection idle-closed still
 *    reaches `removing`.
 *
 * The catalog-only path is pinned, unchanged, by
 * `connector-lifecycle-notify.test.ts` and `connector-lifecycle-host-only.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import type { ToolCallResponse } from "../../src/api/schemas/responses.ts";
import { type ServerHandle, startServer } from "../../src/api/server.ts";
import { CATALOG_DIR_ENV } from "../../src/connectors/catalog/catalog.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { forgetLifecycleBinding, resetLifecycleBindings } from "../../src/lifecycle/bindings.ts";
import {
  notifyReady,
  notifyRemoving,
  resetReadyNotifications,
} from "../../src/lifecycle/notify.ts";
import { log } from "../../src/observability/log.ts";
import { IdentityToolRouter } from "../../src/runtime/identity-tool-router.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { stopAllToolSurfaceWatches } from "../../src/tools/connector-surface.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { readJson } from "../helpers/http.ts";
import {
  type FixtureCall,
  marked,
  serveModernLifecycleServer,
  startLifecycleSource,
} from "../helpers/lifecycle-server.ts";
import { seedWorkspace } from "../helpers/test-workspace.ts";

const ADMIN_WS = "ws_003eba8844413cd9";
const MEMBER_WS = "ws_00562f536b60bccc";
const WORKSPACES = [ADMIN_WS, MEMBER_WS] as const;

/** `slugifyServerName("ai.acme/wired")`: advertises the extension, and the catalog declares other handlers. */
const WIRED = "ai-acme-wired";
/** Marks the same tools, advertises nothing. */
const QUIET = "ai-acme-quiet";
/** Advertises with duplicate, unknown and uncallable markers. */
const MESSY = "ai-acme-messy";
/** On 2026-07-28 over HTTP, advertising tasks as well. */
const MODERN = "ai-acme-modern";

const HANDLERS = ["scope_ready", "scope_removing"] as const;

const testDir = join(tmpdir(), `nb-lifecycle-extension-${Date.now()}`);
const catalogDir = join(testDir, "catalog");

const CATALOG_YAML = `servers:
  - name: ai.acme/wired
    title: Acme Wired
    description: Test connector whose catalog block the wire supersedes
    version: "1.0.0"
    remotes:
      - type: streamable-http
        url: https://wired.acme.test/mcp
    _meta:
      ai.nimblebrain/connector:
        auth: dcr
      ai.nimblebrain/host:
        host_version: "1.5"
        lifecycle:
          on_ready: catalog_ready
          on_removing: catalog_removing
`;

/** What each connector's server answered, per workspace. */
const calls = new Map<string, FixtureCall[]>();
const sources = new Map<string, McpSource>();

function ran(wsId: string, server: string): FixtureCall[] {
  return calls.get(`${wsId}/${server}`) ?? [];
}

function resetCalls(): void {
  for (const log of calls.values()) log.length = 0;
}

let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;
let savedCatalogDir: string | undefined;
let modern: ReturnType<typeof serveModernLifecycleServer>;

beforeAll(async () => {
  mkdirSync(catalogDir, { recursive: true });
  writeFileSync(join(catalogDir, "acme.yaml"), CATALOG_YAML);
  savedCatalogDir = process.env[CATALOG_DIR_ENV];
  process.env[CATALOG_DIR_ENV] = catalogDir;

  runtime = await Runtime.start({
    identityProvider: devProvider,
    model: { provider: "custom", adapter: createEchoModel() },
    logging: { disabled: true },
    workDir: testDir,
    allowInsecureRemotes: true,
  });

  const wsStore = runtime.getWorkspaceStore();
  await seedWorkspace(wsStore, ADMIN_WS, { name: "Helix" });
  await wsStore.addMember(ADMIN_WS, DEV_IDENTITY.id, "admin");
  await seedWorkspace(wsStore, MEMBER_WS, { name: "Orbit" });
  await wsStore.addMember(MEMBER_WS, DEV_IDENTITY.id, "member");

  const wiredTools = [
    // No `reason` in its schema, so it is called with `{}`.
    marked("scope_ready", "ready"),
    // A 2025-era task marker: the call must still go inline.
    marked("scope_removing", "removing", { taskSupport: "optional" }),
    // What the catalog block names: unmarked, and superseded.
    { name: "catalog_ready" },
    { name: "catalog_removing" },
    { name: "search" },
  ];
  modern = serveModernLifecycleServer(MODERN, {
    tasks: true,
    tools: [
      marked("scope_ready", "ready", { properties: { reason: { type: "string" } } }),
      marked("scope_removing", "removing"),
      { name: "search" },
    ],
  });
  for (const wsId of WORKSPACES) {
    const registry = await runtime.ensureWorkspaceRegistry(wsId);
    const fixtures = {
      [WIRED]: { tools: wiredTools },
      [QUIET]: { advertises: false, tools: wiredTools.slice(0, 2) },
      [MESSY]: {
        tools: [
          marked("a_ready", "ready"),
          marked("b_ready", "ready"),
          marked("scope_paused", "paused"),
          marked("scope_removing", "removing", { properties: { why: {} }, required: ["why"] }),
        ],
      },
    };
    for (const [name, opts] of Object.entries(fixtures)) {
      const { source, calls: log } = await startLifecycleSource(name, opts);
      calls.set(`${wsId}/${name}`, log);
      sources.set(`${wsId}/${name}`, source);
      registry.addSource(source);
    }
    // Installed at the catalog entry's URL, so the catalog block binds to it.
    await wsStore.update(wsId, {
      connectors: [
        { url: "https://wired.acme.test/mcp", serverName: WIRED },
        { url: "https://quiet.acme.test/mcp", serverName: QUIET },
        { url: "https://messy.acme.test/mcp", serverName: MESSY },
      ],
    });
  }
  const modernSource = new McpSource(
    MODERN,
    { type: "remote", url: new URL(modern.url), allowInsecure: true },
    new NoopEventSink(),
  );
  await modernSource.start();
  (await runtime.ensureWorkspaceRegistry(ADMIN_WS)).addSource(modernSource);
  sources.set(`${ADMIN_WS}/${MODERN}`, modernSource);
  calls.set(`${ADMIN_WS}/${MODERN}`, modern.calls);

  handle = startServer({ runtime, port: 0 });
  baseUrl = `http://localhost:${handle.port}`;
});

afterAll(async () => {
  handle.stop(true);
  stopAllToolSurfaceWatches();
  resetReadyNotifications();
  resetLifecycleBindings();
  await runtime.shutdown();
  modern.close();
  if (savedCatalogDir === undefined) delete process.env[CATALOG_DIR_ENV];
  else process.env[CATALOG_DIR_ENV] = savedCatalogDir;
  rmSync(testDir, { recursive: true, force: true });
});

async function mcpClient(wsId: string): Promise<Client> {
  const client = new Client({ name: "lifecycle-extension-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/${wsId}`)));
  return client;
}

function refusal(server: string, tool: string) {
  return { error: "host_only_tool", connector: server, tool };
}

describe("the host's calls, declared on the wire", () => {
  it("reads the binding from a 2025-era initialize", () => {
    const source = sources.get(`${ADMIN_WS}/${WIRED}`);
    expect(source?.getNegotiatedProtocolVersion()?.startsWith("2025-")).toBe(true);
  });

  it("delivers both events to the marked tools, not the catalog's, and says so once", async () => {
    resetCalls();
    const info = spyOn(log, "info");
    try {
      const deps = runtime.getLifecycleNotifyDeps();
      await notifyReady(deps, ADMIN_WS, WIRED, "install");
      await notifyRemoving(deps, ADMIN_WS, WIRED);
      await notifyReady(deps, ADMIN_WS, WIRED, "resume");
      // `reason` is not in scope_ready's schema; every call is inline, the
      // `taskSupport: "optional"` handler's included.
      expect(ran(ADMIN_WS, WIRED)).toEqual([
        { tool: "scope_ready", args: {}, task: false },
        { tool: "scope_removing", args: {}, task: false },
        { tool: "scope_ready", args: {}, task: false },
      ]);
      const superseded = info.mock.calls.filter(
        ([msg]) =>
          typeof msg === "string" && msg.includes(`"${WIRED}"`) && msg.includes("superseded"),
      );
      expect(superseded).toHaveLength(1);
    } finally {
      info.mockRestore();
    }
  });

  it("reads the binding from server/discover on 2026-07-28 and calls inline though tasks are advertised", async () => {
    resetCalls();
    const source = sources.get(`${ADMIN_WS}/${MODERN}`);
    expect(source?.getNegotiatedProtocolVersion()).toBe("2026-07-28");
    const deps = runtime.getLifecycleNotifyDeps();
    await notifyReady(deps, ADMIN_WS, MODERN, "install");
    await notifyRemoving(deps, ADMIN_WS, MODERN);
    expect(ran(ADMIN_WS, MODERN)).toEqual([
      // This handler declares `reason`, so it gets it.
      { tool: "scope_ready", args: { reason: "install" }, task: false },
      { tool: "scope_removing", args: {}, task: false },
    ]);
  });

  it("ignores a marker from a server that does not advertise the extension", async () => {
    resetCalls();
    const deps = runtime.getLifecycleNotifyDeps();
    expect(await deps.declarationFor(ADMIN_WS, QUIET)).toBeUndefined();
    await notifyReady(deps, ADMIN_WS, QUIET, "install");
    await notifyRemoving(deps, ADMIN_WS, QUIET);
    expect(ran(ADMIN_WS, QUIET)).toEqual([]);
  });

  it("calls nothing it rejected, and reports each rejection as an install warning", async () => {
    resetCalls();
    const deps = runtime.getLifecycleNotifyDeps();
    await notifyReady(deps, ADMIN_WS, MESSY, "install");
    await notifyRemoving(deps, ADMIN_WS, MESSY);
    expect(ran(ADMIN_WS, MESSY)).toEqual([]);
    const warnings = (await deps.contractWarningsFor?.(ADMIN_WS, MESSY)) ?? [];
    expect(warnings).toHaveLength(3);
    expect(warnings.join(" ")).toContain("undeclared");
    expect(warnings.join(" ")).toContain("unknown event");
    expect(warnings.join(" ")).toContain("required");
  });

  it("reaches removing after an idle close with no binding held", async () => {
    resetCalls();
    // A new process holds no binding; the connection has idle-closed.
    forgetLifecycleBinding(MEMBER_WS, WIRED);
    const source = sources.get(`${MEMBER_WS}/${WIRED}`) as unknown as { client: unknown };
    source.client = null;
    await notifyRemoving(runtime.getLifecycleNotifyDeps(), MEMBER_WS, WIRED);
    expect(ran(MEMBER_WS, WIRED)).toEqual([{ tool: "scope_removing", args: {}, task: false }]);
  });
});

describe("withholding wire-declared handlers", () => {
  for (const wsId of WORKSPACES) {
    const role = wsId === ADMIN_WS ? "an admin" : "a member";

    it(`leaves them out of ${role}'s /mcp tools/list, and lists the superseded catalog names`, async () => {
      const client = await mcpClient(wsId);
      try {
        const names = (await client.listTools()).tools.map((t) => t.name);
        for (const h of HANDLERS) expect(names).not.toContain(`${WIRED}__${h}`);
        expect(names).toContain(`${WIRED}__search`);
        expect(names).toContain(`${WIRED}__catalog_ready`);
        // Marked without the capability: an ordinary tool.
        for (const h of HANDLERS) expect(names).toContain(`${QUIET}__${h}`);
      } finally {
        await client.close();
      }
    });

    for (const h of HANDLERS) {
      it(`refuses ${role}'s /mcp tools/call to ${h}`, async () => {
        resetCalls();
        const client = await mcpClient(wsId);
        try {
          const result = await client.callTool({ name: `${WIRED}__${h}`, arguments: {} });
          expect(result.isError).toBe(true);
          expect(result.structuredContent).toEqual(refusal(WIRED, h));
        } finally {
          await client.close();
        }
        expect(ran(wsId, WIRED)).toEqual([]);
      });

      it(`refuses ${role}'s REST tools/call to ${h}`, async () => {
        resetCalls();
        const res = await fetch(`${baseUrl}/v1/workspaces/${wsId}/tools/call`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ server: WIRED, tool: h, arguments: {} }),
        });
        const result = await readJson<ToolCallResponse>(res);
        expect(result.structuredContent).toEqual(refusal(WIRED, h));
        expect(ran(wsId, WIRED)).toEqual([]);
      });

      it(`refuses ${role}'s chat router call to ${h}`, async () => {
        resetCalls();
        const router = new IdentityToolRouter({
          caller: "chat",
          identityId: DEV_IDENTITY.id,
          workspaceId: wsId,
          runtime,
        });
        const result = await router.execute({ id: "c1", name: `${WIRED}__${h}`, input: {} });
        expect(result.structuredContent).toEqual(refusal(WIRED, h));
        expect(ran(wsId, WIRED)).toEqual([]);
      });
    }
  }
});
