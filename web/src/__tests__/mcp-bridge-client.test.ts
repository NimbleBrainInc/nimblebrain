// ---------------------------------------------------------------------------
// mcp-bridge-client — one stateless request at a time to `/mcp/<wsId>` on
// MCP 2026-07-28
//
// Pins what reaches the wire (the `_meta` envelope naming 2026-07-28, the
// standard headers the server checks against the body, the
// tasks opt-in), where it goes (the active workspace's path, read per
// request), whose credentials it carries (read per request, refreshed through
// the shared interceptor), and how each kind of answer comes back.
//
// Uses the preload's snapshot of the real module (`realMcpBridgeClient`):
// bridge suites replace this module process-wide with `mock.module`.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { realClient, realMcpBridgeClient } from "../../test/setup";

const { buildMcpRequest, readMcpAnswer, sendMcpRequest } = realMcpBridgeClient;
const { setActiveWorkspaceId, setAuthToken } = realClient;

const ENVELOPE = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "nimblebrain-web", version: "1.0.0" },
};

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

let calls: Captured[] = [];
let respond: (url: string) => Response | Promise<Response> = () => jsonAnswer({ content: [] });
const originalFetch = globalThis.fetch;

function jsonAnswer(result: unknown, status = 200): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", result }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  calls = [];
  respond = () => jsonAnswer({ content: [] });
  setAuthToken("initial-token");
  setActiveWorkspaceId("ws-initial");
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url, headers, body });
    // Like a real fetch, an abort rejects a request still waiting on its response.
    const signal = init?.signal;
    const aborted = new Promise<never>((_, reject) =>
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
    );
    return Promise.race([respond(url), aborted]);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  setAuthToken(null);
  setActiveWorkspaceId(null);
});

describe("buildMcpRequest — the 2026-07-28 envelope and headers", () => {
  test("a tools/call carries the envelope beside the caller's _meta, and names its tool", () => {
    const { headers, body } = buildMcpRequest("id-1", "tools/call", {
      name: "research__search",
      arguments: { q: "mcp" },
      _meta: { "ai.nimblebrain/source": "research" },
    });

    expect(JSON.parse(body)).toEqual({
      jsonrpc: "2.0",
      id: "id-1",
      method: "tools/call",
      params: {
        name: "research__search",
        arguments: { q: "mcp" },
        _meta: {
          "ai.nimblebrain/source": "research",
          ...ENVELOPE,
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    });
    expect(headers).toEqual({
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      "mcp-name": "research__search",
    });
  });

  test("an opted-in request claims the tasks extension", () => {
    const { body } = buildMcpRequest("id-2", "tools/call", { name: "t" }, { tasks: true });
    expect(JSON.parse(body).params._meta["io.modelcontextprotocol/clientCapabilities"]).toEqual({
      extensions: { "io.modelcontextprotocol/tasks": {} },
    });
  });

  test("the envelope cannot be overridden by the caller's _meta", () => {
    const { body } = buildMcpRequest("id-3", "resources/list", {
      _meta: { "io.modelcontextprotocol/protocolVersion": "2025-11-25" },
    });
    expect(JSON.parse(body).params._meta["io.modelcontextprotocol/protocolVersion"]).toBe(
      "2026-07-28",
    );
  });

  test("Mcp-Name names a read's URI and a task request's task id; a listing has none", () => {
    expect(
      buildMcpRequest("a", "resources/read", { uri: "ui://notes/app" }).headers["mcp-name"],
    ).toBe("ui://notes/app");
    expect(buildMcpRequest("b", "tasks/get", { taskId: "abc" }).headers["mcp-name"]).toBe("abc");
    expect(buildMcpRequest("c", "tasks/cancel", { taskId: "abc" }).headers["mcp-name"]).toBe("abc");
    expect(buildMcpRequest("d", "resources/list", {}).headers["mcp-name"]).toBeUndefined();
  });

  test("an Mcp-Name that is not plain ASCII travels base64-encoded in the sentinel", () => {
    const name = buildMcpRequest("e", "resources/read", { uri: "files://café" }).headers[
      "mcp-name"
    ];
    expect(name).toBe(`=?base64?${Buffer.from("files://café").toString("base64")}?=`);
  });
});

describe("readMcpAnswer", () => {
  test("a JSON result", async () => {
    expect(await readMcpAnswer(jsonAnswer({ resultType: "task", taskId: "t" }))).toEqual({
      result: { resultType: "task", taskId: "t" },
    });
  });

  test("a JSON-RPC error keeps its code and data, whatever the HTTP status", async () => {
    const res = new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32020, message: "mismatch", data: 1 },
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
    expect(await readMcpAnswer(res)).toEqual({
      error: { code: -32020, message: "mismatch", data: 1 },
    });
  });

  test("an SSE body answers with the response event, past any notification", async () => {
    const sse = [
      'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}',
      'event: message\ndata: {"jsonrpc":"2.0","id":"x","result":{"content":[]}}',
      "",
    ].join("\n\n");
    const res = new Response(sse, { headers: { "content-type": "text/event-stream" } });
    expect(await readMcpAnswer(res)).toEqual({ result: { content: [] } });
  });

  test("a body that is no JSON-RPC answer rejects with its status", async () => {
    const res = new Response("Bad Gateway", { status: 502 });
    await expect(readMcpAnswer(res)).rejects.toThrow("HTTP 502");
  });
});

describe("sendMcpRequest", () => {
  test("posts to the active workspace's /mcp path, read per request", async () => {
    await sendMcpRequest("resources/list", {});
    setActiveWorkspaceId("ws-other");
    await sendMcpRequest("resources/list", {});

    expect(new URL(calls[0]?.url ?? "").pathname).toBe("/mcp/ws-initial");
    expect(new URL(calls[1]?.url ?? "").pathname).toBe("/mcp/ws-other");
    expect(calls[0]?.body?.method).toBe("resources/list");
  });

  test("rejects with no active workspace, and sends nothing", async () => {
    setActiveWorkspaceId(null);
    await expect(sendMcpRequest("resources/list", {})).rejects.toThrow("No active workspace");
    expect(calls).toHaveLength(0);
  });

  test("resolves the server's answer, a refusal included", async () => {
    respond = () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32602, message: "not callable", data: { reason: "not_app_callable" } },
        }),
        { headers: { "content-type": "application/json" } },
      );
    expect(await sendMcpRequest("tools/call", { name: "t" })).toEqual({
      error: { code: -32602, message: "not callable", data: { reason: "not_app_callable" } },
    });
  });

  test("a request with no answer in time is -32001", async () => {
    respond = () => new Promise<Response>(() => {});
    const answer = await sendMcpRequest("tools/call", { name: "t" }, { timeoutMs: 10 });
    expect("error" in answer && answer.error.code).toBe(-32001);
  });

  test("reads the token on each request, and names no workspace in a header", async () => {
    await sendMcpRequest("resources/list", {});
    setAuthToken("rotated-token");
    await sendMcpRequest("resources/list", {});

    expect(calls[0]?.headers.authorization).toBe("Bearer initial-token");
    expect(calls[1]?.headers.authorization).toBe("Bearer rotated-token");
    expect(calls.every((c) => c.headers["x-workspace-id"] === undefined)).toBe(true);
  });

  test("a 401 silently refreshes the session and retries (idle-expiry bug)", async () => {
    // A user parked on a rendered app produces nothing but bridge traffic, so
    // the bridge must drive the refresh itself, through the REST client's
    // shared interceptor.
    setAuthToken("__cookie__");
    let mcpCalls = 0;
    respond = (url) => {
      if (url.includes("/v1/auth/refresh")) return new Response("{}", { status: 200 });
      mcpCalls += 1;
      return mcpCalls === 1 ? new Response("{}", { status: 401 }) : jsonAnswer({ content: [] });
    };

    expect(await sendMcpRequest("tools/call", { name: "t" })).toEqual({
      result: { content: [] },
    });
    expect(calls.map((c) => c.url.replace(/^https?:\/\/[^/]+/, ""))).toEqual([
      "/mcp/ws-initial",
      "/v1/auth/refresh",
      "/mcp/ws-initial",
    ]);
  });

  test("cookie mode sends no Authorization header", async () => {
    setAuthToken("__cookie__");
    await sendMcpRequest("resources/list", {});
    expect(calls[0]?.headers.authorization).toBeUndefined();
  });

  test("sends no Authorization header when unauthenticated", async () => {
    setAuthToken(null);
    await sendMcpRequest("resources/list", {});
    expect(calls[0]?.headers.authorization).toBeUndefined();
  });
});
