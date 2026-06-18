import { afterEach, describe, expect, it } from "bun:test";
import { handleReadResource } from "../../../src/api/handlers.ts";
import { artifactResolutionsTotal } from "../../../src/api/metrics.ts";
import {
  ArtifactNotFoundError,
  type ArtifactResolver,
  ArtifactTooLargeError,
  InvalidArtifactUriError,
  setArtifactResolver,
} from "../../../src/host-resources/artifacts/index.ts";
import type { Runtime } from "../../../src/runtime/runtime.ts";
import type { ResourceData } from "../../../src/tools/types.ts";
import { bytesToBase64 } from "../../../src/util/base64.ts";

/**
 * Inject a fake `artifact://` resolver whose `read` runs `impl`. Only `read` is
 * exercised by the handler, so a partial cast is the whole seam.
 */
function stubArtifactResolver(impl: (uri: string, ws: string) => unknown): void {
  setArtifactResolver({
    read: async (uri: string, ws: string) => impl(uri, ws),
  } as unknown as ArtifactResolver);
}

interface StubOptions {
  sources?: string[];
  identitySources?: string[];
  resource?: ResourceData | null;
  /** Workspace ids the calling identity is a member of (for qualified-name resolution). */
  memberOf?: string[];
  captureCall?: (args: { server: string; uri: string; workspaceId: string }) => void;
  captureIdentityCall?: (args: { server: string; uri: string }) => void;
}

function makeStubRuntime(opts: StubOptions = {}): Runtime {
  const sources = new Set(opts.sources ?? ["calendar"]);
  const identitySources = new Set(opts.identitySources ?? []);
  const memberOf = opts.memberOf ?? [];
  const registry = {
    hasSource: (name: string) => sources.has(name),
  };
  return {
    getIdentitySource: (name: string) => (identitySources.has(name) ? { name } : undefined),
    ensureWorkspaceRegistry: async () => registry,
    getWorkspaceStore: () => ({
      getWorkspacesForUser: async () => memberOf.map((id) => ({ id })),
    }),
    readAppResource: async (server: string, uri: string, workspaceId: string) => {
      opts.captureCall?.({ server, uri, workspaceId });
      return opts.resource === undefined ? null : opts.resource;
    },
    readIdentityAppResource: async (server: string, uri: string) => {
      opts.captureIdentityCall?.({ server, uri });
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

  it("routes an identity source to readIdentityAppResource with no workspace", async () => {
    const calls: Array<{ server: string; uri: string }> = [];
    const runtime = makeStubRuntime({
      identitySources: ["files"],
      resource: { text: "hello world\n", mimeType: "text/plain" },
      captureIdentityCall: (c) => calls.push(c),
    });
    // No workspaceId in options — an identity source must not require one.
    const res = await handleReadResource(
      req({ server: "files", uri: "files://fl_abc" }),
      runtime,
      {},
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.contents[0].text).toBe("hello world\n");
    expect(calls).toEqual([{ server: "files", uri: "files://fl_abc" }]);
  });

  it("returns 404 when an identity resource is missing", async () => {
    const runtime = makeStubRuntime({ identitySources: ["files"], resource: null });
    const res = await handleReadResource(req({ server: "files", uri: "files://fl_x" }), runtime, {});
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("resource_not_found");
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

  // Cross-workspace: a qualified `ws_<id>-<source>` server names its OWN
  // workspace. The owning workspace — not the ambient X-Workspace-Id — is
  // authoritative, and the registry/readAppResource are keyed on the BARE
  // source name. Regression for the preview-from-another-workspace 403.
  it("resolves a qualified server to its owning workspace, ignoring X-Workspace-Id", async () => {
    const calls: Array<{ server: string; uri: string; workspaceId: string }> = [];
    const runtime = makeStubRuntime({
      sources: ["synapse-collateral"], // registry keyed on the bare source name
      memberOf: ["ws_nimblebrain_shared"],
      resource: { text: "ok", mimeType: "text/plain" },
      captureCall: (c) => calls.push(c),
    });
    const res = await handleReadResource(
      req({ server: "ws_nimblebrain_shared-synapse-collateral", uri: "collateral://exports/e.pdf" }),
      runtime,
      // Ambient workspace is the user's PERSONAL workspace, not where the doc lives.
      { workspaceId: "ws_user_u1", identity: { id: "u1" } as never },
    );
    expect(res.status).toBe(200);
    // readAppResource gets the bare source + the workspace parsed from the name.
    expect(calls).toEqual([
      { server: "synapse-collateral", uri: "collateral://exports/e.pdf", workspaceId: "ws_nimblebrain_shared" },
    ]);
  });

  it("returns 403 for a qualified server the caller is not a member of", async () => {
    const runtime = makeStubRuntime({
      sources: ["synapse-collateral"],
      memberOf: ["ws_some_other"], // not a member of ws_nimblebrain_shared
      resource: { text: "ok", mimeType: "text/plain" },
    });
    const res = await handleReadResource(
      req({ server: "ws_nimblebrain_shared-synapse-collateral", uri: "collateral://exports/e.pdf" }),
      runtime,
      { workspaceId: "ws_user_u1", identity: { id: "u1" } as never },
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("workspace_access_denied");
  });

  it("returns 401 for a qualified server with no identity", async () => {
    const runtime = makeStubRuntime({ sources: ["synapse-collateral"], memberOf: ["ws_x"] });
    const res = await handleReadResource(
      req({ server: "ws_x-synapse-collateral", uri: "collateral://exports/e.pdf" }),
      runtime,
      { workspaceId: "ws_x" },
    );
    expect(res.status).toBe(401);
  });
});

describe("handleReadResource — artifact:// branch", () => {
  // The artifact resolver is a process-wide singleton (test seam). Reset it
  // after each case so an injected fake never leaks into another test.
  afterEach(() => setArtifactResolver(undefined));

  it("returns 400 when no workspace is in scope", async () => {
    const runtime = makeStubRuntime();
    let called = false;
    stubArtifactResolver(() => {
      called = true;
      return { contents: [] };
    });
    const res = await handleReadResource(req({ uri: "artifact://abc123" }), runtime, {});
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("bad_request");
    // The workspace gate fires before the resolver is ever consulted.
    expect(called).toBe(false);
  });

  it("maps ArtifactNotFoundError to 404", async () => {
    const runtime = makeStubRuntime();
    stubArtifactResolver(() => {
      throw new ArtifactNotFoundError("abc123");
    });
    const res = await handleReadResource(req({ uri: "artifact://abc123" }), runtime, {
      workspaceId: "w1",
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("resource_not_found");
  });

  it("maps ArtifactTooLargeError to 413", async () => {
    const runtime = makeStubRuntime();
    stubArtifactResolver(() => {
      throw new ArtifactTooLargeError(99, 8);
    });
    const res = await handleReadResource(req({ uri: "artifact://abc123" }), runtime, {
      workspaceId: "w1",
    });
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toBe("resource_too_large");
  });

  it("maps InvalidArtifactUriError (malformed id) to 400 bad_request", async () => {
    const runtime = makeStubRuntime();
    stubArtifactResolver((uri) => {
      throw new InvalidArtifactUriError(uri, "id must match the safe-id grammar");
    });
    // A prefix-valid but grammar-invalid id (the space fails the id RE).
    const res = await handleReadResource(req({ uri: "artifact://bad id" }), runtime, {
      workspaceId: "w1",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("bad_request");
  });

  it("maps an unexpected resolver error to 502 resource_read_failed", async () => {
    const runtime = makeStubRuntime();
    stubArtifactResolver(() => {
      throw new Error("data plane unreachable");
    });
    const res = await handleReadResource(req({ uri: "artifact://abc123" }), runtime, {
      workspaceId: "w1",
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("resource_read_failed");
  });

  it("returns 200 with the resolved resource on the happy path", async () => {
    const runtime = makeStubRuntime();
    const calls: Array<{ uri: string; ws: string }> = [];
    stubArtifactResolver((uri, ws) => {
      calls.push({ uri, ws });
      return { contents: [{ uri, mimeType: "text/plain", text: "resolved body" }] };
    });
    const res = await handleReadResource(req({ uri: "artifact://abc123" }), runtime, {
      workspaceId: "w1",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.contents).toEqual([
      { uri: "artifact://abc123", mimeType: "text/plain", text: "resolved body" },
    ]);
    // Read as the viewing user's verified workspace.
    expect(calls).toEqual([{ uri: "artifact://abc123", ws: "w1" }]);
  });

  // The counter is the only fleet-level signal that the host emitted a link it
  // then couldn't resolve — assert the not_found and ok branches record it.
  // Deltas, not absolutes: the counter is a process-global singleton other
  // cases in this file also touch.
  async function resolutionCount(result: string): Promise<number> {
    const metric = await artifactResolutionsTotal.get();
    return metric.values.find((v) => v.labels.result === result)?.value ?? 0;
  }

  it("counts a not_found resolution as result=not_found", async () => {
    const before = await resolutionCount("not_found");
    const runtime = makeStubRuntime();
    stubArtifactResolver(() => {
      throw new ArtifactNotFoundError("abc123");
    });
    await handleReadResource(req({ uri: "artifact://abc123" }), runtime, { workspaceId: "w1" });
    expect(await resolutionCount("not_found")).toBe(before + 1);
  });

  it("counts a successful resolution as result=ok", async () => {
    const before = await resolutionCount("ok");
    const runtime = makeStubRuntime();
    stubArtifactResolver((uri) => ({
      contents: [{ uri, mimeType: "text/plain", text: "x" }],
    }));
    await handleReadResource(req({ uri: "artifact://abc123" }), runtime, { workspaceId: "w1" });
    expect(await resolutionCount("ok")).toBe(before + 1);
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
