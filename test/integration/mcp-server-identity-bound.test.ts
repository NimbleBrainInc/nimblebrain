/**
 * Integration tests for Stage 2 (cross-workspace refactor) Task 007:
 * `/mcp` sessions are identity-bound, tools are namespaced cross-workspace,
 * and `SessionMeta` no longer carries `workspaceId`.
 *
 * Each `it(...)` block names the failure mode it pins so the test surface
 * stays connected to the task spec's "Tests Required" list:
 *
 *   - Identity-only session: `initialize` succeeds with no
 *     `X-Workspace-Id` header; `tools/list` returns the cross-workspace
 *     union via the aggregator.
 *   - Cross-workspace call in one session: `ws_a/foo` and `ws_b/bar` in
 *     succession route to distinct per-source counters (`1` and `1`).
 *   - Workspace switch does not invalidate the session (Q3): the bridge's
 *     `setActiveWorkspaceId` analog firing on a different workspace
 *     leaves the `/mcp` session live; the next tool call still works.
 *   - Synapse iframe regression (Q3 follow-up): a tool call namespaced
 *     to the iframe's host workspace routes to that workspace, NOT
 *     wherever the global switcher last pointed.
 *   - Strict invariant: a bare (non-namespaced) tool name returns
 *     JSON-RPC `-32602` with `data.reason: "invalid_tool_name"` — no
 *     silent coercion to a "current workspace."
 *   - All 4 orchestrator errors map to distinct JSON-RPC responses
 *     (`UnknownNamespacedToolName`, `UnknownWorkspace`,
 *     `WorkspaceAccessDenied`, `UnknownToolSource`).
 *
 * Setup: spin up a single `Runtime` with the two-workspace fixture (a
 * shared workspace + the identity's personal workspace), each with a
 * counter-incrementing in-process MCP source. The `/mcp` endpoint is
 * dev-mode (no auth) so the SDK client doesn't need a token — the
 * `DEV_IDENTITY` is the implicit caller, a member of both workspaces.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { type ServerHandle, startServer } from "../../src/api/server.ts";
import { textContent } from "../../src/engine/content-helpers.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { defineInProcessApp, type InProcessTool } from "../../src/tools/in-process-app.ts";
import type { McpSource } from "../../src/tools/mcp-source.ts";
import { ensureUserWorkspace } from "../../src/workspace/provisioning.ts";
import { personalWorkspaceIdFor } from "../../src/workspace/workspace-store.ts";
import { createEchoModel } from "../helpers/echo-model.ts";

// ── In-process counter source ─────────────────────────────────────

function buildCounterSource(
  sourceName: string,
  toolName: string,
): { source: McpSource; callCount: () => number; reset: () => void } {
  let count = 0;
  const tool: InProcessTool = {
    name: toolName,
    description: `Counter-echo tool exposed by source "${sourceName}".`,
    inputSchema: {
      type: "object",
      properties: { echo: { type: "string" } },
    },
    handler: async (input) => {
      count += 1;
      const echo = typeof input.echo === "string" ? input.echo : "";
      return {
        content: textContent(`[${sourceName}] call #${count}: ${echo}`),
        isError: false,
      };
    },
  };
  const source = defineInProcessApp(
    {
      name: sourceName,
      version: "1.0.0",
      tools: [tool],
    },
    new NoopEventSink(),
  );
  return {
    source,
    callCount: () => count,
    reset: () => {
      count = 0;
    },
  };
}

// ── Fixture ───────────────────────────────────────────────────────

let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;
let sharedSource: ReturnType<typeof buildCounterSource>;
let personalSource: ReturnType<typeof buildCounterSource>;

const testDir = join(tmpdir(), `nb-mcp-identity-bound-${Date.now()}`);

// Stage 2 fixture: two workspaces the dev identity belongs to.
const SHARED_WS_ID = "ws_helix";
const SHARED_SOURCE_NAME = "crm";
const SHARED_TOOL_BARE = "search";
const PERSONAL_SOURCE_NAME = "gmail";
const PERSONAL_TOOL_BARE = "send";

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });

  runtime = await Runtime.start({
    model: { provider: "custom", adapter: createEchoModel() },
    noDefaultBundles: true,
    logging: { disabled: true },
    workDir: testDir,
  });

  // Shared workspace + dev membership.
  const wsStore = runtime.getWorkspaceStore();
  await wsStore.create("Helix", SHARED_WS_ID.slice(3));
  await wsStore.addMember(SHARED_WS_ID, DEV_IDENTITY.id, "admin");

  // Personal workspace via the same helper production uses on first login.
  await ensureUserWorkspace(wsStore, {
    id: DEV_IDENTITY.id,
    displayName: DEV_IDENTITY.displayName,
  });
  const personalWsId = personalWorkspaceIdFor(DEV_IDENTITY.id);

  // Per-workspace registries + counter sources.
  const sharedReg = await runtime.ensureWorkspaceRegistry(SHARED_WS_ID);
  const personalReg = await runtime.ensureWorkspaceRegistry(personalWsId);

  sharedSource = buildCounterSource(SHARED_SOURCE_NAME, SHARED_TOOL_BARE);
  personalSource = buildCounterSource(PERSONAL_SOURCE_NAME, PERSONAL_TOOL_BARE);
  await sharedSource.source.start();
  await personalSource.source.start();
  sharedReg.addSource(sharedSource.source);
  personalReg.addSource(personalSource.source);

  handle = startServer({ runtime, port: 0 });
  baseUrl = `http://localhost:${handle.port}`;
});

afterAll(async () => {
  handle.stop(true);
  await runtime.shutdown();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

// ── Helpers ───────────────────────────────────────────────────────

function personalWsId(): string {
  return personalWorkspaceIdFor(DEV_IDENTITY.id);
}

function sharedToolName(): string {
  return `${SHARED_WS_ID}-${SHARED_SOURCE_NAME}__${SHARED_TOOL_BARE}`;
}

function personalToolName(): string {
  return `${personalWsId()}-${PERSONAL_SOURCE_NAME}__${PERSONAL_TOOL_BARE}`;
}

/**
 * Build an MCP client with NO `X-Workspace-Id` header — the Stage 2
 * contract is that the header is purely advisory and routing derives
 * the target workspace from the namespaced tool name on every call.
 */
async function createIdentityBoundClient(
  opts: { extraHeaders?: Record<string, string> } = {},
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: opts.extraHeaders ?? {} },
  });
  const client = new Client({ name: "stage-2-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

// ── Tests ─────────────────────────────────────────────────────────

describe("/mcp identity-bound session (Stage 2 T007)", () => {
  it("initialize without X-Workspace-Id succeeds and tools/list returns the union (failure mode: workspace-required session)", async () => {
    const client = await createIdentityBoundClient();
    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);
      // Both workspaces' tools appear — the aggregator wins.
      expect(names).toContain(sharedToolName());
      expect(names).toContain(personalToolName());
    } finally {
      await client.close();
    }
  });

  it("identity sources surface BARE in tools/list, never ws-prefixed (one door)", async () => {
    // `conversations` is a kernel identity source: emitted bare
    // (`conversations__list`) and NOT composed into any workspace registry, so
    // it never appears as `ws_<id>-conversations__*`. This is the one-door
    // guarantee at the list level — the chat reaches conversations through the
    // identity door only, never the workspace door.
    const client = await createIdentityBoundClient();
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain("conversations__list");
      expect(names.some((n) => n.startsWith("ws_") && n.includes("conversations__"))).toBe(false);
    } finally {
      await client.close();
    }
  });

  it("cross-workspace calls in one session route to distinct sources (failure mode: dispatch-to-current-workspace)", async () => {
    sharedSource.reset();
    personalSource.reset();
    const client = await createIdentityBoundClient();
    try {
      // Two calls on the SAME session id (same MCP client = same session).
      const a = await client.callTool({
        name: sharedToolName(),
        arguments: { echo: "a" },
      });
      const b = await client.callTool({
        name: personalToolName(),
        arguments: { echo: "b" },
      });
      expect(a.isError).toBeFalsy();
      expect(b.isError).toBeFalsy();

      // Topology probe: the lesson-1 naive impl ("dispatch to current
      // workspace") would read either `2,0` or `0,2`. We assert `1,1`.
      expect(sharedSource.callCount()).toBe(1);
      expect(personalSource.callCount()).toBe(1);
    } finally {
      await client.close();
    }
  });

  it("workspace-switcher header analog does not invalidate the session (Q3)", async () => {
    sharedSource.reset();
    personalSource.reset();
    // The bridge's web-shell switcher sends an `X-Workspace-Id` on
    // settings/connectors fetches. The `/mcp` session must ignore it
    // (the header is read at debug-log only; routing derives the
    // workspace from the namespaced tool name on every call) and the
    // session must stay alive across "switches."
    //
    // We drive `/mcp` at the raw HTTP layer instead of the SDK client
    // so we can change `X-Workspace-Id` between requests on the same
    // session id without poking SDK internals.
    const initRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "x-workspace-id": SHARED_WS_ID,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "switch-test", version: "1.0.0" },
        },
      }),
    });
    expect(initRes.status).toBe(200);
    const sessionId = initRes.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    await initRes.body?.cancel();

    // Required `initialized` notification.
    await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "x-workspace-id": SHARED_WS_ID,
        "mcp-session-id": sessionId!,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });

    // Call 1: header says `ws_helix`. Namespaced name says `ws_helix`.
    const call1 = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "x-workspace-id": SHARED_WS_ID,
        "mcp-session-id": sessionId!,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: sharedToolName(), arguments: { echo: "first" } },
      }),
    });
    expect(call1.status).toBe(200);
    await call1.body?.cancel();
    expect(sharedSource.callCount()).toBe(1);

    // "Switch": same session id, header now flips to the personal
    // workspace. Adversarial: a naive implementation that reset the
    // session on header change would 404 here.
    const call2 = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "x-workspace-id": personalWsId(),
        "mcp-session-id": sessionId!,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: sharedToolName(), arguments: { echo: "after-switch" } },
      }),
    });
    expect(call2.status).toBe(200);
    await call2.body?.cancel();
    // The switcher must NOT influence routing: the namespaced name
    // still says `ws_helix`, so the shared source's counter increments
    // — NOT the personal source's.
    expect(sharedSource.callCount()).toBe(2);
    expect(personalSource.callCount()).toBe(0);

    // Tidy: terminate the session.
    await fetch(`${baseUrl}/mcp`, {
      method: "DELETE",
      headers: { "mcp-session-id": sessionId! },
    });
  });

  it("synapse iframe auto-prefix routes to the iframe's host workspace, not the switcher's pointee (Q3 follow-up)", async () => {
    sharedSource.reset();
    personalSource.reset();
    // The bridge auto-prefixes synapse-app tool calls with the
    // iframe's host workspace id. Here we simulate by constructing
    // a tool name namespaced to `ws_helix` even though the global
    // switcher (header) points elsewhere.
    const client = await createIdentityBoundClient({
      extraHeaders: { "x-workspace-id": personalWsId() }, // switcher → personal
    });
    try {
      const result = await client.callTool({
        name: sharedToolName(), // iframe-host-prefixed
        arguments: { echo: "iframe-bound" },
      });
      expect(result.isError).toBeFalsy();
      expect(sharedSource.callCount()).toBe(1);
      expect(personalSource.callCount()).toBe(0);
    } finally {
      await client.close();
    }
  });

  it("tools/call with a bare name rejects with -32602 (bare → identity scope, not silently routed to a workspace)", async () => {
    const client = await createIdentityBoundClient();
    try {
      let errorCode: number | undefined;
      let dataReason: string | undefined;
      let errorMessage: string | undefined;
      try {
        // A bare `<source>__<tool>` for a workspace app. Bare = identity
        // scope; a workspace-app source isn't a kernel identity source, so
        // it's refused (UnknownIdentitySource) — NOT silently routed to a
        // current workspace.
        await client.callTool({
          name: `${SHARED_SOURCE_NAME}__${SHARED_TOOL_BARE}`,
          arguments: { echo: "noop" },
        });
      } catch (err) {
        const e = err as { code?: number; data?: { reason?: string }; message?: string };
        errorCode = e.code;
        dataReason = e.data?.reason;
        errorMessage = e.message;
      }
      expect(errorCode).toBe(-32602);
      expect(dataReason).toBe("unknown_identity_source");
      expect(errorMessage).toContain("No identity source");
    } finally {
      await client.close();
    }
  });

  it("tools/call with a bare IDENTITY-source name dispatches through the identity door (failure mode: identity tool unreachable)", async () => {
    // The happy-path counterpart to the rejection above. `conversations` IS a
    // kernel identity source, so a bare `conversations__list` — no
    // `X-Workspace-Id`, no `ws_` prefix — routes through the identity door and
    // executes against the caller's identity. This is the exact wire call the
    // conversations iframe makes; a fresh workdir yields an empty (but
    // successful) result, proving the door is open, not just that bare names
    // parse.
    const client = await createIdentityBoundClient();
    try {
      const result = await client.callTool({ name: "conversations__list", arguments: {} });
      expect(result.isError).toBeFalsy();
    } finally {
      await client.close();
    }
  });

  it("orchestrator error mapping: UnknownWorkspace → -32602 unknown_workspace", async () => {
    const client = await createIdentityBoundClient();
    try {
      let errorCode: number | undefined;
      let dataReason: string | undefined;
      try {
        await client.callTool({
          name: "ws_nonexistent-crm__search",
          arguments: {},
        });
      } catch (err) {
        const e = err as { code?: number; data?: { reason?: string } };
        errorCode = e.code;
        dataReason = e.data?.reason;
      }
      expect(errorCode).toBe(-32602);
      expect(dataReason).toBe("unknown_workspace");
    } finally {
      await client.close();
    }
  });

  it("orchestrator error mapping: WorkspaceAccessDenied → -32602 workspace_access_denied", async () => {
    // Provision a workspace that the dev identity is NOT a member of.
    const wsStore = runtime.getWorkspaceStore();
    const FORBIDDEN_WS = "ws_forbidden";
    if (!(await wsStore.get(FORBIDDEN_WS))) {
      await wsStore.create("Forbidden", FORBIDDEN_WS.slice(3));
    }
    // Deliberately do NOT add DEV_IDENTITY as a member.

    const client = await createIdentityBoundClient();
    try {
      let errorCode: number | undefined;
      let dataReason: string | undefined;
      try {
        await client.callTool({
          name: `${FORBIDDEN_WS}-crm__search`,
          arguments: {},
        });
      } catch (err) {
        const e = err as { code?: number; data?: { reason?: string } };
        errorCode = e.code;
        dataReason = e.data?.reason;
      }
      expect(errorCode).toBe(-32602);
      expect(dataReason).toBe("workspace_access_denied");
    } finally {
      await client.close();
    }
  });

  it("orchestrator error mapping: UnknownToolSource → -32601 unknown_tool_source", async () => {
    const client = await createIdentityBoundClient();
    try {
      let errorCode: number | undefined;
      let dataReason: string | undefined;
      try {
        await client.callTool({
          name: `${SHARED_WS_ID}-no_such_source__no_such_tool`,
          arguments: {},
        });
      } catch (err) {
        const e = err as { code?: number; data?: { reason?: string } };
        errorCode = e.code;
        dataReason = e.data?.reason;
      }
      expect(errorCode).toBe(-32601);
      expect(dataReason).toBe("unknown_tool_source");
    } finally {
      await client.close();
    }
  });
});
