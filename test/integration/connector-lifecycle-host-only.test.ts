import type { ToolCallResponse } from "../../src/api/schemas/responses.ts";
import { readJson } from "../helpers/http.ts";
/**
 * A connector's lifecycle handlers, bound through `ai.nimblebrain/lifecycle`, are host-only: absent from every
 * listing and refused on every door, for a workspace admin as well as a member,
 * while the host's own `on_ready` / `on_removing` calls still reach them.
 *
 * One `Runtime`, one catalog, two workspaces holding the same connectors: the
 * dev identity is `admin` of one and `member` of the other, so every door is
 * driven by both roles and only the role differs.
 *
 * Doors covered: the chat engine (`IdentityToolRouter`, `runtime.chat`, an
 * unattended `executeTask`), the unattended dispatch, `/mcp/<wsId>`
 * `tools/list` and `tools/call`, an app's `tools/call` over `/mcp`, and REST
 * `tools/call` (`ToolRegistry.execute`). Plus what the gate must NOT touch: the
 * host's own lifecycle calls, the connector's other tools, a connector that
 * marks the same tools without advertising the extension, and a personal
 * connector.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV4, LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { type ServerHandle, startServer } from "../../src/api/server.ts";
import { CATALOG_DIR_ENV } from "../../src/connectors/catalog/catalog.ts";
import { IdentityConnectorStore } from "../../src/identity/connector-store.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import {
  notifyReady,
  notifyReadyOnRunning,
  notifyRemoving,
  resetReadyNotifications,
} from "../../src/lifecycle/notify.ts";
import { dispatchUnattended } from "../../src/orchestrator/unattended-dispatch.ts";
import { IdentityToolRouter } from "../../src/runtime/identity-tool-router.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { stopAllToolSurfaceWatches } from "../../src/tools/connector-surface.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel, type EchoModelResponse } from "../helpers/echo-model.ts";
import {
  type FakeConnectorServer,
  startFakeConnectorServer,
} from "../helpers/fake-connector-server.ts";
import { type FixtureCall, marked, startLifecycleSource } from "../helpers/lifecycle-server.ts";
import { seedWorkspace } from "../helpers/test-workspace.ts";

const ADMIN_WS = "ws_003eba8844413cd9";
const MEMBER_WS = "ws_00562f536b60bccc";
const WORKSPACES = [ADMIN_WS, MEMBER_WS] as const;

/** `slugifyServerName("ai.acme/scope")`: advertises the extension and marks both handlers. */
const SCOPED = "ai-acme-scope";
/** `slugifyServerName("ai.acme/plain")`: marks the same tools, advertises nothing. */
const PLAIN = "ai-acme-plain";
const HANDLERS = ["scope_ready", "scope_removing"] as const;

const testDir = join(tmpdir(), `nb-lifecycle-host-only-${Date.now()}`);
const catalogDir = join(testDir, "catalog");

const CATALOG_YAML = `servers:
  - name: ai.acme/scope
    title: Acme Scope
    description: Test connector that binds lifecycle handlers
    version: "1.0.0"
    remotes:
      - type: streamable-http
        url: https://scope.acme.test/mcp
    _meta:
      ai.nimblebrain/connector:
        auth: dcr
  - name: ai.acme/plain
    title: Acme Plain
    description: Test connector that does not advertise the extension
    version: "1.0.0"
    remotes:
      - type: streamable-http
        url: https://plain.acme.test/mcp
    _meta:
      ai.nimblebrain/connector:
        auth: dcr
`;

/** What each connector's server actually ran, per workspace. */
const calls = new Map<string, FixtureCall[]>();

function ran(wsId: string, server: string = SCOPED): string[] {
  return (calls.get(`${wsId}/${server}`) ?? []).map((c) => c.tool);
}

function resetCalls(): void {
  for (const log of calls.values()) log.length = 0;
}

async function startSource(wsId: string, server: string) {
  const { source, calls: log } = await startLifecycleSource(server, {
    advertises: server === SCOPED,
    tools: [
      marked("scope_ready", "ready"),
      marked("scope_removing", "removing"),
      { name: "search" },
    ],
  });
  calls.set(`${wsId}/${server}`, log);
  return source;
}

/** The tool names each model call was offered, most recent last. */
const offered: string[][] = [];
const responses: EchoModelResponse[] = [];

/** An echo model that records the tools it is offered and serves queued responses. */
function recordingModel(): LanguageModelV4 {
  const echo = createEchoModel();
  return {
    ...echo,
    doStream: async (options: LanguageModelV4CallOptions) => {
      offered.push((options.tools ?? []).map((t) => t.name));
      const next = responses.shift();
      return (next ? createEchoModel({ responses: [next] }) : echo).doStream(options);
    },
  };
}

let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;
let savedCatalogDir: string | undefined;
let personalServer: FakeConnectorServer;

beforeAll(async () => {
  mkdirSync(catalogDir, { recursive: true });
  writeFileSync(join(catalogDir, "acme.yaml"), CATALOG_YAML);
  savedCatalogDir = process.env[CATALOG_DIR_ENV];
  process.env[CATALOG_DIR_ENV] = catalogDir;

  runtime = await Runtime.start({
    identityProvider: devProvider,
    languageModel: recordingModel(),
    logging: { disabled: true },
    workDir: testDir,
    // The personal connector's fake server binds on localhost.
    allowInsecureRemotes: true,
  });

  const wsStore = runtime.getWorkspaceStore();
  await seedWorkspace(wsStore, ADMIN_WS, { name: "Helix" });
  await wsStore.addMember(ADMIN_WS, DEV_IDENTITY.id, "admin");
  await seedWorkspace(wsStore, MEMBER_WS, { name: "Orbit" });
  await wsStore.addMember(MEMBER_WS, DEV_IDENTITY.id, "member");

  for (const wsId of WORKSPACES) {
    const registry = await runtime.ensureWorkspaceRegistry(wsId);
    for (const server of [SCOPED, PLAIN]) {
      registry.addSource(await startSource(wsId, server));
    }
    // Installed at the catalog entries' URLs, as a catalog connector is.
    await wsStore.update(wsId, {
      connectors: [
        { url: "https://scope.acme.test/mcp", serverName: SCOPED },
        { url: "https://plain.acme.test/mcp", serverName: PLAIN },
      ],
    });
  }

  // A personal connector under the catalog connector's own name, granted to
  // the member workspace: the gate is a workspace-connector gate only.
  personalServer = startFakeConnectorServer([...HANDLERS]);
  await new IdentityConnectorStore({ workDir: testDir }).add(DEV_IDENTITY.id, {
    url: personalServer.url,
    serverName: SCOPED,
    ui: null,
  });
  await runtime.getPermissionStore().grantConnector(DEV_IDENTITY.id, SCOPED, MEMBER_WS);

  handle = startServer({ runtime, port: 0 });
  baseUrl = `http://localhost:${handle.port}`;
});

afterAll(async () => {
  handle.stop(true);
  stopAllToolSurfaceWatches();
  resetReadyNotifications();
  await runtime.shutdown();
  personalServer.close();
  if (savedCatalogDir === undefined) delete process.env[CATALOG_DIR_ENV];
  else process.env[CATALOG_DIR_ENV] = savedCatalogDir;
  rmSync(testDir, { recursive: true, force: true });
});

async function mcpClient(wsId: string): Promise<Client> {
  const client = new Client({ name: "lifecycle-host-only-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/${wsId}`)));
  return client;
}

function refusal(server: string, tool: string) {
  return { error: "host_only_tool", connector: server, tool };
}

describe("listings", () => {
  for (const wsId of WORKSPACES) {
    const role = wsId === ADMIN_WS ? "an admin" : "a member";

    it(`leaves both handlers out of ${role}'s model tool list`, async () => {
      offered.length = 0;
      await runtime.chat({
        identity: DEV_IDENTITY,
        message: "hello",
        workspaceId: wsId,
        appContext: { appName: "Acme Scope", serverName: SCOPED },
      });
      const tools = offered[0] ?? [];
      expect(tools).toContain(`${SCOPED}__search`);
      for (const h of HANDLERS) expect(tools).not.toContain(`${SCOPED}__${h}`);
    });

    it(`leaves both handlers out of ${role}'s nb__search`, async () => {
      responses.push({
        toolCalls: [
          {
            toolCallId: "s1",
            toolName: "nb__search",
            input: JSON.stringify({ scope: "tools", query: "acme" }),
          },
        ],
      });
      const result = await runtime.chat({
        identity: DEV_IDENTITY,
        message: "find acme tools",
        workspaceId: wsId,
      });
      const found = result.toolCalls.find((c) => c.name === "nb__search")?.output ?? "";
      expect(found).toContain(`${SCOPED}__search`);
      // The member's personal connector of the same name lists as `my_<name>`.
      for (const h of HANDLERS) {
        expect(found).not.toMatch(new RegExp(`(?<!my_)${SCOPED}__${h}`));
      }
    });

    it(`leaves both handlers out of ${role}'s /mcp tools/list`, async () => {
      const client = await mcpClient(wsId);
      try {
        const names = (await client.listTools()).tools.map((t) => t.name);
        expect(names).toContain(`${SCOPED}__search`);
        for (const h of HANDLERS) expect(names).not.toContain(`${SCOPED}__${h}`);
      } finally {
        await client.close();
      }
    });
  }
});

describe("dispatch doors", () => {
  for (const wsId of WORKSPACES) {
    const role = wsId === ADMIN_WS ? "an admin" : "a member";

    for (const h of HANDLERS) {
      const name = `${SCOPED}__${h}`;

      it(`refuses ${role}'s chat router call to ${h}`, async () => {
        resetCalls();
        const router = new IdentityToolRouter({
          caller: "chat",
          identityId: DEV_IDENTITY.id,
          workspaceId: wsId,
          runtime,
        });
        const result = await router.execute({ id: "c1", name, input: {} });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toEqual(refusal(SCOPED, h));
        const text = result.content.map((c) => ("text" in c ? c.text : "")).join("");
        expect(text).toContain("called by the host");
        expect(ran(wsId)).toEqual([]);
      });

      it(`refuses ${role}'s /mcp tools/call to ${h}`, async () => {
        resetCalls();
        const client = await mcpClient(wsId);
        try {
          const result = await client.callTool({ name, arguments: {} });
          expect(result.isError).toBe(true);
          expect(result.structuredContent).toEqual(refusal(SCOPED, h));
          expect(ran(wsId)).toEqual([]);
        } finally {
          await client.close();
        }
      });

      it(`refuses ${role}'s app bridge call to ${h}`, async () => {
        resetCalls();
        const client = await mcpClient(wsId);
        try {
          const result = await client.callTool({
            name,
            arguments: {},
            _meta: { "ai.nimblebrain/source": SCOPED },
          });
          expect(result.isError).toBe(true);
          expect(result.structuredContent).toEqual(refusal(SCOPED, h));
          expect(ran(wsId)).toEqual([]);
        } finally {
          await client.close();
        }
      });

      it(`refuses ${role}'s REST tools/call to ${h}`, async () => {
        resetCalls();
        const res = await fetch(`${baseUrl}/v1/workspaces/${wsId}/tools/call`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ server: SCOPED, tool: h, arguments: {} }),
        });
        const result = await readJson<ToolCallResponse>(res);
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toEqual(refusal(SCOPED, h));
        expect(ran(wsId)).toEqual([]);
      });

      it(`never runs ${h} in ${role}'s unattended run`, async () => {
        resetCalls();
        responses.push({ toolCalls: [{ toolCallId: "a1", toolName: name, input: "{}" }] });
        const result = await runtime.executeTask({
          prompt: "run it",
          identity: DEV_IDENTITY,
          workspaceId: wsId,
          trigger: "schedule",
          allowedTools: [name],
        });
        const call = result.toolCalls.find((c) => c.name === name);
        expect(call?.ok ?? false).toBe(false);
        expect(ran(wsId)).toEqual([]);
      });

      it(`classifies ${role}'s unattended dispatch of ${h} as host_only_tool`, async () => {
        resetCalls();
        const outcome = await dispatchUnattended(runtime, {
          principalId: DEV_IDENTITY.id,
          workspaceId: wsId,
          tool: name,
          input: {},
          reason: "route:test",
        });
        expect(outcome.outcome).toBe("denied");
        expect(outcome.classification).toBe("host_only_tool");
        expect(ran(wsId)).toEqual([]);
      });
    }
  }
});

describe("the host's own calls", () => {
  it("delivers on_ready on install and on running, and on_removing, to both handlers", async () => {
    resetCalls();
    resetReadyNotifications();
    const deps = runtime.getLifecycleNotifyDeps();
    await notifyReady(deps, MEMBER_WS, SCOPED, "install");
    expect(ran(MEMBER_WS)).toEqual(["scope_ready"]);

    notifyReadyOnRunning(deps, MEMBER_WS, SCOPED);
    // The running observer resumes in the background.
    for (let i = 0; i < 50 && ran(MEMBER_WS).length < 2; i++) await Bun.sleep(10);
    expect(ran(MEMBER_WS)).toEqual(["scope_ready", "scope_ready"]);

    await notifyRemoving(deps, MEMBER_WS, SCOPED);
    expect(ran(MEMBER_WS)).toEqual(["scope_ready", "scope_ready", "scope_removing"]);
  });
});

describe("what the gate leaves alone", () => {
  it("lets either role call the connector's other tools", async () => {
    resetCalls();
    for (const wsId of WORKSPACES) {
      const router = new IdentityToolRouter({
        caller: "chat",
        identityId: DEV_IDENTITY.id,
        workspaceId: wsId,
        runtime,
      });
      const result = await router.execute({ id: "o1", name: `${SCOPED}__search`, input: {} });
      expect(result.isError).toBe(false);
      expect(ran(wsId)).toEqual(["search"]);
    }
  });

  it("lists and runs the same names on a connector that does not advertise the extension", async () => {
    resetCalls();
    const client = await mcpClient(MEMBER_WS);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      for (const h of HANDLERS) expect(names).toContain(`${PLAIN}__${h}`);
      for (const h of HANDLERS) {
        const result = await client.callTool({ name: `${PLAIN}__${h}`, arguments: {} });
        expect(result.isError).toBeFalsy();
      }
      expect(ran(MEMBER_WS, PLAIN)).toEqual([...HANDLERS]);
    } finally {
      await client.close();
    }
  });

  it("lists and runs a personal connector's tools of the same names", async () => {
    const client = await mcpClient(MEMBER_WS);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      for (const h of HANDLERS) expect(names).toContain(`my_${SCOPED}__${h}`);
    } finally {
      await client.close();
    }
    const router = new IdentityToolRouter({
      caller: "chat",
      identityId: DEV_IDENTITY.id,
      workspaceId: MEMBER_WS,
      runtime,
    });
    for (const h of HANDLERS) {
      const result = await router.execute({ id: "p1", name: `my_${SCOPED}__${h}`, input: {} });
      expect(result.isError).toBeFalsy();
    }
  });
});
