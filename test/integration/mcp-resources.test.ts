import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Client,
  ResourceNotFoundError,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { Server } from "@modelcontextprotocol/server";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { RESOURCE_SOURCE_META_KEY } from "../../src/api/mcp-server.ts";
import type { ServerHandle } from "../../src/api/server.ts";
import { startServer } from "../../src/api/server.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";
import { buildMcpRequest, readMcpAnswer } from "../../web/src/mcp-bridge-client.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { newMcpClient } from "../helpers/mcp-client.ts";
import { type RemoteMcpFixture, startRemoteMcpServer } from "../helpers/remote-mcp-fixture.ts";
import { textOf } from "../helpers/resource-contents.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

// ---------------------------------------------------------------------------
// Fixture: a remote MCP server with two resources
//
// Exposes one tool (so tools/list is still populated) plus:
//   - ui://<namespace>/dashboard      → text/html payload
//   - text://<namespace>/greeting     → plain-text payload
// ---------------------------------------------------------------------------
const FIXTURE_HTML = "<h1>Fixture Dashboard</h1><p>hello from a test resource</p>";
const FIXTURE_TEXT = "hello greetings from fixture";

interface FixtureConfig {
  namespace: string;
  htmlBody: string;
  textBody: string;
}

function createFixtureServer(config: FixtureConfig): Server {
  const dashboardUri = `ui://${config.namespace}/dashboard`;
  const greetingUri = `text://${config.namespace}/greeting`;

  const server = new Server(
    { name: config.namespace, version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler("tools/list", async () => ({
    tools: [
      {
        name: "ping",
        description: "Returns pong",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));

  server.setRequestHandler("tools/call", async () => ({
    content: [{ type: "text", text: "pong" }],
  }));

  server.setRequestHandler("resources/list", async () => ({
    resources: [
      { uri: dashboardUri, name: "Dashboard", mimeType: "text/html" },
      { uri: greetingUri, name: "Greeting", mimeType: "text/plain" },
    ],
  }));

  server.setRequestHandler("resources/read", async (request) => {
    if (request.params.uri === dashboardUri) {
      return {
        contents: [{ uri: request.params.uri, mimeType: "text/html", text: config.htmlBody }],
      };
    }
    if (request.params.uri === greetingUri) {
      return {
        contents: [{ uri: request.params.uri, mimeType: "text/plain", text: config.textBody }],
      };
    }
    throw new Error(`Resource not found: ${request.params.uri}`);
  });

  return server;
}

// ---------------------------------------------------------------------------
// Shared harness: one runtime, one server, two workspaces with different sources.
// ---------------------------------------------------------------------------
const OTHER_WORKSPACE_ID = "ws_005820c54ca342ad";
const testDir = join(tmpdir(), `nimblebrain-mcp-resources-${Date.now()}`);

let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;
let fixtureSource: McpSource;
let otherSource: McpSource;
let neighborSource: McpSource;
let fixtureServer: RemoteMcpFixture;
let otherServer: RemoteMcpFixture;
let neighborServer: RemoteMcpFixture;

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });

  runtime = await Runtime.start({
    identityProvider: devProvider,
    languageModel: createEchoModel(),
    logging: { disabled: true },
    workDir: testDir,
  });

  // Provision the primary workspace and register the fixture MCP source in it.
  await provisionTestWorkspace(runtime);
  fixtureServer = startRemoteMcpServer(() =>
    createFixtureServer({ namespace: "fixture", htmlBody: FIXTURE_HTML, textBody: FIXTURE_TEXT }),
  );
  fixtureSource = new McpSource(
    "fixture",
    { type: "remote", url: new URL(fixtureServer.url), allowInsecure: true },
    new NoopEventSink(),
  );
  await fixtureSource.start();
  const primaryReg = runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID);
  primaryReg.addSource(fixtureSource);

  // A second source in the SAME workspace: what a read scoped to `fixture`
  // must not reach.
  neighborServer = startRemoteMcpServer(() =>
    createFixtureServer({
      namespace: "neighbor",
      htmlBody: "<h1>Neighbor</h1>",
      textBody: "neighbor greetings",
    }),
  );
  neighborSource = new McpSource(
    "neighbor",
    { type: "remote", url: new URL(neighborServer.url), allowInsecure: true },
    new NoopEventSink(),
  );
  await neighborSource.start();
  primaryReg.addSource(neighborSource);

  // Provision a second workspace with its own MCP source and a distinct
  // namespace — `ui://other/dashboard` is only reachable from this workspace.
  await provisionTestWorkspace(runtime, OTHER_WORKSPACE_ID, "Other Workspace");
  otherServer = startRemoteMcpServer(() =>
    createFixtureServer({
      namespace: "other",
      htmlBody: "<h1>Other Workspace</h1>",
      textBody: "other greetings",
    }),
  );
  otherSource = new McpSource(
    "other",
    { type: "remote", url: new URL(otherServer.url), allowInsecure: true },
    new NoopEventSink(),
  );
  await otherSource.start();
  const otherReg = runtime.getRegistryForWorkspace(OTHER_WORKSPACE_ID);
  otherReg.addSource(otherSource);

  handle = startServer({ runtime, port: 0 });
  baseUrl = `http://localhost:${handle.port}`;
  // Generous hook timeout: this setup starts a Runtime, provisions two
  // workspaces, and stands up two MCP servers. The 5s default hook timeout
  // is too tight under CI load. 30s leaves ample headroom without masking a
  // genuine hang.
}, 30_000);

afterAll(async () => {
  // Optional-chain every teardown step: if `beforeAll` timed out partway,
  // these vars may be unassigned. Without the guards a setup flake surfaces
  // as a misleading `TypeError: undefined is not an object` from teardown,
  // burying the real cause (the setup timeout).
  handle?.stop(true);
  try {
    await fixtureSource?.stop();
  } catch {
    // already stopped
  }
  try {
    await otherSource?.stop();
  } catch {
    // already stopped
  }
  try {
    await neighborSource?.stop();
  } catch {
    // already stopped
  }
  fixtureServer?.close();
  otherServer?.close();
  neighborServer?.close();
  await runtime?.shutdown();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
}, 30_000);

async function createMcpClient(workspaceId: string = TEST_WORKSPACE_ID): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/${workspaceId}`));
  const client = newMcpClient({ name: "mcp-resources-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("MCP /mcp — resources", () => {
  it("advertises the resources capability in server/discover", async () => {
    const client = await createMcpClient();
    try {
      const caps = client.getServerCapabilities();
      expect(caps).toBeDefined();
      // `resources` must be present (value may be `{}` — presence is what matters).
      expect(caps?.resources).toBeDefined();
    } finally {
      await client.close();
    }
  });

  it("resources/list returns only the focused workspace's resources (walled)", async () => {
    const client = await createMcpClient();
    try {
      const result = await client.listResources();
      const uris = result.resources.map((r) => r.uri);
      expect(uris).toContain("ui://fixture/dashboard");
      expect(uris).toContain("text://fixture/greeting");
      // Walled: the identity is also a member of the "other" workspace, but a
      // session focused on TEST_WORKSPACE_ID never enumerates its resources.
      expect(uris).not.toContain("ui://other/dashboard");
    } finally {
      await client.close();
    }
  });

  it("resources/read on a known URI returns the resource's bytes", async () => {
    // Parity acceptance criterion: /mcp's `resources/read` must return the
    // same shape as `POST /v1/workspaces/:wsId/resources/read` — `{ contents:
    // [{ uri, mimeType?, text?, blob? }] }` — with identical bytes for a given URI.
    //
    // We can't exercise the REST endpoint directly here because it
    // goes through `Runtime.readAppResource`, which checks connector lifecycle
    // state (`lifecycle.getInstance`) and returns null for sources added
    // straight to the registry. We still assert the canonical spec shape
    // and the round-trip bytes, which is what parity means in practice.
    const client = await createMcpClient();
    try {
      const mcpResult = await client.readResource({ uri: "ui://fixture/dashboard" });
      expect(mcpResult.contents).toHaveLength(1);
      const mcpEntry = mcpResult.contents[0]!;
      expect(mcpEntry.uri).toBe("ui://fixture/dashboard");
      expect(mcpEntry.mimeType).toBe("text/html");
      expect(textOf(mcpEntry)).toBe(FIXTURE_HTML);

      // A second URI on the same source, different mimeType, same shape.
      const textResult = await client.readResource({ uri: "text://fixture/greeting" });
      expect(textResult.contents).toHaveLength(1);
      expect(textOf(textResult.contents[0]!)).toBe(FIXTURE_TEXT);
      expect(textResult.contents[0]!.mimeType).toBe("text/plain");
    } finally {
      await client.close();
    }
  });

  it("resources/read on an unknown URI returns a JSON-RPC error (not 500)", async () => {
    const client = await createMcpClient();
    try {
      await expect(client.readResource({ uri: "ui://fixture/does-not-exist" })).rejects.toThrow(
        /not found/i,
      );
    } finally {
      await client.close();
    }

    // Drive the request at the raw HTTP layer too to confirm the transport
    // surfaces a JSON-RPC `error` envelope instead of a 500.
    const { headers, body } = buildMcpRequest("2", "resources/read", {
      uri: "ui://fixture/does-not-exist",
    });
    const readRes = await fetch(`${baseUrl}/mcp/${TEST_WORKSPACE_ID}`, {
      method: "POST",
      headers,
      body,
    });
    expect(readRes.status).toBeLessThan(500);
    const answer = await readMcpAnswer(readRes);
    expect("error" in answer && answer.error.code).toBe(-32602);
  });

  it("SECURITY: a walled session cannot list or read another workspace's resources", async () => {
    // The dev identity is a member of both `TEST_WORKSPACE_ID` and
    // `OTHER_WORKSPACE_ID`, but the wall bounds a `/mcp` session to the one
    // its URL names. At TEST_WORKSPACE_ID's URL,
    // `ui://other/dashboard` is neither listed nor readable.
    const focused = await createMcpClient(TEST_WORKSPACE_ID);
    try {
      const uris = (await focused.listResources()).resources.map((r) => r.uri);
      expect(uris).toContain("ui://fixture/dashboard");
      expect(uris).not.toContain("ui://other/dashboard");

      // The focused workspace's own resource still reads.
      const own = await focused.readResource({ uri: "ui://fixture/dashboard" });
      expect(textOf(own.contents[0]!)).toBe(FIXTURE_HTML);

      // The other workspace's resource is out of reach — the read fails,
      // never returns its bytes.
      await expect(focused.readResource({ uri: "ui://other/dashboard" })).rejects.toThrow(
        /not found/i,
      );
    } finally {
      await focused.close();
    }

    // Proof the block is the wall, not a missing fixture: the same resource
    // reads fine from a session focused on its own workspace.
    const otherFocused = await createMcpClient(OTHER_WORKSPACE_ID);
    try {
      const other = await otherFocused.readResource({ uri: "ui://other/dashboard" });
      expect(textOf(other.contents[0]!)).toBe("<h1>Other Workspace</h1>");
    } finally {
      await otherFocused.close();
    }
  });
});

// ---------------------------------------------------------------------------
// A read that names its source under `RESOURCE_SOURCE_META_KEY` — how the
// iframe bridge reads for an app — resolves in that one source only. Every
// iframe shares one `/mcp` session, so this key is the only thing that says
// which app is reading.
// ---------------------------------------------------------------------------
describe("MCP /mcp — resources/read scoped to one source", () => {
  const scopedTo = (source: string) => ({ [RESOURCE_SOURCE_META_KEY]: source });

  it("reads the named source's own resource", async () => {
    const client = await createMcpClient();
    try {
      const own = await client.readResource({
        uri: "ui://fixture/dashboard",
        _meta: scopedTo("fixture"),
      });
      expect(textOf(own.contents[0]!)).toBe(FIXTURE_HTML);
    } finally {
      await client.close();
    }
  });

  it("does not reach another source in the same workspace", async () => {
    const client = await createMcpClient();
    try {
      await expect(
        client.readResource({ uri: "ui://neighbor/dashboard", _meta: scopedTo("fixture") }),
      ).rejects.toBeInstanceOf(ResourceNotFoundError);
    } finally {
      await client.close();
    }
  });

  it("a source that is absent or in another workspace answers as not found", async () => {
    // The URI is one this workspace serves, so only the scope can refuse it.
    const client = await createMcpClient();
    try {
      for (const source of ["no-such-source", "other"]) {
        await expect(
          client.readResource({ uri: "ui://neighbor/dashboard", _meta: scopedTo(source) }),
        ).rejects.toBeInstanceOf(ResourceNotFoundError);
      }
    } finally {
      await client.close();
    }
  });

  it("naming another source reads that source (the internal-app cross-read)", async () => {
    const client = await createMcpClient();
    try {
      const result = await client.readResource({
        uri: "ui://neighbor/dashboard",
        _meta: scopedTo("neighbor"),
      });
      expect(textOf(result.contents[0]!)).toBe("<h1>Neighbor</h1>");
    } finally {
      await client.close();
    }
  });

  it("an unscoped read still resolves across the workspace", async () => {
    const client = await createMcpClient();
    try {
      const result = await client.readResource({ uri: "ui://neighbor/dashboard" });
      expect(textOf(result.contents[0]!)).toBe("<h1>Neighbor</h1>");
    } finally {
      await client.close();
    }
  });
});
