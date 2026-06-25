/**
 * Integration tests for the `/mcp` endpoint.
 *
 * `/mcp` sessions are identity-bound and carry NO workspace, so they expose
 * only the caller's identity tools (conversations, files, automations) — no
 * workspace tools and no cross-workspace union. A `tools/call` on any
 * `ws_<id>-...` name is refused (`WorkspaceToolUnavailable` →
 * `workspace_access_denied`). Workspace tools return when `/mcp` is reworked as
 * a workspace-bound agent projection.
 *
 * Setup: a single `Runtime` with two workspaces the dev identity belongs to
 * (each with a counter source) so we can assert that NONE of their tools leak
 * onto `/mcp`. The endpoint is dev-mode (no auth); `DEV_IDENTITY` is the caller.
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

  // Per-workspace registries + counter sources. These exist so we can assert
  // their tools do NOT leak onto the identity-bound /mcp surface.
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

async function createIdentityBoundClient(
  opts: { extraHeaders?: Record<string, string> } = {},
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: opts.extraHeaders ?? {} },
  });
  const client = new Client({ name: "mcp-identity-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

// ── Tests ─────────────────────────────────────────────────────────

describe("/mcp identity-bound session (identity tools only)", () => {
  it("tools/list returns only identity tools — no workspace tools, no cross-workspace union", async () => {
    const client = await createIdentityBoundClient();
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      // Identity tools are present (bare).
      expect(names).toContain("conversations__list");
      // Neither workspace's tools are exposed on /mcp.
      expect(names).not.toContain(sharedToolName());
      expect(names).not.toContain(personalToolName());
      expect(names.every((n) => !n.startsWith("ws_"))).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("identity sources surface BARE in tools/list, never ws-prefixed (one door)", async () => {
    const client = await createIdentityBoundClient();
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain("conversations__list");
      expect(names.some((n) => n.startsWith("ws_") && n.includes("conversations__"))).toBe(false);
    } finally {
      await client.close();
    }
  });

  it("a workspace tool call is refused — /mcp has no workspace (-32602 workspace_access_denied)", async () => {
    const client = await createIdentityBoundClient();
    try {
      let errorCode: number | undefined;
      let dataReason: string | undefined;
      try {
        await client.callTool({ name: sharedToolName(), arguments: { echo: "x" } });
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

  it("a bare workspace-app name rejects with -32602 unknown_identity_source (no silent workspace routing)", async () => {
    const client = await createIdentityBoundClient();
    try {
      let errorCode: number | undefined;
      let dataReason: string | undefined;
      try {
        await client.callTool({
          name: `${SHARED_SOURCE_NAME}__${SHARED_TOOL_BARE}`,
          arguments: { echo: "noop" },
        });
      } catch (err) {
        const e = err as { code?: number; data?: { reason?: string } };
        errorCode = e.code;
        dataReason = e.data?.reason;
      }
      expect(errorCode).toBe(-32602);
      expect(dataReason).toBe("unknown_identity_source");
    } finally {
      await client.close();
    }
  });

  it("a bare identity-source name dispatches through the identity door", async () => {
    const client = await createIdentityBoundClient();
    try {
      const result = await client.callTool({ name: "conversations__list", arguments: {} });
      expect(result.isError).toBeFalsy();
    } finally {
      await client.close();
    }
  });

  it("the X-Workspace-Id header is ignored and does not invalidate the session", async () => {
    // The web shell's workspace switcher sends X-Workspace-Id on some fetches.
    // The /mcp session must ignore it and stay alive across "switches" — an
    // identity tool call keeps working before and after the header flips.
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

    for (const wsHeader of [SHARED_WS_ID, personalWsId()]) {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "x-workspace-id": wsHeader,
          "mcp-session-id": sessionId!,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "conversations__list", arguments: {} },
        }),
      });
      expect(res.status).toBe(200);
      await res.body?.cancel();
    }

    await fetch(`${baseUrl}/mcp`, {
      method: "DELETE",
      headers: { "mcp-session-id": sessionId! },
    });
  });
});
