import { describe, expect, it } from "bun:test";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { McpServerHost } from "../../../src/api/mcp-server.ts";
import type { ApiErrorBody, JsonRpcErrorBody } from "../../../src/api/schemas/responses.ts";
import { resolveFeatures } from "../../../src/config/features.ts";
import { readJson } from "../../helpers/http.ts";
import { MCP_PROTOCOL_VERSION } from "../../helpers/mcp-client.ts";

const LIMIT = 1_048_576;
const CHUNK = 4096;

function body(method: string, modern = true): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 7,
    method,
    params: {
      ...(method.startsWith("tasks/") ? { taskId: "missing" } : {}),
      ...(modern
        ? {
            _meta: {
              [PROTOCOL_VERSION_META_KEY]: MCP_PROTOCOL_VERSION,
              [CLIENT_INFO_META_KEY]: { name: "body-limit-test", version: "1" },
              [CLIENT_CAPABILITIES_META_KEY]: {},
            },
          }
        : {}),
    },
  });
}

function streamedRequest(text: string, method: string, contentLength?: string) {
  const bytes = new TextEncoder().encode(text);
  let received = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (received === bytes.length) return controller.close();
        const end = Math.min(received + CHUNK, bytes.length);
        controller.enqueue(bytes.subarray(received, end));
        received = end;
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return {
    request: new Request("http://localhost/mcp/ws_0000000000000001", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
        "Mcp-Method": method,
        ...(method.startsWith("tasks/") ? { "Mcp-Name": "missing" } : {}),
        ...(contentLength === undefined ? {} : { "Content-Length": contentLength }),
      },
      body: stream,
    }),
    received: () => received,
    cancelled: () => cancelled,
  };
}

function handle(request: Request): Promise<Response> {
  return new McpServerHost().handle(request, resolveFeatures(), {
    identity: null,
    workspaceId: "ws_0000000000000001",
    grant: "first_party",
  });
}

describe("MCP request body boundary", () => {
  it.each([
    ["tasks/get", undefined],
    ["tasks/get", "1"],
    ["tools/list", undefined],
    ["tools/list", "invalid"],
  ])("refuses oversized %s with Content-Length %p before parsing", async (method, length) => {
    const input = streamedRequest(body(method).padEnd(2 * LIMIT), method, length);
    const response = await handle(input.request);
    expect(response.status).toBe(413);
    expect((await readJson<ApiErrorBody>(response)).error).toBe("payload_too_large");
    expect(input.received()).toBeLessThanOrEqual(LIMIT + CHUNK);
    expect(input.cancelled()).toBe(true);
  });

  it("refuses an oversized legacy body before protocol classification", async () => {
    const input = streamedRequest(body("tools/list", false).padEnd(2 * LIMIT), "tools/list");
    input.request.headers.delete("MCP-Protocol-Version");
    const response = await handle(input.request);
    expect(response.status).toBe(413);
    expect(input.received()).toBeLessThanOrEqual(LIMIT + CHUNK);
    expect(input.cancelled()).toBe(true);
  });

  it("counts UTF-8 bytes rather than characters", async () => {
    const input = streamedRequest(
      body("tasks/get").replace('"missing"', JSON.stringify("é".repeat(LIMIT / 2))),
      "tasks/get",
    );
    expect((await handle(input.request)).status).toBe(413);
  });

  it("serves modern task requests at the byte limit", async () => {
    const input = streamedRequest(body("tasks/get").padEnd(LIMIT), "tasks/get");
    const response = await handle(input.request);
    expect(response.status).toBe(200);
    expect((await readJson<JsonRpcErrorBody>(response)).error.code).toBe(-32602);
    expect(input.received()).toBe(LIMIT);
    expect(input.cancelled()).toBe(false);
  });

  it("preserves the SDK's modern response and legacy refusal", async () => {
    const modern = await handle(streamedRequest(body("tools/list"), "tools/list").request);
    expect(modern.status).toBe(200);
    expect(await modern.text()).toContain('"tools":[]');
    const legacy = streamedRequest(body("tools/list", false), "tools/list").request;
    legacy.headers.delete("MCP-Protocol-Version");
    const response = await handle(legacy);
    expect(response.status).toBe(400);
    expect((await readJson<JsonRpcErrorBody>(response)).error.code).toBe(-32022);
  });
});
