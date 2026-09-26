/**
 * Integration tests for the `/mcp/<wsId>` workspace wall.
 *
 * Every MCP connection names its workspace in the URL, and the session is
 * walled to it:
 *
 *   - Bare `/mcp` → refused; no workspace is chosen for it.
 *   - A member's `/mcp/<wsId>` → that workspace's tools + identity tools, all
 *     bare; a `ws_<other>-...` call is rejected as a retired wire form.
 *   - A non-member's `/mcp/<wsId>` → refused before any session exists, with
 *     the same answer as a workspace that does not exist.
 *   - A session id opened at one workspace's URL is refused at another's.
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

const COUNTER_OUTPUT_SCHEMA = {
  type: "object",
  properties: { count: { type: "number" }, echo: { type: "string" } },
  required: ["count"],
};

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
    // Every field the door forwards, so each can be asserted to arrive under
    // its own name. A `destructiveHint` a caller never sees is a caller that
    // cannot be careful with the call it is about to make.
    annotations: { title: "Counter", destructiveHint: true },
    meta: { "ai.nimblebrain/counter": true },
    outputSchema: COUNTER_OUTPUT_SCHEMA,
    // Declaring an `outputSchema` obliges every success to carry
    // `structuredContent`; a result without it is rejected by the SDK client's
    // cached validator and comes back `isError: true`.
    handler: async (input) => {
      count += 1;
      const echo = typeof input.echo === "string" ? input.echo : "";
      return {
        content: textContent(`[${sourceName}] call #${count}: ${echo}`),
        structuredContent: { count, echo },
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

// Wire names are bare: the workspace a call lands in is the one in the
// session's URL, not the name. `personalToolNameNamespaced`
// below keeps the retired `ws_<id>-` form on purpose — it is the shape a stale
// client still sends, and its REJECTION is what makes cross-workspace reach
// unexpressible rather than merely denied.
function sharedToolName(): string {
  return `${SHARED_SOURCE_NAME}__${SHARED_TOOL_BARE}`;
}

function personalToolName(): string {
  return `${PERSONAL_SOURCE_NAME}__${PERSONAL_TOOL_BARE}`;
}

/**
 * The personal workspace's tool in the legacy `ws_<id>-` form.
 *
 * Required for the cross-workspace denial test, and the requirement is the
 * point: a BARE name cannot express another workspace at all, so there is
 * nothing to deny — it simply resolves against the session's own registry. The
 * legacy form is the only shape that can still NAME a second workspace, so it
 * is the shape a stale client still sends, and its REJECTION is the guarantee:
 * the reach it once guarded is now unexpressible rather than merely refused.
 */
function personalToolNameNamespaced(): string {
  return `${personalWsId()}-${PERSONAL_SOURCE_NAME}__${PERSONAL_TOOL_BARE}`;
}

function strangerToolNameBare(): string {
  return `${STRANGER_SOURCE_NAME}__${STRANGER_TOOL_BARE}`;
}

function mcpUrl(workspace: string): URL {
  return new URL(`${baseUrl}/mcp/${workspace}`);
}

async function createMcpClient(workspace: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(mcpUrl(workspace));
  const client = new Client({ name: "mcp-identity-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

/** Initialize at `workspace` and return the raw session id the server allocated. */
async function openSession(workspace: string): Promise<{ client: Client; sessionId: string }> {
  const transport = new StreamableHTTPClientTransport(mcpUrl(workspace));
  const client = new Client({ name: "mcp-identity-test", version: "1.0.0" });
  await client.connect(transport);
  const sessionId = transport.sessionId;
  if (!sessionId) throw new Error("server allocated no session id");
  return { client, sessionId };
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

// ── Bare /mcp → refused ───────────────────────────────────────────

describe("bare /mcp", () => {
  it("is refused: an MCP client cannot initialize without naming a workspace", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    const client = new Client({ name: "mcp-identity-test", version: "1.0.0" });
    await expect(client.connect(transport)).rejects.toThrow(/MCP endpoint is per workspace/);
  });
});

// ── A member's workspace URL → walled to that workspace ───────────

describe("/mcp/<wsId> for a member (walled to that workspace)", () => {
  it("tools/list serves the workspace's tools + identity tools, and only that workspace's", async () => {
    const client = await createMcpClient(SHARED_WS_ID);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      // The workspace's tools are present (bare)…
      expect(names).toContain(sharedToolName());
      // …alongside the caller's identity tools…
      expect(names).toContain("conversations__list");
      // …but never another workspace's tools.
      expect(names).not.toContain(personalToolName());
      expect(names).not.toContain(strangerToolNameBare());
    } finally {
      await client.close();
    }
  });

  it("identity sources surface BARE in tools/list, never ws-prefixed (one door)", async () => {
    const client = await createMcpClient(SHARED_WS_ID);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain("conversations__list");
      expect(names.every((n) => !n.startsWith("ws_"))).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("a bare identity-source name dispatches through the identity door, in the URL's workspace", async () => {
    const client = await createMcpClient(SHARED_WS_ID);
    try {
      const result = await client.callTool({ name: "conversations__list", arguments: {} });
      expect(result.isError).toBeFalsy();
    } finally {
      await client.close();
    }
  });

  it("tools/list forwards annotations, _meta and outputSchema under their own names", async () => {
    const client = await createMcpClient(SHARED_WS_ID);
    try {
      const listed = (await client.listTools()).tools.find((t) => t.name === sharedToolName());
      expect(listed).toBeDefined();
      expect(listed!.annotations).toEqual({ title: "Counter", destructiveHint: true });
      expect(listed!._meta).toEqual({ "ai.nimblebrain/counter": true });
      expect(listed!.outputSchema).toEqual(COUNTER_OUTPUT_SCHEMA);
    } finally {
      await client.close();
    }
  });

  it("a declared outputSchema is honoured by the call it describes", async () => {
    // The listing's `outputSchema` arms the SDK client's validator, so this
    // asserts more than a field's presence: a tool that declared one and
    // answered with text alone would come back `isError: true` here.
    sharedSource.reset();
    const client = await createMcpClient(SHARED_WS_ID);
    try {
      await client.listTools();
      const result = await client.callTool({
        name: sharedToolName(),
        arguments: { echo: "structured" },
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ count: 1, echo: "structured" });
    } finally {
      await client.close();
    }
  });

  it("a workspace tool call succeeds", async () => {
    sharedSource.reset();
    const client = await createMcpClient(SHARED_WS_ID);
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

  it("another workspace's URL is another session that sees that workspace", async () => {
    const client = await createMcpClient(personalWsId());
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain(personalToolName());
      expect(names).not.toContain(sharedToolName());
    } finally {
      await client.close();
    }
  });

  it("SECURITY: another member workspace cannot be NAMED, so it cannot be reached", async () => {
    // Session = Helix; the dev IS a member of the personal workspace too.
    // Naming it is impossible rather than denied: the `ws_<id>-` form is
    // retired, so this is rejected as a stale wire name before any workspace
    // resolution. The guarantee is structural: no name addresses a second
    // workspace, so there is no attempt left to catch.
    personalSource.reset();
    const client = await createMcpClient(SHARED_WS_ID);
    try {
      const { code } = await callExpectingError(client, personalToolNameNamespaced());
      expect(code).toBe(-32602);
      // The other workspace's tool never ran.
      expect(personalSource.callCount()).toBe(0);
    } finally {
      await client.close();
    }
  });

  it("SECURITY: a session opened at one workspace's URL is refused at another's", async () => {
    // Both workspaces are the caller's own. The session is still bound to the
    // URL it was opened at, and presenting it elsewhere looks exactly like an
    // unknown session id.
    personalSource.reset();
    const { client, sessionId } = await openSession(SHARED_WS_ID);
    try {
      const res = await fetch(mcpUrl(personalWsId()), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId,
          "mcp-protocol-version": "2025-06-18",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: { name: personalToolName(), arguments: { echo: "x" } },
        }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { data: { reason: string } } };
      expect(body.error.data.reason).toBe("not_found");
      expect(personalSource.callCount()).toBe(0);

      // The session itself is untouched at its own URL.
      expect((await client.listTools()).tools.map((t) => t.name)).toContain(sharedToolName());
    } finally {
      await client.close();
    }
  });
});

// ── A non-member's workspace URL → refused ────────────────────────

describe("/mcp/<wsId> for a non-member", () => {
  it("SECURITY: refuses the connection with the same answer as an unknown workspace", async () => {
    strangerSource.reset();
    const initialize = (workspace: string) =>
      fetch(mcpUrl(workspace), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "mcp-identity-test", version: "1.0.0" },
          },
        }),
      });

    const stranger = await initialize(STRANGER_WS_ID);
    const unknown = await initialize("ws_nosuchworkspace");
    expect(stranger.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await stranger.text()).toBe(await unknown.text());
    expect(strangerSource.callCount()).toBe(0);
  });
});

// ── Resources are walled exactly like tools ───────────────────────
//
// `resources/list` and `resources/read` are the sibling of `tools/list` /
// `tools/call`, and reach the SAME workspace — never a sweep across every
// workspace the identity belongs to. A walled session must not enumerate or
// read another workspace's resources.

describe("/mcp/<wsId> resources are walled to the URL's workspace", () => {
  it("resources/list serves only the workspace's resources", async () => {
    const client = await createMcpClient(SHARED_WS_ID);
    try {
      const uris = (await client.listResources()).resources.map((r) => r.uri);
      expect(uris).toContain(SHARED_RESOURCE_URI);
      expect(uris).not.toContain(PERSONAL_RESOURCE_URI);
      expect(uris).not.toContain(STRANGER_RESOURCE_URI);
    } finally {
      await client.close();
    }
  });

  it("a workspace resource reads successfully", async () => {
    const client = await createMcpClient(SHARED_WS_ID);
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
    const client = await createMcpClient(SHARED_WS_ID);
    try {
      await expect(client.readResource({ uri: PERSONAL_RESOURCE_URI })).rejects.toThrow();
      await expect(client.readResource({ uri: STRANGER_RESOURCE_URI })).rejects.toThrow();
    } finally {
      await client.close();
    }
  });
});
