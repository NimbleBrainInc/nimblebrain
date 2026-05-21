import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ReadResourceResultSchema,
  type ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  FileBackedHostResourcesResolver,
  HOST_RESOURCES_READ_METHOD,
  TokenBucketRateLimit,
} from "../../src/host-resources/index.ts";
import { createFileStore, type FileStore } from "../../src/files/store.ts";
import type { FileEntry } from "../../src/files/types.ts";
import type { EventSink } from "../../src/engine/types.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";

// End-to-end wire test for the inbound host-resources handlers, without
// spawning a real subprocess. We build a fake "bundle" MCP Server inside
// the test process, link it to an McpSource via InMemoryTransport, and
// drive a tool call whose implementation calls back through the server
// → client request channel using the namespaced method.
//
// This closes the QA-flagged gap from Phase 1's review: the gate logic
// is unit-tested in isolation, but the wiring that gets a real
// `setRequestHandler` to dispatch on real request frames isn't covered
// by anything more than typechecking. The fake-server pattern exercises
// the full Client.setRequestHandler → resolver → FileStore round trip.

const NoopSink: EventSink = { emit: () => {} };

let rootDir: string;
let wsAStore: FileStore;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "nb-host-resources-handlers-"));
  wsAStore = createFileStore(join(rootDir, "ws_a", "files"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

async function seedFile(store: FileStore, name: string, body: string, mime: string) {
  const saved = await store.saveFile(Buffer.from(body), name, mime);
  await store.appendRegistry({
    id: saved.id,
    filename: name,
    mimeType: mime,
    size: saved.size,
    createdAt: new Date().toISOString(),
    description: undefined,
    tags: [],
  } as unknown as FileEntry);
  return saved.id;
}

/**
 * Build a fake bundle MCP server whose single tool, when called, issues
 * an `ai.nimblebrain/resources/read` request back to its client peer.
 * Linked to the platform-side McpSource via InMemoryTransport. The tool
 * result echoes the bytes the host returned, so the test can assert
 * end-to-end correctness.
 */
async function buildFakeBundle(uriToRead: string) {
  const server = new Server({ name: "fake-bundle", version: "0.0.1" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "read_via_host",
        description: "Reads a workspace file by URI via the host extension.",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async () => {
    // Server-initiated request to the client — this is the host-resources
    // method going back to the platform side, where McpSource's inbound
    // handler dispatches to the resolver. The SDK's `Server.request`
    // supports custom methods; the client side's `setRequestHandler`
    // dispatches by method literal.
    try {
      const result = (await server.request(
        { method: HOST_RESOURCES_READ_METHOD, params: { uri: uriToRead } },
        ReadResourceResultSchema,
      )) as ReadResourceResult;
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        isError: false,
      };
    } catch (err) {
      return {
        content: [
          { type: "text", text: err instanceof Error ? err.message : String(err) },
        ],
        isError: true,
      };
    }
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  return { server, clientTransport };
}

describe("McpSource inbound host-resources handlers", () => {
  it("dispatches ai.nimblebrain/resources/read through the resolver and back to the bundle", async () => {
    const fileId = await seedFile(wsAStore, "brokers.csv", "hello,world", "text/csv");
    const uri = `files://${fileId}`;

    const fake = await buildFakeBundle(uri);

    const resolver = new FileBackedHostResourcesResolver(() => wsAStore);
    const rateLimit = new TokenBucketRateLimit();

    const source = new McpSource(
      "fake-bundle",
      {
        type: "inProcess",
        createServer: async () => fake,
      },
      NoopSink,
      {
        workspaceId: "ws_a",
        bundleId: "fake-bundle",
        hostResources: resolver,
        rateLimit,
      },
    );

    await source.start();
    const tools = await source.tools();
    expect(tools.map((t) => t.name)).toContain("fake-bundle__read_via_host");

    // McpSource.execute takes the BARE tool name (without source prefix);
    // ToolRegistry.execute strips the prefix before calling source.execute.
    const callResult = await source.execute("read_via_host", {});

    if (callResult.isError) {
      throw new Error(
        `expected isError=false, got isError=true. content=${JSON.stringify(callResult.content)}`,
      );
    }
    expect(callResult.isError).toBe(false);
    const textBlock = callResult.content.find((c) => c.type === "text") as
      | { type: "text"; text: string }
      | undefined;
    expect(textBlock).toBeDefined();
    const parsed = JSON.parse(textBlock?.text ?? "{}") as ReadResourceResult;
    expect(parsed.contents).toHaveLength(1);
    expect(parsed.contents[0]?.uri).toBe(uri);
    expect(parsed.contents[0]?.mimeType).toBe("text/csv");
    expect(parsed.contents[0]?.text).toBe("hello,world");

    await source.stop();
  });

  it("propagates resolver errors (e.g. unknown file id) as JSON-RPC error responses", async () => {
    const fake = await buildFakeBundle("files://fl_does_not_exist");
    const resolver = new FileBackedHostResourcesResolver(() => wsAStore);
    const rateLimit = new TokenBucketRateLimit();

    const source = new McpSource(
      "fake-bundle",
      { type: "inProcess", createServer: async () => fake },
      NoopSink,
      {
        workspaceId: "ws_a",
        bundleId: "fake-bundle",
        hostResources: resolver,
        rateLimit,
      },
    );
    await source.start();

    // The bundle's tool catches the host-side error via the SDK's
    // request-response machinery and surfaces it as a thrown exception.
    // McpSource's execute wrapper turns that into an `isError: true`
    // tool result rather than throwing.
    const result = await source.execute("read_via_host", {});
    expect(result.isError).toBe(true);

    await source.stop();
  });
});
