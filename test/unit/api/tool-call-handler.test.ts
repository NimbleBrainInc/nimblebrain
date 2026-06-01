import { describe, expect, it } from "bun:test";
import { handleResourceProxy, handleToolCall } from "../../../src/api/handlers.ts";
import type { ResolvedFeatures } from "../../../src/config/features.ts";
import type { Runtime } from "../../../src/runtime/runtime.ts";
import type { UserIdentity } from "../../../src/identity/provider.ts";

// Cross-workspace coverage for the OTHER two endpoints the qualified-name
// resolver was wired into (handleReadResource is covered separately). A
// qualified `ws_<id>-<source>` names its own workspace: it must resolve there
// by membership (not the ambient X-Workspace-Id) and address the registry by
// the BARE source name. handleToolCall additionally normalizes the tool name.

const features = {} as unknown as ResolvedFeatures; // our tool isn't feature-mapped → always enabled
const identityU1 = { id: "u1", orgRole: "member" } as unknown as UserIdentity;

// ── handleToolCall ──────────────────────────────────────────────────

interface ToolCallStub {
  memberOf?: string[];
  sourceName?: string;
  toolNames?: string[];
}

function makeToolCallRuntime(opts: ToolCallStub = {}): { runtime: Runtime; executed: string[] } {
  const memberOf = opts.memberOf ?? [];
  const sourceName = opts.sourceName ?? "synapse-collateral";
  const toolNames = opts.toolNames ?? [`${sourceName}__preview`];
  const executed: string[] = [];
  const source = {
    name: sourceName,
    tools: async () => toolNames.map((name) => ({ name })),
  };
  const registry = {
    hasSource: (n: string) => n === sourceName,
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
    ensureWorkspaceRegistry: async () => registry,
  } as unknown as Runtime;
  return { runtime, executed };
}

function toolReq(body: unknown): Request {
  return new Request("http://x/v1/tools/call", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("handleToolCall — qualified cross-workspace server", () => {
  it("resolves to the owning workspace (ignoring X-Workspace-Id) and normalizes the tool name", async () => {
    const { runtime, executed } = makeToolCallRuntime({ memberOf: ["ws_nimblebrain_shared"] });
    const res = await handleToolCall(
      toolReq({ server: "ws_nimblebrain_shared-synapse-collateral", tool: "preview" }),
      runtime,
      features,
      // Ambient workspace is the user's PERSONAL ws — not where the tool lives.
      { workspaceId: "ws_user_u1", identity: identityU1 },
    );
    expect(res.status).toBe(200);
    // Bare tool ("preview") normalized to the registry's `<bareSource>__<tool>`.
    expect(executed).toEqual(["synapse-collateral__preview"]);
  });

  it("normalizes a source-prefixed tool name", async () => {
    const { runtime, executed } = makeToolCallRuntime({ memberOf: ["ws_nimblebrain_shared"] });
    await handleToolCall(
      toolReq({
        server: "ws_nimblebrain_shared-synapse-collateral",
        tool: "synapse-collateral__preview",
      }),
      runtime,
      features,
      { workspaceId: "ws_user_u1", identity: identityU1 },
    );
    expect(executed).toEqual(["synapse-collateral__preview"]);
  });

  it("normalizes a fully-qualified tool name (strips the ws_<id>- server prefix)", async () => {
    const { runtime, executed } = makeToolCallRuntime({ memberOf: ["ws_nimblebrain_shared"] });
    await handleToolCall(
      toolReq({
        server: "ws_nimblebrain_shared-synapse-collateral",
        tool: "ws_nimblebrain_shared-synapse-collateral__preview",
      }),
      runtime,
      features,
      { workspaceId: "ws_user_u1", identity: identityU1 },
    );
    expect(executed).toEqual(["synapse-collateral__preview"]);
  });

  it("403s a non-member of the named workspace", async () => {
    const { runtime, executed } = makeToolCallRuntime({ memberOf: ["ws_some_other"] });
    const res = await handleToolCall(
      toolReq({ server: "ws_nimblebrain_shared-synapse-collateral", tool: "preview" }),
      runtime,
      features,
      { workspaceId: "ws_user_u1", identity: identityU1 },
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("workspace_access_denied");
    expect(executed).toEqual([]);
  });

  it("401s a qualified call with no identity", async () => {
    const { runtime } = makeToolCallRuntime({ memberOf: ["ws_nimblebrain_shared"] });
    const res = await handleToolCall(
      toolReq({ server: "ws_nimblebrain_shared-synapse-collateral", tool: "preview" }),
      runtime,
      features,
      { workspaceId: "ws_nimblebrain_shared" },
    );
    expect(res.status).toBe(401);
  });

  it("keeps the workspace_required contract for a bare source with no workspace", async () => {
    // Regression guard: the shared resolver must not silently downgrade this
    // endpoint's original `workspace_required` error to `bad_request`.
    const { runtime } = makeToolCallRuntime();
    const res = await handleToolCall(toolReq({ server: "calendar", tool: "main" }), runtime, features, {
      identity: identityU1,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("workspace_required");
  });
});

// ── handleResourceProxy (GET /v1/apps/:name/resources/*) ────────────

function makeProxyRuntime(opts: { memberOf?: string[]; sourceName?: string }): {
  runtime: Runtime;
  calls: Array<{ server: string; uri: string; wsId: string }>;
} {
  const memberOf = opts.memberOf ?? [];
  const sourceName = opts.sourceName ?? "synapse-collateral";
  const calls: Array<{ server: string; uri: string; wsId: string }> = [];
  const registry = { hasSource: (n: string) => n === sourceName };
  const runtime = {
    getIdentitySource: () => undefined,
    getWorkspaceStore: () => ({
      getWorkspacesForUser: async () => memberOf.map((id) => ({ id })),
    }),
    ensureWorkspaceRegistry: async () => registry,
    readAppResource: async (server: string, uri: string, wsId: string) => {
      calls.push({ server, uri, wsId });
      return { text: "ok", mimeType: "text/plain" };
    },
  } as unknown as Runtime;
  return { runtime, calls };
}

describe("handleResourceProxy — qualified cross-workspace app", () => {
  it("resolves to the owning workspace and reads via the bare source name", async () => {
    const { runtime, calls } = makeProxyRuntime({ memberOf: ["ws_nimblebrain_shared"] });
    const res = await handleResourceProxy(
      "ws_nimblebrain_shared-synapse-collateral",
      "main", // not "primary" — avoids the lifecycle/placement lookup
      runtime,
      "ws_user_u1", // ambient personal ws, must be overridden by the name
      identityU1,
    );
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ server: "synapse-collateral", uri: "main", wsId: "ws_nimblebrain_shared" }]);
  });

  it("403s a non-member of the named workspace", async () => {
    const { runtime, calls } = makeProxyRuntime({ memberOf: ["ws_some_other"] });
    const res = await handleResourceProxy(
      "ws_nimblebrain_shared-synapse-collateral",
      "main",
      runtime,
      "ws_user_u1",
      identityU1,
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("workspace_access_denied");
    expect(calls).toEqual([]);
  });
});
