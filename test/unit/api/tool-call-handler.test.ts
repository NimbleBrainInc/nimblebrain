import { describe, expect, it } from "bun:test";
import { handleResourceProxy, handleToolCall } from "../../../src/api/handlers.ts";
import type { ApiErrorBody } from "../../../src/api/schemas/responses.ts";
import type { ResolvedFeatures } from "../../../src/config/features.ts";
import type { UserIdentity } from "../../../src/identity/provider.ts";
import type { Runtime } from "../../../src/runtime/runtime.ts";
import { readJson } from "../../helpers/http.ts";

// On REST the workspace is the one in the URL path (ADR-0037). A qualified
// `ws_<id>-<name>` server, app or tool is refused with a 400 — never routed to
// the workspace it names, never stripped to its bare remainder — and a bare
// name resolves in the URL's workspace. handleReadResource is covered in
// read-resource-handler.test.ts.

const features = {} as unknown as ResolvedFeatures; // our tool isn't feature-mapped → always enabled
const identityU1 = { id: "u1", orgRole: "member" } as unknown as UserIdentity;

// ── handleToolCall ──────────────────────────────────────────────────

interface ToolCallStub {
  memberOf?: string[];
  sourceName?: string;
  toolNames?: string[];
  /** Installed but unregistered until revived — the boot-race shape. */
  recoverable?: string;
}

function makeToolCallRuntime(opts: ToolCallStub = {}): {
  runtime: Runtime;
  executed: string[];
  /** Workspaces whose registry the handler opened, in order. */
  registryWs: string[];
} {
  const memberOf = opts.memberOf ?? [];
  const sourceName = opts.sourceName ?? "synapse-collateral";
  const toolNames = opts.toolNames ?? [`${sourceName}__preview`];
  const executed: string[] = [];
  const registryWs: string[] = [];
  const source = {
    name: sourceName,
    tools: async () => toolNames.map((name) => ({ name })),
  };
  const present = new Set(opts.recoverable ? [] : [sourceName]);
  const registry = {
    hasSource: (n: string) => present.has(n),
    hasEstablishedSource: (n: string) => present.has(n),
    getSources: () => [source],
    execute: async (call: { name: string }) => {
      executed.push(call.name);
      return { content: [{ type: "text", text: "ok" }], structuredContent: {}, isError: false };
    },
  };
  const runtime = {
    getIdentitySource: () => undefined,
    getWorkspaceStore: () => ({
      getWorkspacesForUser: async () => memberOf.map((id) => ({ id })),
    }),
    ensureWorkspaceRegistry: async (wsId: string) => {
      registryWs.push(wsId);
      return registry;
    },
    recoverWorkspaceSource: async (_wsId: string, name: string) => {
      if (present.has(name)) return true;
      if (name !== opts.recoverable) return false;
      present.add(name);
      return true;
    },
  } as unknown as Runtime;
  return { runtime, executed, registryWs };
}

function toolReq(body: unknown): Request {
  return new Request("http://nb.example.com/v1/workspaces/ws_user_u1/tools/call", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("handleToolCall — the workspace is the one in the URL", () => {
  it("refuses a qualified server with a 400 naming the bare server, and runs nothing", async () => {
    const { runtime, executed, registryWs } = makeToolCallRuntime({ memberOf: ["ws_tenant_a"] });
    const res = await handleToolCall(
      toolReq({ server: "ws_tenant_a-synapse-collateral", tool: "preview" }),
      runtime,
      features,
      // The caller is a member of the named workspace; the name is still refused.
      { workspaceId: "ws_user_u1", identity: identityU1 },
    );
    expect(res.status).toBe(400);
    const body = await readJson<ApiErrorBody>(res);
    expect(body.error).toBe("bad_request");
    expect(body.message).toContain("uses the retired ws_<id>- server-name form");
    expect(body.message).toContain('"synapse-collateral"');
    expect(body.details).toEqual({
      server: "ws_tenant_a-synapse-collateral",
      reason: "legacy_namespaced_form",
    });
    expect(registryWs).toEqual([]);
    expect(executed).toEqual([]);
  });

  it("refuses a qualified tool name with a 400, even beside a bare server", async () => {
    const { runtime, executed } = makeToolCallRuntime();
    const res = await handleToolCall(
      toolReq({ server: "synapse-collateral", tool: "ws_tenant_a-synapse-collateral__preview" }),
      runtime,
      features,
      { workspaceId: "ws_user_u1", identity: identityU1 },
    );
    expect(res.status).toBe(400);
    const body = await readJson<ApiErrorBody>(res);
    expect(body.message).toContain("uses the retired ws_<id>- tool-name form");
    expect(body.details.reason).toBe("legacy_namespaced_form");
    expect(executed).toEqual([]);
  });

  it("refuses a malformed ws_ server as a bad request", async () => {
    const { runtime, executed } = makeToolCallRuntime();
    const res = await handleToolCall(
      toolReq({ server: "ws_BAD ID-synapse-collateral", tool: "preview" }),
      runtime,
      features,
      { workspaceId: "ws_user_u1", identity: identityU1 },
    );
    expect(res.status).toBe(400);
    expect(executed).toEqual([]);
  });

  it("revives an installed-but-unregistered source in the URL's workspace instead of 404ing the tool", async () => {
    // A connector whose endpoint was unreachable at boot is installed but
    // absent from the registry. Membership alone would report the tool missing.
    const { runtime, executed, registryWs } = makeToolCallRuntime({
      recoverable: "synapse-collateral",
    });
    const res = await handleToolCall(
      toolReq({ server: "synapse-collateral", tool: "preview" }),
      runtime,
      features,
      { workspaceId: "ws_user_u1", identity: identityU1 },
    );
    expect(res.status).toBe(200);
    expect(registryWs).toEqual(["ws_user_u1"]);
    expect(executed).toEqual(["synapse-collateral__preview"]);
  });

  it("normalizes a source-prefixed tool name", async () => {
    const { runtime, executed } = makeToolCallRuntime();
    await handleToolCall(
      toolReq({ server: "synapse-collateral", tool: "synapse-collateral__preview" }),
      runtime,
      features,
      { workspaceId: "ws_user_u1", identity: identityU1 },
    );
    expect(executed).toEqual(["synapse-collateral__preview"]);
  });

  it("resolves a bare source in the workspace from the URL", async () => {
    const { runtime, executed, registryWs } = makeToolCallRuntime({ sourceName: "calendar" });
    const res = await handleToolCall(
      toolReq({ server: "calendar", tool: "preview" }),
      runtime,
      features,
      {
        workspaceId: "ws_user_u1",
        identity: identityU1,
      },
    );
    expect(res.status).toBe(200);
    expect(registryWs).toEqual(["ws_user_u1"]);
    expect(executed).toEqual(["calendar__preview"]);
  });
});

// ── handleResourceProxy (GET /v1/workspaces/:wsId/apps/:name/resources/*) ──

function makeProxyRuntime(opts: {
  memberOf?: string[];
  sourceName?: string;
  /** Installed but unregistered until revived — the boot-race shape. */
  recoverable?: string;
}): {
  runtime: Runtime;
  calls: Array<{ server: string; uri: string; wsId: string }>;
  recoverCalls: Array<{ wsId: string; name: string }>;
} {
  const memberOf = opts.memberOf ?? [];
  const sourceName = opts.sourceName ?? "synapse-collateral";
  const present = new Set(opts.recoverable ? [] : [sourceName]);
  const calls: Array<{ server: string; uri: string; wsId: string }> = [];
  const recoverCalls: Array<{ wsId: string; name: string }> = [];
  const registry = {
    hasSource: (n: string) => present.has(n),
    hasEstablishedSource: (n: string) => present.has(n),
  };
  const runtime = {
    getIdentitySource: () => undefined,
    getWorkspaceStore: () => ({
      getWorkspacesForUser: async () => memberOf.map((id) => ({ id })),
    }),
    ensureWorkspaceRegistry: async () => registry,
    recoverWorkspaceSource: async (wsId: string, name: string) => {
      recoverCalls.push({ wsId, name });
      if (present.has(name)) return true;
      if (name !== opts.recoverable) return false;
      present.add(name);
      return true;
    },
    readAppResource: async (server: string, uri: string, wsId: string) => {
      calls.push({ server, uri, wsId });
      return { text: "ok", mimeType: "text/plain" };
    },
  } as unknown as Runtime;
  return { runtime, calls, recoverCalls };
}

describe("handleResourceProxy — the workspace is the one in the URL", () => {
  it("refuses a qualified app name with a 400, and reads nothing", async () => {
    const { runtime, calls, recoverCalls } = makeProxyRuntime({ memberOf: ["ws_tenant_a"] });
    const res = await handleResourceProxy(
      "ws_tenant_a-synapse-collateral",
      "main", // not "primary" — avoids the lifecycle/placement lookup
      runtime,
      "ws_user_u1",
    );
    expect(res.status).toBe(400);
    const body = await readJson<ApiErrorBody>(res);
    expect(body.message).toContain("uses the retired ws_<id>- app-name form");
    expect(body.details).toEqual({
      app: "ws_tenant_a-synapse-collateral",
      reason: "legacy_namespaced_form",
    });
    expect(calls).toEqual([]);
    expect(recoverCalls).toEqual([]);
  });

  it("reads a bare app in the URL's workspace", async () => {
    const { runtime, calls } = makeProxyRuntime({});
    const res = await handleResourceProxy("synapse-collateral", "main", runtime, "ws_tenant_a");
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ server: "synapse-collateral", uri: "main", wsId: "ws_tenant_a" }]);
  });

  it("revives an installed-but-unregistered app, addressed by the URL's workspace", async () => {
    const { runtime, calls, recoverCalls } = makeProxyRuntime({
      recoverable: "synapse-collateral",
    });
    const res = await handleResourceProxy("synapse-collateral", "main", runtime, "ws_tenant_a");
    expect(res.status).toBe(200);
    expect(recoverCalls).toEqual([{ wsId: "ws_tenant_a", name: "synapse-collateral" }]);
    expect(calls).toEqual([{ server: "synapse-collateral", uri: "main", wsId: "ws_tenant_a" }]);
  });
});
