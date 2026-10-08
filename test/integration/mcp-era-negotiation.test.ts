/**
 * The runtime on both protocol eras.
 *
 * Client role: one `McpSource` against a 2025-only server and a 2026-07-28
 * server, the same assertions on each — the negotiated version, tools, a tool
 * call, a `ui://` read, and the extensions the server advertises. The task wire
 * against a SEP-2663 server, a 2025 server's task-marked tools called inline or
 * refused (ADR-0046), and the legacy retry after a
 * probe that meets an HTTP 500 (and not after a gateway's 502/503/504).
 *
 * Server role: `/mcp/<wsId>` serving a 2026-07-28 client by bare,
 * workspace-walled tool names, and refusing a client that speaks only 2025.
 *
 * A 2026 server has no in-memory transport (the SDK's `InMemoryTransport`
 * links 2025-era instances only), so the connector servers here are HTTP: the
 * SDK's `createMcpHandler` for the modern one, its `legacyStatelessFallback`
 * for a server that predates `server/discover`.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
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
import { Runtime } from "../../src/runtime/runtime.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";
import { TASKS_EXTENSION_ID } from "../../src/tools/mcp-task-client.ts";
import { SharedSourceRef } from "../../src/tools/registry.ts";
import type { Tool, ToolSource } from "../../src/tools/types.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

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
function buildServer(
  opts: {
    extensions?: ServerCapabilities["extensions"];
    taskSupport?: "optional" | "required";
  } = {},
) {
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
        ...(opts.taskSupport ? { execution: { taskSupport: opts.taskSupport } } : {}),
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
          workspaceId: "ws_0032146faed2deb5",
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
    let claimed: { extensions?: Record<string, unknown> } | undefined;
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
      expect(claimed?.extensions?.[FACETS]).toBeDefined();
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
  const task = {
    taskId: "t-held",
    createdAt: now,
    lastUpdatedAt: now,
    ttlMs: 60_000,
    pollIntervalMs: 10,
  };
  const served = serve(async (request) => {
    const body = await bodyOf(request);
    if (body?.method === "tools/call" || body?.method?.startsWith("tasks/")) {
      seen.push(String(body.method));
      if (body.method === "tools/call")
        return answer(body.id, { resultType: "task", status: "working", ...task });
      if (body.method === "tasks/get")
        return answer(body.id, { resultType: "complete", status, ...task });
      return answer(body.id, { resultType: "complete" });
    }
    return modern(request);
  });
  return { served, seen };
}

describe("the task wire", () => {
  /** A 2025-only server whose `echo` carries `taskSupport`, recording every request it sees. */
  function legacyTaskServer(taskSupport: "optional" | "required") {
    const legacy = legacyServer({ taskSupport });
    const seen: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const served = serve(async (request) => {
      const body = await bodyOf(request);
      if (body?.method) seen.push({ method: body.method, params: body.params });
      return legacy(request);
    });
    return { served, seen };
  }

  it("calls a 2025-era tool whose taskSupport is optional inline, attaching no task", async () => {
    const { served, seen } = legacyTaskServer("optional");
    const source = await connect(served.url);
    try {
      expect(source.getNegotiatedProtocolVersion()).toBe("2025-11-25");
      expect((await source.tools())[0]?.execution?.taskSupport).toBe("optional");
      const result = await source.execute("echo", { text: "deep" });
      expect(result.isError).toBe(false);
      expect(result.content).toEqual([{ type: "text", text: "echo:deep" }]);
      const calls = seen.filter((r) => r.method === "tools/call");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.params?.task).toBeUndefined();
      expect(seen.some((r) => r.method.startsWith("tasks/"))).toBe(false);
      // Nor does the handshake claim the 2025 tasks capability.
      const init = seen.find((r) => r.method === "initialize");
      expect((init?.params?.capabilities as Record<string, unknown>)?.tasks).toBeUndefined();
    } finally {
      await source.stop();
      served.close();
    }
  });

  it("starts a 2025-era tool as an already-completed task, calling it inline", async () => {
    const { served, seen } = legacyTaskServer("optional");
    const source = await connect(served.url);
    const ownerContext = { workspaceId: "ws-test" };
    try {
      await source.tools();
      const { task } = await source.startToolAsTask("echo", { text: "deep" }, { ownerContext });
      expect(task.taskId).toStartWith("nb-inline-");
      expect(task.status).toBe("completed");
      const result = await source.awaitToolTaskResult(task.taskId, { ownerContext });
      expect(result.content).toEqual([{ type: "text", text: "echo:deep" }]);
      expect((await source.getTaskStatus(task.taskId, { ownerContext })).status).toBe("completed");
      const calls = seen.filter((r) => r.method === "tools/call");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.params?.task).toBeUndefined();
      expect(seen.some((r) => r.method.startsWith("tasks/"))).toBe(false);
    } finally {
      await source.stop();
      served.close();
    }
  });

  it("refuses a 2025-era tool whose taskSupport is required before dispatch, naming the reason", async () => {
    const { served, seen } = legacyTaskServer("required");
    const source = await connect(served.url);
    try {
      expect((await source.tools())[0]?.execution?.taskSupport).toBe("required");
      const result = await source.execute("echo", { text: "deep" });
      expect(result.isError).toBe(true);
      const text = JSON.stringify(result.content);
      expect(text).toContain("2025-11-25 tasks utility");
      expect(text).toContain("ADR-0046");
      expect(seen.some((r) => r.method === "tools/call")).toBe(false);
      expect(seen.some((r) => r.method.startsWith("tasks/"))).toBe(false);
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

  // A call made for a `/mcp` client keeps the task path, which polls to
  // completion: an inline call would run under the request timeout instead.
  it("takes the task path for a call made for a /mcp client", async () => {
    const { served, seen } = sep2663Server("input_required");
    const source = await connect(served.url);
    try {
      await source.execute("echo", { text: "deep" }, undefined, { caller: { capabilities: {} } });
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

describe("/mcp/<wsId> serves 2026-07-28 only", () => {
  let runtime: Runtime;
  let handle: ServerHandle;
  let workDir: string;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "nb-mcp-era-"));
    runtime = await Runtime.start({
      identityProvider: devProvider,
      languageModel: createEchoModel(),
      logging: { disabled: true },
      workDir,
    });
    await provisionTestWorkspace(runtime);
    runtime
      .getRegistryForWorkspace(TEST_WORKSPACE_ID)
      .addSource(new SharedSourceRef(new FixtureSource()));
    handle = startServer({ runtime, port: 0 });
  });

  afterAll(async () => {
    handle.stop(true);
    await runtime.shutdown();
    rmSync(workDir, { recursive: true, force: true });
  });

  function client(negotiate: boolean): Client {
    return new Client(
      { name: "era-test", version: "1.0.0" },
      negotiate ? { versionNegotiation: { mode: "auto" } } : {},
    );
  }

  function transport(): StreamableHTTPClientTransport {
    return new StreamableHTTPClientTransport(
      new URL(`http://localhost:${handle.port}/mcp/${TEST_WORKSPACE_ID}`),
    );
  }

  it("serves a negotiating client on 2026-07-28, by bare tool names", async () => {
    const c = client(true);
    await c.connect(transport());
    try {
      expect(c.getProtocolEra()).toBe("modern");
      expect(c.getNegotiatedProtocolVersion()).toBe("2026-07-28");
      const names = (await c.listTools()).tools.map((t) => t.name);
      expect(names).toContain("fixture__greet");
      const result = await c.callTool({ name: "fixture__greet", arguments: { name: "era" } });
      expect(result.content).toEqual([{ type: "text", text: "hello era" }]);
      // A retired `ws_<id>-` name addresses no workspace.
      await expect(
        c.callTool({ name: `ws_${TEST_WORKSPACE_ID}-fixture__greet`, arguments: {} }),
      ).rejects.toMatchObject({ code: -32602 });
    } finally {
      await c.close();
    }
  });

  it("refuses a client that speaks only 2025-11-25", async () => {
    await expect(client(false).connect(transport())).rejects.toThrow(
      /Unsupported protocol version/,
    );
  });
});
