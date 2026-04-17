import { describe, expect, it } from "bun:test";
import { bytesToBase64, handleReadResource } from "../../../src/api/handlers.ts";
import type { Runtime } from "../../../src/runtime/runtime.ts";
import type { ResourceData } from "../../../src/tools/types.ts";

interface StubOptions {
  sources?: string[];
  resource?: ResourceData | null;
  captureCall?: (args: { server: string; uri: string; workspaceId: string }) => void;
}

function makeStubRuntime(opts: StubOptions = {}): Runtime {
  const sources = new Set(opts.sources ?? ["calendar"]);
  const registry = {
    hasSource: (name: string) => sources.has(name),
  };
  return {
    ensureWorkspaceRegistry: async () => registry,
    readAppResource: async (server: string, uri: string, workspaceId: string) => {
      opts.captureCall?.({ server, uri, workspaceId });
      return opts.resource === undefined ? null : opts.resource;
    },
  } as unknown as Runtime;
}

function req(body: unknown): Request {
  return new Request("http://x/v1/resources/read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("handleReadResource", () => {
  it("rejects missing workspaceId with 400", async () => {
    const runtime = makeStubRuntime();
    const res = await handleReadResource(
      req({ server: "calendar", uri: "ui://calendar/main" }),
      runtime,
      {},
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("bad_request");
  });

  it("rejects missing server with 400", async () => {
    const runtime = makeStubRuntime();
    const res = await handleReadResource(req({ uri: "ui://x/y" }), runtime, { workspaceId: "w" });
    expect(res.status).toBe(400);
  });

  it("rejects missing uri with 400", async () => {
    const runtime = makeStubRuntime();
    const res = await handleReadResource(req({ server: "calendar" }), runtime, {
      workspaceId: "w",
    });
    expect(res.status).toBe(400);
  });

  it("returns 403 for servers outside the workspace", async () => {
    const runtime = makeStubRuntime({ sources: ["other"] });
    const res = await handleReadResource(
      req({ server: "calendar", uri: "ui://calendar/main" }),
      runtime,
      { workspaceId: "w1" },
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("workspace_access_denied");
  });

  it("returns 404 when the resource is missing", async () => {
    const runtime = makeStubRuntime({ resource: null });
    const res = await handleReadResource(
      req({ server: "calendar", uri: "ui://calendar/missing" }),
      runtime,
      { workspaceId: "w1" },
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("resource_not_found");
  });

  it("returns ReadResourceResult shape for text resources", async () => {
    const runtime = makeStubRuntime({
      resource: { text: "hello world", mimeType: "text/plain" },
    });
    const res = await handleReadResource(
      req({ server: "calendar", uri: "ui://calendar/greeting" }),
      runtime,
      { workspaceId: "w1" },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.contents).toHaveLength(1);
    expect(body.contents[0]).toEqual({
      uri: "ui://calendar/greeting",
      mimeType: "text/plain",
      text: "hello world",
    });
  });

  it("base64-encodes binary resources into the blob field", async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0xff, 0xfe]);
    const runtime = makeStubRuntime({
      resource: { blob: bytes, mimeType: "application/pdf" },
    });
    const res = await handleReadResource(
      req({ server: "calendar", uri: "collateral://exports/e.pdf" }),
      runtime,
      { workspaceId: "w1" },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.contents[0].uri).toBe("collateral://exports/e.pdf");
    expect(body.contents[0].mimeType).toBe("application/pdf");
    expect(body.contents[0].text).toBeUndefined();
    expect(body.contents[0].blob).toBe(bytesToBase64(bytes));
  });

  it("passes the uri through to readAppResource as-is (any scheme)", async () => {
    const calls: Array<{ server: string; uri: string; workspaceId: string }> = [];
    const runtime = makeStubRuntime({
      resource: { text: "{}", mimeType: "application/json" },
      captureCall: (c) => calls.push(c),
    });
    await handleReadResource(
      req({ server: "calendar", uri: "custom://whatever/123" }),
      runtime,
      { workspaceId: "w1" },
    );
    expect(calls).toEqual([{ server: "calendar", uri: "custom://whatever/123", workspaceId: "w1" }]);
  });

  it("returns 400 for invalid JSON body", async () => {
    const runtime = makeStubRuntime();
    const res = await handleReadResource(
      new Request("http://x/v1/resources/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      }),
      runtime,
      { workspaceId: "w1" },
    );
    expect(res.status).toBe(400);
  });
});

describe("bytesToBase64", () => {
  it("matches btoa for small inputs", () => {
    const bytes = new Uint8Array([0x68, 0x69]); // "hi"
    expect(bytesToBase64(bytes)).toBe(btoa("hi"));
  });

  it("handles empty buffers", () => {
    expect(bytesToBase64(new Uint8Array())).toBe("");
  });

  it("round-trips arbitrary binary content", () => {
    const bytes = new Uint8Array(70_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    const encoded = bytesToBase64(bytes);
    const decoded = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
    expect(decoded).toEqual(bytes);
  });
});
