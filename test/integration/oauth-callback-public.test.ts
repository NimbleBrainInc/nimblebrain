/**
 * The outbound-OAuth callbacks are PUBLIC under adapter auth.
 *
 * `GET /v1/mcp-auth/callback` and `GET /v1/composio-auth/callback` are
 * unauthenticated by design: the vendor's browser returns here with no
 * platform session, and the flow is guarded by the state cookie + flow
 * registry, not by `requireAuth`. This suite checks that:
 *
 * - the callbacks answer without credentials (400 for missing params, never 401);
 * - an authenticated route (bootstrap) still refuses unauthenticated callers;
 * - a protected-resource metadata path that names no resource answers 404,
 *   not 401.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerHandle } from "../../src/api/server.ts";
import { startServer } from "../../src/api/server.ts";
import { _resetComposioConfigForTest } from "../../src/connectors/providers/composio/config.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { testAuthAdapter } from "../helpers/test-auth-adapter.ts";
import { provisionTestWorkspace } from "../helpers/test-workspace.ts";

let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;
const API_KEY = "test-api-key-oauth-callback-public";
const testDir = join(tmpdir(), `nimblebrain-oauth-callback-${Date.now()}`);
const savedComposioApiKey = process.env.COMPOSIO_API_KEY;

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  // The Composio callback route is owned by the Composio managed-connector
  // provider and mounted only when the provider is registered — i.e. only when
  // Composio is configured. Configure it so the public-callback contract below
  // (reachable without auth) actually has a route to exercise.
  process.env.COMPOSIO_API_KEY = "test-composio-key-oauth-callback-public";
  _resetComposioConfigForTest();
  runtime = await Runtime.start({
    identityProvider: testAuthAdapter(API_KEY),
    languageModel: createEchoModel(),
    logging: { disabled: true },
    http: { port: 0, host: "127.0.0.1" },
    workDir: testDir,
  });
  await provisionTestWorkspace(runtime);

  // Adapter (auth-enabled) mode — this is the only mode where a misplaced
  // `requireAuth` would 401 a public route; dev mode passes every request through.
  handle = startServer({ runtime, port: 0 });
  baseUrl = `http://localhost:${handle.port}`;
});

afterAll(async () => {
  handle.stop(true);
  await runtime.shutdown();
  rmSync(testDir, { recursive: true, force: true });
  if (savedComposioApiKey === undefined) delete process.env.COMPOSIO_API_KEY;
  else process.env.COMPOSIO_API_KEY = savedComposioApiKey;
  _resetComposioConfigForTest();
});

describe("outbound-OAuth callbacks are public under adapter auth", () => {
  it("GET /v1/mcp-auth/callback is reachable without auth (400 missing params, not 401)", async () => {
    const res = await fetch(`${baseUrl}/v1/mcp-auth/callback`);
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("missing code or state");
  });

  it("GET /v1/composio-auth/callback is reachable without auth (400 missing params, not 401)", async () => {
    const res = await fetch(`${baseUrl}/v1/composio-auth/callback`);
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(400);
  });

  it("GET /v1/auth/callback (WorkOS) stays public — control", async () => {
    const res = await fetch(`${baseUrl}/v1/auth/callback`);
    expect(res.status).not.toBe(401);
  });

  it("/.well-known/oauth-protected-resource stays public — control", async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
    expect(res.status).not.toBe(401);
  });
});

// Each router chains requireAuth on its own routes, so a public route answers
// without auth wherever it is mounted. A router that gave itself a
// `.use("*", requireAuth)` would 401 these; this pins them under CI.
// Registered routes only: the runtime answers a path no router registered
// with 404. `route-middleware-scope.test.ts` walks the whole route table and
// pins that 404.
const PUBLIC_GET_ROUTES = [
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-authorization-server",
  "/v1/auth/callback",
  "/v1/mcp-auth/callback",
  "/v1/composio-auth/callback",
];

describe("public/special routes stay reachable without auth", () => {
  for (const path of PUBLIC_GET_ROUTES) {
    it(`GET ${path} is not 401`, async () => {
      const res = await fetch(`${baseUrl}${path}`);
      expect(res.status).not.toBe(401);
    });
  }
});

describe("protected resource metadata for a path that is no resource", () => {
  // Bare /mcp names no workspace, so it has no metadata document. It must
  // answer 404 like the root document, not fall through to an authenticated
  // route's middleware and answer 401.
  it("GET /.well-known/oauth-protected-resource/mcp without auth returns 404", async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`);
    expect(res.status).toBe(404);
  });
});

describe("POST /v1/auth/logout is public", () => {
  it("clears the session without auth", async () => {
    const res = await fetch(`${baseUrl}/v1/auth/logout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
  });
});

describe("genuinely-authenticated routes still reject unauthenticated callers", () => {
  it("GET /v1/bootstrap without auth returns 401", async () => {
    const res = await fetch(`${baseUrl}/v1/bootstrap`);
    expect(res.status).toBe(401);
  });

  it("GET /v1/bootstrap with a valid bearer is not 401", async () => {
    const res = await fetch(`${baseUrl}/v1/bootstrap`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(res.status).not.toBe(401);
  });
});
