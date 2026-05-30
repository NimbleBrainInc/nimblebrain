/**
 * Integration tests for the http-proxy route.
 *
 * Covers:
 *   - Workspace ID validation (path-traversal guard)
 *   - Membership enforcement (DevIdentityProvider sets identity = usr_default);
 *     non-existent and non-member workspaces return the same generic 403 with
 *     no ID echo, so a caller can't probe for workspace existence (issue #17)
 *   - Per-workspace kill switch (allowHttpProxy = false)
 *   - Bundle / mount existence checks
 *   - Upstream unreachable → 502
 *   - Request header stripping (Authorization, Cookie, X-Workspace-Id,
 *     X-Forwarded-For, Accept-Encoding)
 *   - Response header behavior (Set-Cookie / X-Frame-Options / CSP stripped;
 *     X-Frame-Options: SAMEORIGIN set on success)
 *
 * The lifecycle's `instances` map is private; tests reach in via `as any` to
 * register fake bundle instances. This is the lightest path that lets us
 * exercise the proxy route without spinning up a real bundle subprocess.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../../../src/runtime/runtime.ts";
import { startServer, type ServerHandle } from "../../../src/api/server.ts";
import { createEchoModel } from "../../helpers/echo-model.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../../helpers/test-workspace.ts";
import type { BundleInstance, HttpProxyConfig } from "../../../src/bundles/types.ts";

// ── Upstream test server ──────────────────────────────────────────────

interface CapturedRequest {
  method: string;
  pathname: string;
  search: string;
  headers: Record<string, string>;
  body: string;
}

let lastUpstreamRequest: CapturedRequest | null = null;
let upstreamResponseFactory: () => Response = () =>
  new Response("upstream-default", { status: 200, headers: { "Content-Type": "text/plain" } });

let upstreamServer: ReturnType<typeof Bun.serve> | null = null;

function startUpstream(): { port: number; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const headers: Record<string, string> = {};
      for (const [k, v] of req.headers) headers[k.toLowerCase()] = v;
      const body = req.body ? await req.text() : "";
      lastUpstreamRequest = {
        method: req.method,
        pathname: url.pathname,
        search: url.search,
        headers,
        body,
      };
      return upstreamResponseFactory();
    },
  });
  upstreamServer = server;
  return { port: server.port, stop: () => server.stop(true) };
}

// ── Setup ─────────────────────────────────────────────────────────────

let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;
let workDir: string;
let upstream: { port: number; stop: () => void };

const BUNDLE_NAME = "test-proxy-bundle";
const MOUNT = "preview";
const NON_MEMBER_WS = "ws_no_access";
const KILLED_WS = "ws_killed";
const NO_INSTANCE_WS = "ws_no_instance";

function fakeInstance(httpProxy: HttpProxyConfig | null, wsId: string): BundleInstance {
  return {
    serverName: BUNDLE_NAME,
    bundleName: `@org/${BUNDLE_NAME}`,
    version: "0.0.0-test",
    state: "running",
    trustScore: null,
    ui: null,
    briefing: null,
    httpProxy,
    protected: false,
    type: "plain",
    wsId,
  };
}

function registerInstance(wsId: string, httpProxy: HttpProxyConfig | null) {
  const lifecycle = runtime.getLifecycle() as unknown as {
    instances: Map<string, BundleInstance>;
  };
  lifecycle.instances.set(`${BUNDLE_NAME}|${wsId}`, fakeInstance(httpProxy, wsId));
}

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "nb-proxy-route-"));
  upstream = startUpstream();

  runtime = await Runtime.start({
    model: { provider: "custom", adapter: createEchoModel() },
    noDefaultBundles: true,
    logging: { disabled: true },
    workDir,
  });

  // ws_test — usr_default is a member.
  await provisionTestWorkspace(runtime);

  // ws_no_access — exists, but usr_default is NOT a member.
  const wsStore = runtime.getWorkspaceStore();
  await wsStore.create("No Access", "no_access");

  // ws_killed — usr_default IS a member, but allowHttpProxy = false.
  const killed = await wsStore.create("Killed", "killed");
  await wsStore.addMember(killed.id, "usr_default", "admin");
  await wsStore.update(killed.id, { allowHttpProxy: false });

  // ws_no_instance — usr_default is a member, no bundle registered.
  const noInst = await wsStore.create("No Instance", "no_instance");
  await wsStore.addMember(noInst.id, "usr_default", "admin");

  // Register a bundle instance pointing at the upstream test server.
  const proxy: HttpProxyConfig = {
    target: `http://127.0.0.1:${upstream.port}`,
    mount: MOUNT,
    websocket: false,
  };
  registerInstance(TEST_WORKSPACE_ID, proxy);
  registerInstance(KILLED_WS, proxy); // for the kill-switch test
  registerInstance(NON_MEMBER_WS, proxy); // for the membership test

  // For the "unknown mount" test we register an instance with a different mount.
  registerInstance("ws_test", proxy); // already done above; here for clarity

  handle = startServer({ runtime, port: 0 });
  baseUrl = `http://localhost:${handle.port}`;
});

afterAll(async () => {
  handle.stop(true);
  await runtime.shutdown();
  upstream.stop();
  upstreamServer?.stop(true);
  rmSync(workDir, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────

function proxyUrl(wsId: string, mount: string = MOUNT, rest: string = "") {
  return `${baseUrl}/v1/ws/${wsId}/apps/${BUNDLE_NAME}/${mount}/${rest}`;
}

function resetUpstream() {
  lastUpstreamRequest = null;
  upstreamResponseFactory = () =>
    new Response("ok", { status: 200, headers: { "Content-Type": "text/plain" } });
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("proxy route — workspace ID validation", () => {
  it("400 when wsId is malformed (path-traversal guard)", async () => {
    const res = await fetch(`${baseUrl}/v1/ws/..%2Fsecret/apps/${BUNDLE_NAME}/${MOUNT}/`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("workspace_error");
  });

  it("403 (not 400) when wsId references a non-existent workspace — no existence oracle (#17)", async () => {
    const ghostId = "ws_does_not_exist";
    const res = await fetch(`${baseUrl}/v1/ws/${ghostId}/apps/${BUNDLE_NAME}/${MOUNT}/`);
    // Same response as the not-a-member case below: an authenticated caller
    // can't distinguish "doesn't exist" from "exists but forbidden".
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("workspace_error");
    expect(body.message).toBe("Access denied to workspace.");
    expect(JSON.stringify(body)).not.toContain(ghostId);
  });
});

describe("proxy route — auth / membership", () => {
  it("403 with a generic, ID-free message when identity is not a member (#17)", async () => {
    const res = await fetch(proxyUrl(NON_MEMBER_WS));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("workspace_error");
    expect(body.message).toBe("Access denied to workspace.");
    // Must not echo the workspace id back to a non-member.
    expect(JSON.stringify(body)).not.toContain(NON_MEMBER_WS);
  });
});

describe("proxy route — kill switch", () => {
  it("403 when workspace.allowHttpProxy is false", async () => {
    const res = await fetch(proxyUrl(KILLED_WS));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("proxy_disabled");
  });
});

describe("proxy route — bundle / mount lookup", () => {
  it("404 when no bundle instance exists for the workspace", async () => {
    const res = await fetch(proxyUrl(NO_INSTANCE_WS));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });

  it("404 when the requested mount is not the one declared by the bundle", async () => {
    const res = await fetch(proxyUrl(TEST_WORKSPACE_ID, "wrong-mount"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });
});

describe("proxy route — upstream behavior", () => {
  it("502 when upstream is unreachable", async () => {
    // Register a bundle instance pointing at an unused port.
    const wsStore = runtime.getWorkspaceStore();
    const ws = await wsStore.create("Dead Upstream", "dead_upstream");
    await wsStore.addMember(ws.id, "usr_default", "admin");
    registerInstance(ws.id, {
      target: "http://127.0.0.1:1", // port 1 — refused by every host's TCP stack
      mount: MOUNT,
      websocket: false,
    });

    const res = await fetch(proxyUrl(ws.id));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_gateway");
  });

  it("forwards full path + query string to upstream verbatim", async () => {
    resetUpstream();
    const res = await fetch(proxyUrl(TEST_WORKSPACE_ID, MOUNT, "deep/path?q=1&x=y"));
    expect(res.status).toBe(200);
    expect(lastUpstreamRequest).not.toBeNull();
    expect(lastUpstreamRequest?.pathname).toBe(
      `/v1/ws/${TEST_WORKSPACE_ID}/apps/${BUNDLE_NAME}/${MOUNT}/deep/path`,
    );
    expect(lastUpstreamRequest?.search).toBe("?q=1&x=y");
  });

  it("forwards the request method", async () => {
    resetUpstream();
    const res = await fetch(proxyUrl(TEST_WORKSPACE_ID), { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(lastUpstreamRequest?.method).toBe("DELETE");
  });

  it("forwards request body for POST", async () => {
    resetUpstream();
    const res = await fetch(proxyUrl(TEST_WORKSPACE_ID), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    expect(res.status).toBe(200);
    expect(lastUpstreamRequest?.body).toBe('{"hello":"world"}');
  });
});

describe("proxy route — request header stripping", () => {
  it("strips Authorization, Cookie, X-Workspace-Id, X-Forwarded-For, Accept-Encoding", async () => {
    resetUpstream();
    const res = await fetch(proxyUrl(TEST_WORKSPACE_ID), {
      headers: {
        Authorization: "Bearer secret-token-do-not-leak",
        Cookie: "session=secret",
        "X-Workspace-Id": "should-not-leak",
        "X-Forwarded-For": "1.2.3.4",
        "Accept-Encoding": "gzip, br",
        "X-Custom-Header": "should-pass-through",
      },
    });
    expect(res.status).toBe(200);
    const fwd = lastUpstreamRequest?.headers ?? {};
    expect(fwd.authorization).toBeUndefined();
    expect(fwd.cookie).toBeUndefined();
    expect(fwd["x-workspace-id"]).toBeUndefined();
    expect(fwd["x-forwarded-for"]).toBeUndefined();
    // Accept-Encoding from the browser is replaced with `identity`, forcing
    // upstream to return an unencoded body so we don't inherit Bun's
    // per-encoding decompression behavior.
    expect(fwd["accept-encoding"]).toBe("identity");
    // Sanity: non-stripped headers do pass through.
    expect(fwd["x-custom-header"]).toBe("should-pass-through");
  });

  it("sets X-Forwarded-Host and X-Forwarded-Proto on the forwarded request", async () => {
    resetUpstream();
    const res = await fetch(proxyUrl(TEST_WORKSPACE_ID));
    expect(res.status).toBe(200);
    const fwd = lastUpstreamRequest?.headers ?? {};
    expect(fwd["x-forwarded-host"]).toBeDefined();
    expect(fwd["x-forwarded-proto"]).toBe("http");
  });
});

describe("proxy route — response header behavior", () => {
  it("strips Set-Cookie, X-Frame-Options, CSP from upstream response", async () => {
    upstreamResponseFactory = () =>
      new Response("hi", {
        status: 200,
        headers: {
          "Set-Cookie": "evil=yes; HttpOnly",
          "X-Frame-Options": "DENY", // upstream tries to deny framing
          "Content-Security-Policy": "default-src 'none'",
          "Content-Security-Policy-Report-Only": "default-src 'none'",
          "X-Custom-Upstream": "passthrough-ok",
        },
      });
    const res = await fetch(proxyUrl(TEST_WORKSPACE_ID));
    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    // The platform overrides X-Frame-Options to SAMEORIGIN — see next test.
    expect(res.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
    expect(res.headers.get("Content-Security-Policy-Report-Only")).toBeNull();
    // Sanity: non-stripped headers pass through.
    expect(res.headers.get("X-Custom-Upstream")).toBe("passthrough-ok");
  });

  it("sets X-Frame-Options: SAMEORIGIN on successful proxy responses", async () => {
    resetUpstream();
    const res = await fetch(proxyUrl(TEST_WORKSPACE_ID));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
  });

  it("preserves upstream response status code (e.g., 404)", async () => {
    upstreamResponseFactory = () => new Response("not here", { status: 404 });
    const res = await fetch(proxyUrl(TEST_WORKSPACE_ID));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("not here");
  });

  it("preserves upstream response body bytes", async () => {
    const payload = "the bodyÿwithbinary";
    upstreamResponseFactory = () =>
      new Response(payload, { status: 200, headers: { "Content-Type": "text/plain" } });
    const res = await fetch(proxyUrl(TEST_WORKSPACE_ID));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(payload);
  });
});
