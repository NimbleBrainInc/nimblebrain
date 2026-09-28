/**
 * The runtime on both protocol eras.
 *
 * Client role: one `McpSource` against a 2025-only server and a 2026-07-28
 * server, the same assertions on each — the negotiated version, tools, a tool
 * call, a `ui://` read, and the extensions the server advertises. The task wire
 * against a 2025 task server and a SEP-2663 one, and the legacy retry after a
 * probe that meets an HTTP 500 (and not after a gateway's 502/503/504).
 *
 * Server role: `/mcp/<wsId>` answering a 2026-07-28 client and a 2025 client
 * with the same bare, workspace-walled tool names.
 *
 * A 2026 server has no in-memory transport (the SDK's `InMemoryTransport`
 * links 2025-era instances only), so both eras are served over HTTP here: the
 * SDK's `createMcpHandler` for the modern one, its `legacyStatelessFallback`
 * for a server that predates `server/discover`.
 */
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLIENT_CAPABILITIES_META_KEY,
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  createMcpHandler,
  legacyStatelessFallback,
  Server,
  type ServerCapabilities,
} from "@modelcontextprotocol/server";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { type ServerHandle, startServer } from "../../src/api/server.ts";
import { textContent } from "../../src/engine/content-helpers.ts";
import type { ToolResult } from "../../src/engine/types.ts";
import {
  HOST_RESOURCES_CAPABILITY_KEY,
  HOST_RESOURCES_CAPABILITY_V1,
} from "../../src/host-resources/index.ts";
import { log } from "../../src/observability/log.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";
import { TASKS_EXTENSION_ID } from "../../src/tools/mcp-task-client.ts";
import { SharedSourceRef } from "../../src/tools/registry.ts";
import type { Tool, ToolSource } from "../../src/tools/types.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";
import { devProvider } from "../helpers/dev-provider.ts";

const FACETS = "ai.nimblebrain/facets";
const APP_HTML = "<!doctype html><title>era</title>";

type Fetch = (request: Request) => Promise<Response>;

interface Served {
  url: string;
  close: () => void;
}

function serve(fetch: Fetch): Served {
  const server = Bun.serve({ port: 0, fetch });
  return { url: `http://localhost:${server.port}/mcp`, close: () => server.stop(true) };
}

/** The connector under test: one tool, one `ui://` resource, and whatever extensions it is given. */
function buildServer(opts: { extensions?: Record<string, object>; taskTools?: boolean } = {}) {
  const capabilities: ServerCapabilities = {
    tools: {},
    resources: {},
    ...(opts.extensions ? { extensions: opts.extensions } : {}),
  };
  const server = new Server({ name: "era-fixture", version: "1.0.0" }, { capabilities });
  server.setRequestHandler("tools/list", async () => ({
    tools: [
      {
        name: "echo",
        inputSchema: { type: "object" as const, properties: { text: { type: "string" } } },
        // A 2025-era task marker; the 2026 wire drops it.
        ...(opts.taskTools ? { execution: { taskSupport: "optional" as const } } : {}),
      },
    ],
  }));
  server.setRequestHandler("tools/call", async (request) => ({
    content: [{ type: "text", text: `echo:${String(request.params.arguments?.text ?? "")}` }],
  }));
  server.setRequestHandler("resources/list", async () => ({
    resources: [{ uri: "ui://era/app", name: "app", mimeType: "text/html" }],
  }));
  server.setRequestHandler("resources/read", async (request) => ({
    contents: [{ uri: request.params.uri, mimeType: "text/html", text: APP_HTML }],
  }));
  return server;
}

function legacyServer(opts: Parameters<typeof buildServer>[0] = {}): Fetch {
  return legacyStatelessFallback(() => buildServer(opts));
}

function modernServer(opts: Parameters<typeof buildServer>[0] = {}): Fetch {
  return createMcpHandler(() => buildServer(opts)).fetch;
}

async function connect(url: string, opts: { connector?: boolean } = {}): Promise<McpSource> {
  const source = new McpSource(
    "era",
    { type: "remote", url: new URL(url), allowInsecure: true },
    new NoopEventSink(),
    // A connector source carries the context that registers the host-resources
    // handlers, which is what entitles it to claim the extension.
    opts.connector
      ? {
          workspaceId: "ws_era",
          connectorId: "era",
          hostResources: {
            read: async () => ({ contents: [] }),
            list: async () => ({ resources: [] }),
          },
          rateLimit: { check: () => {} },
        }
      : undefined,
  );
  await source.start();
  return source;
}

/** A JSON-RPC result answered directly, as a server that tasks the call would. */
function answer(id: unknown, result: Record<string, unknown>): Response {
  return Response.json({ jsonrpc: "2.0", id, result });
}

async function bodyOf(request: Request): Promise<{
  id?: unknown;
  method?: string;
  params?: Record<string, unknown> & { _meta?: Record<string, unknown> };
} | null> {
  if (request.method !== "POST") return null;
  return request
    .clone()
    .json()
    .catch(() => null);
}

// ── Client role ─────────────────────────────────────────────────────

describe.each([
  { era: "legacy", version: "2025-11-25", fetch: () => legacyServer() },
  {
    era: "modern",
    version: "2026-07-28",
    fetch: () => modernServer({ extensions: { [FACETS]: { v: 1 } } }),
  },
])("McpSource on the $era era", ({ era, version, fetch }) => {
  let served: Served;
  let source: McpSource;

  beforeAll(async () => {
    served = serve(fetch());
    source = await connect(served.url);
  });

  afterAll(async () => {
    await source.stop();
    served.close();
  });

  it(`negotiates ${version}`, () => {
    expect(source.getNegotiatedProtocolVersion()).toBe(version);
  });

  it("lists and calls a tool", async () => {
    expect((await source.tools()).map((t) => t.name)).toEqual(["era__echo"]);
    const result = await source.execute("echo", { text: "hi" });
    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: "text", text: "echo:hi" }]);
  });

  it("reads a ui:// resource", async () => {
    const read = await source.readResource("ui://era/app");
    expect(read?.text).toBe(APP_HTML);
  });

  it(
    era === "modern"
      ? "reads the extensions server/discover advertised"
      : "has no extensions from a server that advertises none",
    () => {
      expect(source.serverExtensions()).toEqual(era === "modern" ? { [FACETS]: { v: 1 } } : {});
    },
  );
});

describe("McpSource era fallback", () => {
  it("connects on the 2025 era when the server/discover probe meets an HTTP 500", async () => {
    const legacy = legacyServer();
    const served = serve(async (request) => {
      const body = await bodyOf(request);
      if (body?.method === "server/discover") return new Response("boom", { status: 500 });
      return legacy(request);
    });
    const source = await connect(served.url);
    try {
      expect(source.getNegotiatedProtocolVersion()).toBe("2025-11-25");
      expect((await source.execute("echo", { text: "ok" })).content).toEqual([
        { type: "text", text: "echo:ok" },
      ]);
    } finally {
      await source.stop();
      served.close();
    }
  });

  it.each([502, 503, 504])(
    "does not fall back to the 2025 era when a gateway answers the probe with %i",
    async (status) => {
      // A 2026 server behind an edge whose upstream is restarting: the probe
      // meets the gateway's error, and the next connect meets the server.
      const modern = modernServer();
      let gatewayDown = true;
      const seen: string[] = [];
      const served = serve(async (request) => {
        const body = await bodyOf(request);
        if (body?.method) seen.push(body.method);
        if (gatewayDown && body?.method === "server/discover") {
          return new Response("bad gateway", { status });
        }
        return modern(request);
      });
      const source = new McpSource(
        "era",
        { type: "remote", url: new URL(served.url), allowInsecure: true },
        new NoopEventSink(),
      );
      try {
        await expect(source.start()).rejects.toBeDefined();
        expect(seen).not.toContain("initialize");
        gatewayDown = false;
        await source.start();
        expect(source.getNegotiatedProtocolVersion()).toBe("2026-07-28");
      } finally {
        await source.stop();
        served.close();
      }
    },
  );

  it("does not retry on the 2025 era when the probe is refused for authorization", async () => {
    const legacy = legacyServer();
    const seen: string[] = [];
    const served = serve(async (request) => {
      const body = await bodyOf(request);
      if (body?.method) seen.push(body.method);
      if (body?.method === "server/discover") return new Response("forbidden", { status: 403 });
      return legacy(request);
    });
    const source = new McpSource(
      "era",
      { type: "remote", url: new URL(served.url), allowInsecure: true },
      new NoopEventSink(),
    );
    try {
      await expect(source.start()).rejects.toBeDefined();
      expect(seen).not.toContain("initialize");
    } finally {
      await source.stop();
      served.close();
    }
  });
});

/**
 * ADR-0023: a capability declared is a capability served. The host-resources
 * methods are server→client requests, which only the 2025 era carries, so the
 * claim rides the 2025 `initialize` and no 2026-07-28 request envelope.
 */
describe("the host-resources claim", () => {
  it("rides the 2025 initialize handshake", async () => {
    const legacy = legacyServer();
    let claimed: { tasks?: unknown; extensions?: Record<string, unknown> } | undefined;
    const served = serve(async (request) => {
      const body = await bodyOf(request);
      if (body?.method === "initialize") {
        claimed = body.params?.capabilities as typeof claimed;
      }
      return legacy(request);
    });
    const source = await connect(served.url, { connector: true });
    try {
      expect(source.getNegotiatedProtocolVersion()).toBe("2025-11-25");
      expect(claimed?.extensions?.[HOST_RESOURCES_CAPABILITY_KEY]).toEqual(
        HOST_RESOURCES_CAPABILITY_V1,
      );
      // The extension is added to the constructed claims, not swapped in for them.
      expect(claimed?.tasks).toEqual({ requests: { tools: { call: {} } }, cancel: {} });
    } finally {
      await source.stop();
      served.close();
    }
  });

  it("is absent from the 2025 initialize of a source that registers no handlers", async () => {
    const legacy = legacyServer();
    let claimed: { extensions?: Record<string, unknown> } | undefined;
    const served = serve(async (request) => {
      const body = await bodyOf(request);
      if (body?.method === "initialize") {
        claimed = body.params?.capabilities as typeof claimed;
      }
      return legacy(request);
    });
    const source = await connect(served.url);
    try {
      expect(source.getNegotiatedProtocolVersion()).toBe("2025-11-25");
      expect(claimed).toBeDefined();
      expect(claimed?.extensions?.[HOST_RESOURCES_CAPABILITY_KEY]).toBeUndefined();
    } finally {
      await source.stop();
      served.close();
    }
  });

  it("is absent from every 2026-07-28 request envelope, the probe included", async () => {
    const modern = modernServer({ extensions: { [TASKS_EXTENSION_ID]: {} } });
    const envelopes: Array<{ method: string; extensions: Record<string, unknown> }> = [];
    const served = serve(async (request) => {
      const body = await bodyOf(request);
      const caps = body?.params?._meta?.[CLIENT_CAPABILITIES_META_KEY] as
        | { extensions?: Record<string, unknown> }
        | undefined;
      if (body?.method && caps) {
        envelopes.push({ method: body.method, extensions: caps.extensions ?? {} });
      }
      return modern(request);
    });
    const source = await connect(served.url, { connector: true });
    try {
      expect(source.getNegotiatedProtocolVersion()).toBe("2026-07-28");
      await source.tools();
      // Every call to a server advertising the tasks extension takes the task
      // wire, so this covers the wire's own envelope too.
      await source.execute("echo", { text: "hi" });
      const methods = envelopes.map((e) => e.method);
      expect(methods).toContain("server/discover");
      expect(methods).toContain("tools/list");
      expect(methods).toContain("tools/call");
      for (const { extensions } of envelopes) {
        expect(extensions[HOST_RESOURCES_CAPABILITY_KEY]).toBeUndefined();
      }
    } finally {
      await source.stop();
      served.close();
    }
  });
});

/**
 * A SEP-2663 server that tasks every opted-in `tools/call` and answers each
 * `tasks/get` with `status`, recording the methods it was sent.
 */
function sep2663Server(status: "working" | "input_required"): { served: Served; seen: string[] } {
  const modern = modernServer({ extensions: { [TASKS_EXTENSION_ID]: {} } });
  const now = new Date().toISOString();
  const seen: string[] = [];
  const task = { taskId: "t-held", createdAt: now, lastUpdatedAt: now, ttlMs: 60_000, pollIntervalMs: 10 };
  const served = serve(async (request) => {
    const body = await bodyOf(request);
    if (body?.method === "tools/call" || body?.method?.startsWith("tasks/")) {
      seen.push(String(body.method));
      if (body.method === "tools/call") return answer(body.id, { resultType: "task", status: "working", ...task });
      if (body.method === "tasks/get") return answer(body.id, { resultType: "complete", status, ...task });
      return answer(body.id, { resultType: "complete" });
    }
    return modern(request);
  });
  return { served, seen };
}

describe("the task wire", () => {
  it("drives a 2025-era task: task-augmented tools/call, tasks/get, tasks/result", async () => {
    const legacy = legacyServer({ taskTools: true });
    const now = new Date().toISOString();
    const seen: string[] = [];
    let polls = 0;
    const served = serve(async (request) => {
      const body = await bodyOf(request);
      if (body?.method === "tools/call" && body.params?.task) {
        seen.push("tools/call+task");
        return answer(body.id, {
          task: { taskId: "t-legacy", status: "working", createdAt: now, lastUpdatedAt: now, ttl: 60_000, pollInterval: 10 },
        });
      }
      if (body?.method === "tasks/get") {
        seen.push("tasks/get");
        polls++;
        return answer(body.id, {
          taskId: "t-legacy",
          status: polls < 2 ? "working" : "completed",
          createdAt: now,
          lastUpdatedAt: now,
          ttl: 60_000,
          pollInterval: 10,
        });
      }
      if (body?.method === "tasks/result") {
        seen.push("tasks/result");
        return answer(body.id, { content: [{ type: "text", text: "researched (2025)" }] });
      }
      return legacy(request);
    });
    const source = await connect(served.url);
    try {
      // The 2025 task marker rides the listing, which the runtime reads before
      // any call; a call to a tool it has not listed goes inline.
      expect((await source.tools())[0]?.execution?.taskSupport).toBe("optional");
      const result = await source.execute("echo", { text: "deep" });
      expect(result.content).toEqual([{ type: "text", text: "researched (2025)" }]);
      expect(seen).toEqual(["tools/call+task", "tasks/get", "tasks/get", "tasks/result"]);
    } finally {
      await source.stop();
      served.close();
    }
  });

  it("drives a SEP-2663 task: opts in per request, polls tasks/get, reads the inlined result", async () => {
    const modern = modernServer({ extensions: { [TASKS_EXTENSION_ID]: {} } });
    const now = new Date().toISOString();
    const seen: Array<{ method: string; version: string | null; name: string | null }> = [];
    let polls = 0;
    const served = serve(async (request) => {
      const body = await bodyOf(request);
      const caps = body?.params?._meta?.[CLIENT_CAPABILITIES_META_KEY] as
        | { extensions?: Record<string, unknown> }
        | undefined;
      const record = () =>
        seen.push({
          method: String(body?.method),
          version: request.headers.get("mcp-protocol-version"),
          name: request.headers.get("mcp-name"),
        });
      if (body?.method === "tools/call" && caps?.extensions?.[TASKS_EXTENSION_ID]) {
        record();
        return answer(body.id, {
          resultType: "task",
          taskId: "t-modern",
          status: "working",
          createdAt: now,
          lastUpdatedAt: now,
          ttlMs: 60_000,
          pollIntervalMs: 10,
        });
      }
      if (body?.method === "tasks/get") {
        record();
        polls++;
        const done = polls >= 2;
        return answer(body.id, {
          resultType: "complete",
          taskId: "t-modern",
          status: done ? "completed" : "working",
          createdAt: now,
          lastUpdatedAt: now,
          ttlMs: 60_000,
          pollIntervalMs: 10,
          ...(done ? { result: { content: [{ type: "text", text: "researched (2026)" }] } } : {}),
        });
      }
      return modern(request);
    });
    const source = await connect(served.url);
    try {
      expect(source.getNegotiatedProtocolVersion()).toBe("2026-07-28");
      const result = await source.execute("echo", { text: "deep" });
      expect(result.content).toEqual([{ type: "text", text: "researched (2026)" }]);
      // The transport derived the era's standard headers from the envelope the
      // task wire attached: the version on every request, the task id as
      // `Mcp-Name` on each poll.
      expect(seen).toEqual([
        { method: "tools/call", version: "2026-07-28", name: "echo" },
        { method: "tasks/get", version: "2026-07-28", name: "t-modern" },
        { method: "tasks/get", version: "2026-07-28", name: "t-modern" },
      ]);
    } finally {
      await source.stop();
      served.close();
    }
  });

  it("sends tasks/cancel when the caller abandons a SEP-2663 task", async () => {
    const { served, seen } = sep2663Server("working");
    const source = await connect(served.url);
    try {
      const abort = new AbortController();
      const pending = source.execute("echo", { text: "deep" }, abort.signal);
      await Bun.sleep(300);
      abort.abort();
      await pending;
      expect(seen).toContain("tasks/cancel");
    } finally {
      await source.stop();
      served.close();
    }
  });

  it("cancels and reports a SEP-2663 task that asks for input", async () => {
    const { served, seen } = sep2663Server("input_required");
    const source = await connect(served.url);
    try {
      const result = await source.execute("echo", { text: "deep" });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("asked for input");
      expect(seen).toEqual(["tools/call", "tasks/get", "tasks/cancel"]);
    } finally {
      await source.stop();
      served.close();
    }
  });

  it("takes a SEP-2663 server's complete answer when it chooses not to task the call", async () => {
    const served = serve(modernServer({ extensions: { [TASKS_EXTENSION_ID]: {} } }));
    const source = await connect(served.url);
    try {
      const result = await source.execute("echo", { text: "quick" });
      expect(result.content).toEqual([{ type: "text", text: "echo:quick" }]);
    } finally {
      await source.stop();
      served.close();
    }
  });
});

// ── Server role ─────────────────────────────────────────────────────

class FixtureSource implements ToolSource {
  readonly name = "fixture";
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async tools(): Promise<Tool[]> {
    return [
      {
        name: "fixture__greet",
        description: "Greets",
        inputSchema: { type: "object", properties: { name: { type: "string" } } },
        source: "inline",
      },
    ];
  }
  async execute(_toolName: string, input: Record<string, unknown>): Promise<ToolResult> {
    return { content: textContent(`hello ${String(input.name)}`), isError: false };
  }
}

describe("/mcp/<wsId> on both eras", () => {
  let runtime: Runtime;
  let handle: ServerHandle;
  let workDir: string;
  // Watches the whole block, so the era log test sees every client that arrived.
  let info: ReturnType<typeof spyOn<typeof log, "info">>;

  beforeAll(async () => {
    info = spyOn(log, "info");
    workDir = await mkdtemp(join(tmpdir(), "nb-mcp-era-"));
    runtime = await Runtime.start({
      identityProvider: devProvider,
      model: { provider: "custom", adapter: createEchoModel() },
      logging: { disabled: true },
      workDir,
    });
    await provisionTestWorkspace(runtime);
    runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID).addSource(new SharedSourceRef(new FixtureSource()));
    handle = startServer({ runtime, port: 0});
  });

  afterAll(async () => {
    info.mockRestore();
    handle.stop(true);
    await runtime.shutdown();
    rmSync(workDir, { recursive: true, force: true });
  });

  async function client(negotiate: boolean): Promise<Client> {
    const c = new Client(
      { name: "era-test", version: "1.0.0" },
      negotiate ? { versionNegotiation: { mode: "auto" } } : {},
    );
    await c.connect(
      new StreamableHTTPClientTransport(new URL(`http://localhost:${handle.port}/mcp/${TEST_WORKSPACE_ID}`)),
    );
    return c;
  }

  it.each([
    { era: "modern", negotiate: true, version: "2026-07-28" },
    { era: "legacy", negotiate: false, version: "2025-11-25" },
  ])("serves a $era client the workspace's bare tool names and routes a call by one", async ({
    era,
    negotiate,
    version,
  }) => {
    const c = await client(negotiate);
    try {
      expect(c.getProtocolEra()).toBe(era as "modern" | "legacy");
      expect(c.getNegotiatedProtocolVersion()).toBe(version);
      const names = (await c.listTools()).tools.map((t) => t.name);
      expect(names).toContain("fixture__greet");
      const result = await c.callTool({ name: "fixture__greet", arguments: { name: "era" } });
      expect(result.content).toEqual([{ type: "text", text: "hello era" }]);
      // A retired `ws_<id>-` name addresses no workspace on either era.
      await expect(
        c.callTool({ name: `ws_${TEST_WORKSPACE_ID}-fixture__greet`, arguments: {} }),
      ).rejects.toMatchObject({ code: -32602 });
    } finally {
      await c.close();
    }
  });

  // The door logs which era each kind of client arrives on, once per (era,
  // User-Agent), so production traffic shows who still needs the 2025 leg.
  // Every client here shares one User-Agent, so each era logs exactly once.
  it("logs each client's era once", async () => {
    for (const negotiate of [true, false, true, false]) {
      const c = await client(negotiate);
      await c.listTools();
      await c.close();
    }
    const eraLines = info.mock.calls
      .map((args) => String(args[0]))
      .filter((line) => line.startsWith("[mcp] client era="));
    expect(eraLines.filter((l) => l.includes("era=modern"))).toHaveLength(1);
    expect(eraLines.filter((l) => l.includes("era=legacy"))).toHaveLength(1);
  });
});
