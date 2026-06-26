/**
 * Integration tests for the `/mcp` endpoint's per-request workspace wall.
 *
 * A `/mcp` session has no fixed workspace. Each request names its focused
 * workspace via `X-Workspace-Id`, and the host walls the request to it:
 *
 *   - No header → identity tools only (conversations, files, automations);
 *     a `ws_<id>-...` call is refused (`WorkspaceToolUnavailable`).
 *   - Member header → that workspace's tools (namespaced) + identity tools;
 *     a `ws_<other>-...` call is `CrossWorkspaceReachDenied`.
 *   - Non-member / unknown header → fail-closed to identity tools only
 *     (the header is not trusted to grant access it doesn't already imply).
 *
 * Setup: a single `Runtime` with two workspaces the dev identity belongs to
 * (Helix + personal, each with a counter source) plus a `stranger` workspace
 * it is NOT a member of, so we can assert both the honored and the fail-closed
 * paths. The endpoint is dev-mode (no auth); `DEV_IDENTITY` is the caller.
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
  resourceUri?: string,
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
      // A single workspace resource, so the resource wall can be asserted the
      // same way as the tool wall.
      ...(resourceUri
        ? { resources: new Map([[resourceUri, `<html>[${sourceName}] resource body</html>`]]) }
        : {}),
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
let strangerSource: ReturnType<typeof buildCounterSource>;

const testDir = join(tmpdir(), `nb-mcp-identity-bound-${Date.now()}`);

const SHARED_WS_ID = "ws_helix";
const SHARED_SOURCE_NAME = "crm";
const SHARED_TOOL_BARE = "search";
const PERSONAL_SOURCE_NAME = "gmail";
const PERSONAL_TOOL_BARE = "send";
// A workspace the dev identity is NOT a member of — used to assert the
// fail-closed path (a non-member header must not grant any reach).
const STRANGER_WS_ID = "ws_stranger";
const STRANGER_SOURCE_NAME = "vault";
const STRANGER_TOOL_BARE = "open";
// Each workspace source also serves one resource, so the resource wall (the
// `resources/list` + `resources/read` sibling of the tool wall) can be pinned.
const SHARED_RESOURCE_URI = "ui://crm/data";
const PERSONAL_RESOURCE_URI = "ui://gmail/data";
const STRANGER_RESOURCE_URI = "ui://vault/data";

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

  // Stranger workspace — exists, has a source, but the dev identity is NOT a
  // member. Membership is deliberately not granted.
  await wsStore.create("Stranger", STRANGER_WS_ID.slice(3));

  // Per-workspace registries + counter sources.
  const sharedReg = await runtime.ensureWorkspaceRegistry(SHARED_WS_ID);
  const personalReg = await runtime.ensureWorkspaceRegistry(personalWsId);
  const strangerReg = await runtime.ensureWorkspaceRegistry(STRANGER_WS_ID);

  sharedSource = buildCounterSource(SHARED_SOURCE_NAME, SHARED_TOOL_BARE, SHARED_RESOURCE_URI);
  personalSource = buildCounterSource(
    PERSONAL_SOURCE_NAME,
    PERSONAL_TOOL_BARE,
    PERSONAL_RESOURCE_URI,
  );
  strangerSource = buildCounterSource(
    STRANGER_SOURCE_NAME,
    STRANGER_TOOL_BARE,
    STRANGER_RESOURCE_URI,
  );
  await sharedSource.source.start();
  await personalSource.source.start();
  await strangerSource.source.start();
  sharedReg.addSource(sharedSource.source);
  personalReg.addSource(personalSource.source);
  strangerReg.addSource(strangerSource.source);

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

function strangerToolName(): string {
  return `${STRANGER_WS_ID}-${STRANGER_SOURCE_NAME}__${STRANGER_TOOL_BARE}`;
}

async function createMcpClient(
  opts: { workspace?: string } = {},
): Promise<Client> {
  const headers = opts.workspace ? { "x-workspace-id": opts.workspace } : {};
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers },
  });
  const client = new Client({ name: "mcp-identity-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

/** Invoke a tool and capture the JSON-RPC error code + `data.reason`, if any. */
async function callExpectingError(
  client: Client,
  name: string,
): Promise<{ code?: number; reason?: string }> {
  try {
    await client.callTool({ name, arguments: { echo: "x" } });
    return {};
  } catch (err) {
    const e = err as { code?: number; data?: { reason?: string } };
    return { code: e.code, reason: e.data?.reason };
  }
}

// ── No header → identity tools only ───────────────────────────────

describe("/mcp with no X-Workspace-Id (identity tools only)", () => {
  it("tools/list returns only identity tools — no workspace tools, no cross-workspace union", async () => {
    const client = await createMcpClient();
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      // Identity tools are present (bare).
      expect(names).toContain("conversations__list");
      // No workspace's tools are exposed without a header.
      expect(names).not.toContain(sharedToolName());
      expect(names).not.toContain(personalToolName());
      expect(names.every((n) => !n.startsWith("ws_"))).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("identity sources surface BARE in tools/list, never ws-prefixed (one door)", async () => {
    const client = await createMcpClient();
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain("conversations__list");
      expect(names.some((n) => n.startsWith("ws_") && n.includes("conversations__"))).toBe(false);
    } finally {
      await client.close();
    }
  });

  it("a workspace tool call is refused — no workspace in scope (-32602 workspace_access_denied)", async () => {
    const client = await createMcpClient();
    try {
      const { code, reason } = await callExpectingError(client, sharedToolName());
      expect(code).toBe(-32602);
      expect(reason).toBe("workspace_access_denied");
    } finally {
      await client.close();
    }
  });

  it("a bare workspace-app name rejects with -32602 unknown_identity_source (no silent workspace routing)", async () => {
    const client = await createMcpClient();
    try {
      const { code, reason } = await callExpectingError(
        client,
        `${SHARED_SOURCE_NAME}__${SHARED_TOOL_BARE}`,
      );
      expect(code).toBe(-32602);
      expect(reason).toBe("unknown_identity_source");
    } finally {
      await client.close();
    }
  });

  it("a bare identity-source name dispatches through the identity door", async () => {
    const client = await createMcpClient();
    try {
      const result = await client.callTool({ name: "conversations__list", arguments: {} });
      expect(result.isError).toBeFalsy();
    } finally {
      await client.close();
    }
  });
});

// ── Member header → walled to that workspace ──────────────────────

describe("/mcp with a member X-Workspace-Id (walled to that workspace)", () => {
  it("tools/list serves the focused workspace's tools + identity tools, and only that workspace's", async () => {
    const client = await createMcpClient({ workspace: SHARED_WS_ID });
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      // The focused workspace's tools are present (namespaced)…
      expect(names).toContain(sharedToolName());
      // …alongside the caller's identity tools…
      expect(names).toContain("conversations__list");
      // …but never another workspace's tools.
      expect(names).not.toContain(personalToolName());
    } finally {
      await client.close();
    }
  });

  it("a focused-workspace tool call succeeds", async () => {
    sharedSource.reset();
    const client = await createMcpClient({ workspace: SHARED_WS_ID });
    try {
      const result = await client.callTool({
        name: sharedToolName(),
        arguments: { echo: "hi" },
      });
      expect(result.isError).toBeFalsy();
      expect(sharedSource.callCount()).toBe(1);
    } finally {
      await client.close();
    }
  });

  it("switching the header flips the visible workspace (per-request, no session pinning)", async () => {
    const client = await createMcpClient({ workspace: personalWsId() });
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain(personalToolName());
      expect(names).not.toContain(sharedToolName());
    } finally {
      await client.close();
    }
  });

  it("SECURITY: a tool call to another member workspace is denied (CrossWorkspaceReachDenied)", async () => {
    // Session header = Helix; the dev IS a member of the personal workspace
    // too, but the wall bounds each request to its one named workspace — a
    // reach to any other is denied, membership notwithstanding.
    personalSource.reset();
    const client = await createMcpClient({ workspace: SHARED_WS_ID });
    try {
      const { code, reason } = await callExpectingError(client, personalToolName());
      expect(code).toBe(-32602);
      expect(reason).toBe("workspace_access_denied");
      // The other workspace's tool never ran.
      expect(personalSource.callCount()).toBe(0);
    } finally {
      await client.close();
    }
  });
});

// ── Non-member header → fail-closed to identity only ──────────────

describe("/mcp fail-closed on a non-member X-Workspace-Id", () => {
  it("SECURITY: a non-member header does not leak that workspace's tools (falls back to identity only)", async () => {
    const client = await createMcpClient({ workspace: STRANGER_WS_ID });
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      // Identity tools only — the stranger workspace exists and has tools, but
      // the dev is not a member, so the header buys nothing.
      expect(names).toContain("conversations__list");
      expect(names).not.toContain(strangerToolName());
      expect(names.every((n) => !n.startsWith("ws_"))).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("SECURITY: a non-member header cannot reach that workspace's tools", async () => {
    strangerSource.reset();
    const client = await createMcpClient({ workspace: STRANGER_WS_ID });
    try {
      const { code, reason } = await callExpectingError(client, strangerToolName());
      expect(code).toBe(-32602);
      expect(reason).toBe("workspace_access_denied");
      expect(strangerSource.callCount()).toBe(0);
    } finally {
      await client.close();
    }
  });
});

// ── Resources are walled exactly like tools ───────────────────────
//
// `resources/list` and `resources/read` are the sibling of `tools/list` /
// `tools/call`, and reach the SAME per-request workspace — never a sweep
// across every workspace the identity belongs to. A walled session must not
// enumerate or read another workspace's resources.

describe("/mcp resources are walled to the request's workspace", () => {
  it("no header: resources/list exposes no workspace resources", async () => {
    const client = await createMcpClient();
    try {
      const uris = (await client.listResources()).resources.map((r) => r.uri);
      expect(uris).not.toContain(SHARED_RESOURCE_URI);
      expect(uris).not.toContain(PERSONAL_RESOURCE_URI);
    } finally {
      await client.close();
    }
  });

  it("member header: resources/list serves only the focused workspace's resources", async () => {
    const client = await createMcpClient({ workspace: SHARED_WS_ID });
    try {
      const uris = (await client.listResources()).resources.map((r) => r.uri);
      expect(uris).toContain(SHARED_RESOURCE_URI);
      expect(uris).not.toContain(PERSONAL_RESOURCE_URI);
      expect(uris).not.toContain(STRANGER_RESOURCE_URI);
    } finally {
      await client.close();
    }
  });

  it("member header: a focused-workspace resource reads successfully", async () => {
    const client = await createMcpClient({ workspace: SHARED_WS_ID });
    try {
      const result = await client.readResource({ uri: SHARED_RESOURCE_URI });
      expect(result.contents.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });

  it("SECURITY: resources/read of another member workspace's resource is refused", async () => {
    // Session walled to Helix; the dev is a member of the personal workspace
    // too, but its resources are out of reach — the read must fail, never
    // return the other workspace's data.
    const client = await createMcpClient({ workspace: SHARED_WS_ID });
    try {
      await expect(client.readResource({ uri: PERSONAL_RESOURCE_URI })).rejects.toThrow();
    } finally {
      await client.close();
    }
  });

  it("SECURITY: a non-member header cannot read that workspace's resource", async () => {
    const client = await createMcpClient({ workspace: STRANGER_WS_ID });
    try {
      await expect(client.readResource({ uri: STRANGER_RESOURCE_URI })).rejects.toThrow();
    } finally {
      await client.close();
    }
  });

  it("SECURITY: no header cannot read any workspace resource", async () => {
    const client = await createMcpClient();
    try {
      await expect(client.readResource({ uri: SHARED_RESOURCE_URI })).rejects.toThrow();
    } finally {
      await client.close();
    }
  });
});
