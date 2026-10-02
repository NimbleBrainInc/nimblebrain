import type { ToolCallResponse } from "../../src/api/schemas/responses.ts";
import { readJson } from "../helpers/http.ts";
/**
 * Connector `admin_tools`: a tool the catalog names there is listed for and
 * callable by a workspace admin only, on every door.
 *
 * One `Runtime`, one catalog entry, two workspaces holding the same connector:
 * the dev identity is `admin` of one and `member` of the other, so each door is
 * driven twice by the same caller and only the membership role differs.
 *
 * Doors covered: the chat engine (`IdentityToolRouter`, through `runtime.chat`
 * and an automation-style `executeTask`), `/mcp/<wsId>` `tools/list` and
 * `tools/call`, REST `tools/call` (`ToolRegistry.execute`), and the
 * unattended dispatch. Plus the two things the gate must NOT touch: the
 * kernel's own lifecycle and hook-registration calls, and a server's own claim
 * about which of its tools are admin-only. And the `audit.admin_tool_call` line
 * each door's call to a declared tool writes.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV4, LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { type ServerHandle, startServer } from "../../src/api/server.ts";
import { CATALOG_DIR_ENV } from "../../src/connectors/catalog/catalog.ts";
import { textContent } from "../../src/engine/content-helpers.ts";
import type { AdminToolCallPayload } from "../../src/engine/schemas/events.ts";
import type { EventSink } from "../../src/engine/types.ts";
import { ensureHooks } from "../../src/hooks/reconcile.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { notifyReady } from "../../src/lifecycle/notify.ts";
import { dispatchUnattended } from "../../src/orchestrator/unattended-dispatch.ts";
import { REDACTED_ARGUMENT } from "../../src/permissions/admin-tools.ts";
import { IdentityToolRouter } from "../../src/runtime/identity-tool-router.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { stopAllToolSurfaceWatches } from "../../src/tools/connector-surface.ts";
import { defineInProcessApp, type InProcessTool } from "../../src/tools/in-process-app.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel, type EchoModelResponse } from "../helpers/echo-model.ts";
import { seedWorkspace } from "../helpers/test-workspace.ts";

const ADMIN_WS = "ws_helix";
const MEMBER_WS = "ws_orbit";
/** `slugifyServerName("ai.acme/crm")`, the source name an install records. */
const SERVER = "ai-acme-crm";
const CONFIGURE = `${SERVER}__configure`;
const SEARCH = `${SERVER}__search`;

const testDir = join(tmpdir(), `nb-admin-tools-${Date.now()}`);
const catalogDir = join(testDir, "catalog");

/**
 * The catalog entry. `configure`, the lifecycle handler and the hook
 * registration tool are declared; `ghost` is declared and never advertised;
 * `search` is not declared.
 */
const CATALOG_YAML = `servers:
  - name: ai.acme/crm
    title: Acme CRM
    description: Test connector with admin-only tools
    version: "1.0.0"
    remotes:
      - type: streamable-http
        url: https://crm.acme.test/mcp
    _meta:
      ai.nimblebrain/connector:
        auth: dcr
      ai.nimblebrain/host:
        host_version: "1.5"
        admin_tools: [configure, workspace_ready, set_webhook_url, ghost]
        lifecycle:
          on_ready: workspace_ready
        hooks:
          - vendor: acme
            route: /ingest/acme
            register_tool: set_webhook_url
`;

/** Per-workspace record of what the connector's server actually ran. */
const calls = new Map<string, string[]>();

function buildSource(wsId: string) {
  const log: string[] = [];
  calls.set(wsId, log);
  const tool = (
    name: string,
    meta?: Record<string, unknown>,
    properties: Record<string, unknown> = {},
  ): InProcessTool => ({
    name,
    description: `Acme ${name}.`,
    inputSchema: { type: "object", properties },
    ...(meta ? { meta } : {}),
    handler: async () => {
      log.push(name);
      return { content: textContent(`${name} ok`), isError: false };
    },
  });
  return defineInProcessApp(
    {
      name: SERVER,
      version: "1.0.0",
      tools: [
        // The server claims, in its own tool `_meta`, the opposite of what the
        // catalog says. Neither claim may move the gate.
        tool(
          "configure",
          { "ai.nimblebrain/host": { admin_tools: [] } },
          { mode: { type: "string" }, api_key: { type: "string", writeOnly: true } },
        ),
        tool("search", { "ai.nimblebrain/host": { admin_tools: ["search"] } }),
        tool("workspace_ready"),
        tool("set_webhook_url", undefined, {
          vendor: { type: "string" },
          url: { type: "string" },
        }),
      ],
    },
    new NoopEventSink(),
  );
}

/** The tool names each model call was offered, most recent last. */
const offered: string[][] = [];
const responses: EchoModelResponse[] = [];

/**
 * An echo model that records the tool list it is handed and answers each call
 * with the next queued response. `createEchoModel` copies its queue at
 * construction, so a response queued mid-suite is served by a fresh one.
 */
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

/** Every `audit.admin_tool_call` line the runtime wrote, oldest first. */
const audited: AdminToolCallPayload[] = [];
const auditSink: EventSink = {
  emit: (event) => {
    if (event.type === "audit.admin_tool_call") audited.push(event.data as AdminToolCallPayload);
  },
};

let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;
let savedCatalogDir: string | undefined;

beforeAll(async () => {
  mkdirSync(catalogDir, { recursive: true });
  writeFileSync(join(catalogDir, "acme.yaml"), CATALOG_YAML);
  savedCatalogDir = process.env[CATALOG_DIR_ENV];
  process.env[CATALOG_DIR_ENV] = catalogDir;

  runtime = await Runtime.start({
    identityProvider: devProvider,
    model: { provider: "custom", adapter: recordingModel() },
    logging: { disabled: true },
    events: [auditSink],
    workDir: testDir,
  });

  const wsStore = runtime.getWorkspaceStore();
  await seedWorkspace(wsStore, ADMIN_WS, { name: "Helix" });
  await wsStore.addMember(ADMIN_WS, DEV_IDENTITY.id, "admin");
  await seedWorkspace(wsStore, MEMBER_WS, { name: "Orbit" });
  await wsStore.addMember(MEMBER_WS, DEV_IDENTITY.id, "member");

  for (const wsId of [ADMIN_WS, MEMBER_WS]) {
    const source = buildSource(wsId);
    await source.start();
    (await runtime.ensureWorkspaceRegistry(wsId)).addSource(source);
  }

  handle = startServer({ runtime, port: 0 });
  baseUrl = `http://localhost:${handle.port}`;
});

afterAll(async () => {
  handle.stop(true);
  stopAllToolSurfaceWatches();
  await runtime.shutdown();
  if (savedCatalogDir === undefined) delete process.env[CATALOG_DIR_ENV];
  else process.env[CATALOG_DIR_ENV] = savedCatalogDir;
  rmSync(testDir, { recursive: true, force: true });
});

function ran(wsId: string): string[] {
  return calls.get(wsId) ?? [];
}

function resetCalls(): void {
  for (const log of calls.values()) log.length = 0;
}

async function mcpClient(wsId: string): Promise<Client> {
  const client = new Client({ name: "admin-tools-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/${wsId}`)));
  return client;
}

async function restCall(wsId: string, tool: string) {
  const res = await fetch(`${baseUrl}/v1/workspaces/${wsId}/tools/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ server: SERVER, tool, arguments: {} }),
  });
  return await readJson<ToolCallResponse>(res);
}

describe("the chat engine door (IdentityToolRouter)", () => {
  it("refuses a member a declared tool before the server runs it", async () => {
    resetCalls();
    const router = new IdentityToolRouter({
      caller: "chat",
      identityId: DEV_IDENTITY.id,
      workspaceId: MEMBER_WS,
      runtime,
    });
    const result = await router.execute({ id: "c1", name: CONFIGURE, input: {} });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: "workspace_admin_required",
      connector: SERVER,
      tool: "configure",
    });
    expect(ran(MEMBER_WS)).toEqual([]);
  });

  it("lets a member call an undeclared tool, even one the server claims is admin-only", async () => {
    resetCalls();
    const router = new IdentityToolRouter({
      caller: "chat",
      identityId: DEV_IDENTITY.id,
      workspaceId: MEMBER_WS,
      runtime,
    });
    const result = await router.execute({ id: "c2", name: SEARCH, input: {} });
    expect(result.isError).toBe(false);
    expect(ran(MEMBER_WS)).toEqual(["search"]);
  });

  it("lets an admin call a declared tool", async () => {
    resetCalls();
    const router = new IdentityToolRouter({
      caller: "chat",
      identityId: DEV_IDENTITY.id,
      workspaceId: ADMIN_WS,
      runtime,
    });
    const result = await router.execute({ id: "c3", name: CONFIGURE, input: {} });
    expect(result.isError).toBe(false);
    expect(ran(ADMIN_WS)).toEqual(["configure"]);
  });

  it("leaves the declared tool out of a member's nb__search and in an admin's", async () => {
    const searchIn = async (wsId: string): Promise<string> => {
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
      return result.toolCalls.find((c) => c.name === "nb__search")?.output ?? "";
    };
    const memberFound = await searchIn(MEMBER_WS);
    expect(memberFound).toContain(SEARCH);
    expect(memberFound).not.toContain(CONFIGURE);
    expect(await searchIn(ADMIN_WS)).toContain(CONFIGURE);
  });

  it("does not offer a member's focused-app chat the declared tool, and offers an admin's", async () => {
    // A focused app's tools are offered to the model directly, so the run's
    // own tool set (not only the searchable one) is what this observes.
    const offeredIn = async (wsId: string): Promise<string[]> => {
      offered.length = 0;
      await runtime.chat({
        identity: DEV_IDENTITY,
        message: "hello",
        workspaceId: wsId,
        appContext: { appName: "Acme CRM", serverName: SERVER },
      });
      return offered[0] ?? [];
    };
    const memberTools = await offeredIn(MEMBER_WS);
    expect(memberTools).toContain(SEARCH);
    expect(memberTools).not.toContain(CONFIGURE);
    expect(await offeredIn(ADMIN_WS)).toContain(CONFIGURE);
  });

  it("lets an admin's chat promote and call the declared tool, and never a member's", async () => {
    const promoteAndCall = async (wsId: string) => {
      responses.push(
        {
          toolCalls: [
            {
              toolCallId: "p1",
              toolName: "nb__manage_tools",
              input: JSON.stringify({ add: [CONFIGURE] }),
            },
          ],
        },
        { toolCalls: [{ toolCallId: "p2", toolName: CONFIGURE, input: "{}" }] },
      );
      await runtime.chat({ identity: DEV_IDENTITY, message: "configure it", workspaceId: wsId });
    };
    resetCalls();
    await promoteAndCall(MEMBER_WS);
    expect(ran(MEMBER_WS)).toEqual([]);
    await promoteAndCall(ADMIN_WS);
    expect(ran(ADMIN_WS)).toEqual(["configure"]);
  });
});

describe("unattended runs", () => {
  it("never runs the declared tool for an automation owned by a member", async () => {
    resetCalls();
    responses.push(
      {
        toolCalls: [
          {
            toolCallId: "a1",
            toolName: "nb__manage_tools",
            input: JSON.stringify({ add: [CONFIGURE] }),
          },
        ],
      },
      { toolCalls: [{ toolCallId: "a2", toolName: CONFIGURE, input: "{}" }] },
    );
    const result = await runtime.executeTask({
      prompt: "configure it",
      identity: DEV_IDENTITY,
      workspaceId: MEMBER_WS,
      trigger: "schedule",
    });
    const call = result.toolCalls.find((c) => c.name === CONFIGURE);
    expect(call?.ok ?? false).toBe(false);
    expect(ran(MEMBER_WS)).toEqual([]);
  });

  it("classifies an unattended dispatch by a member as workspace_admin_required", async () => {
    resetCalls();
    const outcome = await dispatchUnattended(runtime, {
      principalId: DEV_IDENTITY.id,
      workspaceId: MEMBER_WS,
      tool: CONFIGURE,
      input: {},
      reason: "route:test",
    });
    expect(outcome.outcome).toBe("denied");
    expect(outcome.classification).toBe("workspace_admin_required");
    expect(ran(MEMBER_WS)).toEqual([]);
  });

  it("admits an unattended dispatch by an admin", async () => {
    resetCalls();
    const outcome = await dispatchUnattended(runtime, {
      principalId: DEV_IDENTITY.id,
      workspaceId: ADMIN_WS,
      tool: CONFIGURE,
      input: {},
      reason: "route:test",
    });
    expect(outcome.outcome).toBe("ok");
    expect(ran(ADMIN_WS)).toEqual(["configure"]);
  });
});

describe("the /mcp/<wsId> door", () => {
  it("omits the declared tool from a member's tools/list and lists it for an admin", async () => {
    const member = await mcpClient(MEMBER_WS);
    const admin = await mcpClient(ADMIN_WS);
    try {
      const memberNames = (await member.listTools()).tools.map((t) => t.name);
      expect(memberNames).toContain(SEARCH);
      expect(memberNames).not.toContain(CONFIGURE);
      const adminNames = (await admin.listTools()).tools.map((t) => t.name);
      expect(adminNames).toContain(CONFIGURE);
    } finally {
      await member.close();
      await admin.close();
    }
  });

  it("refuses a member's tools/call and runs an admin's", async () => {
    resetCalls();
    const member = await mcpClient(MEMBER_WS);
    const admin = await mcpClient(ADMIN_WS);
    try {
      const refused = await member.callTool({ name: CONFIGURE, arguments: {} });
      expect(refused.isError).toBe(true);
      expect(refused.structuredContent).toMatchObject({ error: "workspace_admin_required" });
      expect(ran(MEMBER_WS)).toEqual([]);

      const allowed = await admin.callTool({ name: CONFIGURE, arguments: {} });
      expect(allowed.isError).toBeFalsy();
      expect(ran(ADMIN_WS)).toEqual(["configure"]);
    } finally {
      await member.close();
      await admin.close();
    }
  });
});

describe("an app's tools/call over /mcp (the iframe bridge)", () => {
  // The bridge names the calling view's server under this key.
  const fromApp = { "ai.nimblebrain/source": SERVER };

  it("refuses a member's app with workspace_admin_required and runs an admin's", async () => {
    resetCalls();
    const member = await mcpClient(MEMBER_WS);
    const admin = await mcpClient(ADMIN_WS);
    try {
      const refused = await member.callTool({ name: CONFIGURE, arguments: {}, _meta: fromApp });
      expect(refused.isError).toBe(true);
      expect(refused.structuredContent).toMatchObject({ error: "workspace_admin_required" });
      expect(ran(MEMBER_WS)).toEqual([]);

      const allowed = await admin.callTool({ name: CONFIGURE, arguments: {}, _meta: fromApp });
      expect(allowed.isError).toBeFalsy();
      expect(ran(ADMIN_WS)).toEqual(["configure"]);
    } finally {
      await member.close();
      await admin.close();
    }
  });
});

describe("the REST tools/call door (ToolRegistry.execute)", () => {
  it("refuses a member and runs an admin", async () => {
    resetCalls();
    const refused = await restCall(MEMBER_WS, "configure");
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({
      error: "workspace_admin_required",
      connector: SERVER,
      tool: "configure",
    });
    expect(ran(MEMBER_WS)).toEqual([]);

    const allowed = await restCall(ADMIN_WS, "configure");
    expect(allowed.isError).toBe(false);
    expect(ran(ADMIN_WS)).toEqual(["configure"]);
  });
});

describe("kernel-originated calls", () => {
  it("delivers on_ready to a declared admin tool in a workspace where the caller is a member", async () => {
    resetCalls();
    await notifyReady(runtime.getLifecycleNotifyDeps(), MEMBER_WS, SERVER, "install");
    expect(ran(MEMBER_WS)).toEqual(["workspace_ready"]);
  });

  it("hands a hook URL to a declared admin register_tool", async () => {
    resetCalls();
    await ensureHooks(
      { ...runtime.getHookReconcileDeps(), identity: { tid: "tenant-a", key: randomBytes(32) } },
      MEMBER_WS,
      SERVER,
    );
    expect(ran(MEMBER_WS)).toEqual(["set_webhook_url"]);
  });

  it("warns at install about kernel-called and unadvertised declared names", async () => {
    const warnings = await runtime.adminToolsContractWarnings(MEMBER_WS, SERVER);
    expect(warnings.some((w) => w.includes('"workspace_ready"') && w.includes("on_ready"))).toBe(
      true,
    );
    expect(
      warnings.some((w) => w.includes('"set_webhook_url"') && w.includes("register_tool")),
    ).toBe(true);
    expect(warnings.some((w) => w.includes('"ghost"') && w.includes("not among"))).toBe(true);
    expect(warnings.some((w) => w.includes('"configure"'))).toBe(false);
  });
});

describe("the audit.admin_tool_call line", () => {
  const ARGS = { mode: "live", api_key: "sk-test-secret" };

  /** The lines written while `act` ran. */
  async function linesFrom(act: () => Promise<unknown>): Promise<AdminToolCallPayload[]> {
    const start = audited.length;
    await act();
    return audited.slice(start);
  }

  it("records an admitted chat call with its caller, person and redacted arguments", async () => {
    const router = new IdentityToolRouter({
      caller: "chat",
      identityId: DEV_IDENTITY.id,
      workspaceId: ADMIN_WS,
      runtime,
    });
    const lines = await linesFrom(() => router.execute({ id: "u1", name: CONFIGURE, input: ARGS }));
    expect(lines).toEqual([
      {
        workspaceId: ADMIN_WS,
        userId: DEV_IDENTITY.id,
        connector: SERVER,
        tool: "configure",
        caller: "chat",
        outcome: "admitted",
        arguments: { mode: "live", api_key: REDACTED_ARGUMENT },
      },
    ]);
  });

  it("records a refused call too", async () => {
    const router = new IdentityToolRouter({
      caller: "chat",
      identityId: DEV_IDENTITY.id,
      workspaceId: MEMBER_WS,
      runtime,
    });
    const lines = await linesFrom(() => router.execute({ id: "u2", name: CONFIGURE, input: ARGS }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ workspaceId: MEMBER_WS, outcome: "refused" });
  });

  it("writes nothing for a tool the catalog does not declare", async () => {
    const router = new IdentityToolRouter({
      caller: "chat",
      identityId: DEV_IDENTITY.id,
      workspaceId: ADMIN_WS,
      runtime,
    });
    expect(await linesFrom(() => router.execute({ id: "u3", name: SEARCH, input: {} }))).toEqual(
      [],
    );
  });

  it("names the conversation a chat's call came from", async () => {
    responses.push({
      toolCalls: [{ toolCallId: "u4", toolName: CONFIGURE, input: JSON.stringify(ARGS) }],
    });
    const lines = await linesFrom(() =>
      runtime.chat({ identity: DEV_IDENTITY, message: "configure it", workspaceId: ADMIN_WS }),
    );
    const line = lines.find((l) => l.tool === "configure");
    expect(line?.caller).toBe("chat");
    expect(typeof line?.conversationId).toBe("string");
  });

  it("records an unattended run as automation", async () => {
    responses.push({
      toolCalls: [{ toolCallId: "u5", toolName: CONFIGURE, input: JSON.stringify(ARGS) }],
    });
    const lines = await linesFrom(() =>
      runtime.executeTask({
        prompt: "configure it",
        identity: DEV_IDENTITY,
        workspaceId: ADMIN_WS,
        trigger: "schedule",
        allowedTools: [CONFIGURE],
      }),
    );
    expect(lines.map((l) => [l.caller, l.outcome])).toEqual([["automation", "admitted"]]);
  });

  it("records an unattended dispatch as dispatch", async () => {
    const lines = await linesFrom(() =>
      dispatchUnattended(runtime, {
        principalId: DEV_IDENTITY.id,
        workspaceId: ADMIN_WS,
        tool: CONFIGURE,
        input: ARGS,
        reason: "route:test",
      }),
    );
    expect(lines.map((l) => [l.caller, l.outcome])).toEqual([["dispatch", "admitted"]]);
  });

  it("tells an app's call from another /mcp client's, once per call", async () => {
    const admin = await mcpClient(ADMIN_WS);
    const member = await mcpClient(MEMBER_WS);
    const fromApp = { "ai.nimblebrain/source": SERVER };
    try {
      const lines = await linesFrom(async () => {
        await admin.callTool({ name: CONFIGURE, arguments: ARGS });
        await admin.callTool({ name: CONFIGURE, arguments: ARGS, _meta: fromApp });
        await member.callTool({ name: CONFIGURE, arguments: ARGS, _meta: fromApp });
      });
      expect(lines.map((l) => [l.caller, l.outcome, l.arguments.api_key])).toEqual([
        ["mcp", "admitted", REDACTED_ARGUMENT],
        ["app", "admitted", REDACTED_ARGUMENT],
        ["app", "refused", REDACTED_ARGUMENT],
      ]);
    } finally {
      await admin.close();
      await member.close();
    }
  });

  it("records a REST call as api", async () => {
    const lines = await linesFrom(() => restCall(ADMIN_WS, "configure"));
    expect(lines.map((l) => [l.caller, l.outcome])).toEqual([["api", "admitted"]]);
  });

  it("writes nothing for the kernel's own call to a declared handler", async () => {
    expect(
      await linesFrom(() =>
        notifyReady(runtime.getLifecycleNotifyDeps(), MEMBER_WS, SERVER, "install"),
      ),
    ).toEqual([]);
  });
});

describe("a malformed admin_tools declaration", () => {
  // A catalog typo must not open the connector's tools to members: the entry
  // stays in the catalog and every tool on it becomes admin-only.
  it("refuses a member every tool on the connector and runs an admin's", async () => {
    writeFileSync(
      join(catalogDir, "acme.yaml"),
      CATALOG_YAML.replace(
        "admin_tools: [configure, workspace_ready, set_webhook_url, ghost]",
        "admin_tools: configure",
      ),
    );
    runtime.getConnectorCatalog().resetCache();
    resetCalls();
    const member = await mcpClient(MEMBER_WS);
    const admin = await mcpClient(ADMIN_WS);
    try {
      const memberNames = (await member.listTools()).tools.map((t) => t.name);
      expect(memberNames).not.toContain(SEARCH);
      expect(memberNames).not.toContain(CONFIGURE);

      const refused = await member.callTool({ name: SEARCH, arguments: {} });
      expect(refused.structuredContent).toMatchObject({ error: "workspace_admin_required" });
      expect(ran(MEMBER_WS)).toEqual([]);

      const allowed = await admin.callTool({ name: SEARCH, arguments: {} });
      expect(allowed.isError).toBeFalsy();
      expect(ran(ADMIN_WS)).toEqual(["search"]);

      const warnings = await runtime.adminToolsContractWarnings(MEMBER_WS, SERVER);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("every tool");
    } finally {
      await member.close();
      await admin.close();
      writeFileSync(join(catalogDir, "acme.yaml"), CATALOG_YAML);
      runtime.getConnectorCatalog().resetCache();
    }
  });
});
