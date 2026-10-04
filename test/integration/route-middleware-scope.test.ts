import type { ApiErrorBody } from "../../src/api/schemas/responses.ts";
import { readJson } from "../helpers/http.ts";
/**
 * Each router's middleware runs for its own routes and no others.
 *
 * Every router is mounted at "/", so a router's middleware reaches only the
 * routes it is chained on (src/api/AGENTS.md, "Router middleware is chained
 * per route"). These tests walk the real app's route table: the routes that
 * authenticate answer 401 without credentials, the public ones do not, a path
 * no router registered answers 404, and an authenticated request is verified
 * once whichever router serves it and wherever that router is mounted.
 *
 * The provider counts `verifyRequest` calls. `authenticateRequest` calls it
 * exactly once, so the count is the number of times a request was
 * authenticated.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerHandle } from "../../src/api/server.ts";
import { startServer } from "../../src/api/server.ts";
import { _resetComposioConfigForTest } from "../../src/connectors/providers/composio/config.ts";
import type { VerifiedIdentity } from "../../src/identity/provider.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import type { IdentityStores } from "../../src/runtime/types.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { TEST_IDENTITY, TestAuthAdapter } from "../helpers/test-auth-adapter.ts";

const API_KEY = "route-middleware-scope-test-key";

let verifications = 0;

class CountingProvider extends TestAuthAdapter {
  override async verifyRequest(req: Request): Promise<VerifiedIdentity | null> {
    verifications++;
    return super.verifyRequest(req);
  }
}

/**
 * The routes that answer without credentials, as `METHOD path` from the route
 * table: discovery, health, metrics, the sign-in flow, the OAuth callbacks a
 * vendor's browser returns to, hook deliveries, and bare `/mcp` (refused with
 * 404 before auth). Every other route in the table authenticates.
 */
const PUBLIC = new Set([
  "GET /.well-known/oauth-protected-resource",
  "GET /.well-known/oauth-protected-resource/*",
  "GET /.well-known/oauth-protected-resource/mcp/:wsId",
  "GET /.well-known/oauth-authorization-server",
  "GET /v1/health",
  "GET /metrics",
  "GET /v1/auth/authorize",
  "GET /v1/auth/callback",
  "POST /v1/auth/refresh",
  "POST /v1/auth/logout",
  "GET /v1/mcp-auth/callback",
  "GET /v1/composio-auth/callback",
  "GET /v1/composio-auth/proxy",
  "ALL /v1/hooks/:deliveryId",
  "ALL /mcp",
  "ALL /mcp/",
]);

const ENV_KEYS = [
  "NB_PUBLIC_ORIGIN",
  "NB_TENANT_ID",
  "NB_HOOK_TOKEN_KEY",
  "COMPOSIO_API_KEY",
] as const;
const savedEnv = new Map<string, string | undefined>();

const testDir = join(tmpdir(), `nb-route-middleware-scope-${Date.now()}`);
let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;
let wsId: string;

beforeAll(async () => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  process.env.NB_PUBLIC_ORIGIN = "https://nb.example.com";
  // Hook deliveries and the Composio routes mount only when configured.
  process.env.NB_TENANT_ID = "tenant-a";
  process.env.NB_HOOK_TOKEN_KEY = randomBytes(32).toString("base64");
  process.env.COMPOSIO_API_KEY = "test-composio-key";
  _resetComposioConfigForTest();

  mkdirSync(testDir, { recursive: true });
  runtime = await Runtime.start({
    identityProvider: ({ workDir, userStore }: IdentityStores) =>
      new CountingProvider(API_KEY, userStore, workDir),
    languageModel: createEchoModel(),
    logging: { disabled: true },
    workDir: testDir,
  });
  const store = runtime.getWorkspaceStore();
  wsId = (await store.create("Acme Corp")).id;
  await store.addMember(wsId, TEST_IDENTITY.id, "admin");
  await runtime.ensureWorkspaceRegistry(wsId);

  handle = startServer({ runtime, port: 0 });
  baseUrl = `http://localhost:${handle.port}`;
});

afterAll(async () => {
  handle.stop(true);
  await runtime.shutdown();
  rmSync(testDir, { recursive: true, force: true });
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  _resetComposioConfigForTest();
});

interface Route {
  key: string;
  method: string;
  path: string;
}

/** Each distinct route in the table, without the app-wide `/*` middleware. */
function routeTable(): Route[] {
  const seen = new Map<string, Route>();
  for (const r of handle.app.routes) {
    if (r.path === "/*") continue;
    const key = `${r.method} ${r.path}`;
    if (!seen.has(key)) seen.set(key, { key, method: r.method, path: r.path });
  }
  return [...seen.values()];
}

/** A concrete path for a route pattern: real workspace, placeholder elsewhere. */
function concrete(path: string): string {
  return path
    .replace(":wsId", wsId)
    .replace(/:[A-Za-z]+/g, "x")
    .replace(/\*$/, "x");
}

/** Send a request to a route; returns the status and how many times it was authenticated. */
async function send(
  route: Route,
  credentials: boolean,
): Promise<{ status: number; verifications: number }> {
  const method = route.method === "ALL" ? "GET" : route.method;
  const hasBody = method !== "GET" && method !== "HEAD";
  const headers: Record<string, string> = { Accept: "application/json, text/event-stream" };
  if (credentials) headers.Authorization = `Bearer ${API_KEY}`;
  if (hasBody) headers["Content-Type"] = "application/json";
  verifications = 0;
  const res = await fetch(`${baseUrl}${concrete(route.path)}`, {
    method,
    headers,
    redirect: "manual",
    ...(hasBody ? { body: "{}" } : {}),
  });
  const counted = verifications;
  // SSE routes hold the stream open; release it.
  await res.body?.cancel().catch(() => {});
  return { status: res.status, verifications: counted };
}

function authenticatedRoutes(): Route[] {
  return routeTable().filter((r) => !PUBLIC.has(r.key));
}

describe("every route in the table", () => {
  it("lists every public route, so the public set is not stale", () => {
    const keys = routeTable().map((r) => r.key);
    for (const key of PUBLIC) expect(keys).toContain(key);
  });

  it("covers the authenticated routes of every router, including one mounted after the others", () => {
    const keys = authenticatedRoutes().map((r) => r.key);
    for (const key of [
      "GET /v1/bootstrap",
      "POST /v1/workspaces/:wsId/chat/start",
      "POST /v1/workspaces/:wsId/tools/call",
      "POST /v1/workspaces/:wsId/resources/read",
      "GET /v1/conversations/:id/events",
      "ALL /mcp/:wsId",
      // Mounted after bootstrap, chat, tools and resources.
      "GET /v1/events",
    ]) {
      expect(keys).toContain(key);
    }
  });

  it("answers 401 without credentials on each authenticated route", async () => {
    const admitted: string[] = [];
    for (const route of authenticatedRoutes()) {
      const { status } = await send(route, false);
      if (status !== 401) admitted.push(`${route.key} → ${status}`);
    }
    expect(admitted).toEqual([]);
  });

  it("answers without credentials, and without authenticating, on each public route", async () => {
    const refused: string[] = [];
    for (const route of routeTable().filter((r) => PUBLIC.has(r.key))) {
      const { status, verifications: count } = await send(route, false);
      if (status === 401 || count !== 0) {
        refused.push(`${route.key} → ${status}, ${count} verification(s)`);
      }
    }
    expect(refused).toEqual([]);
  });

  it("authenticates each authenticated request exactly once", async () => {
    const counts: string[] = [];
    for (const route of authenticatedRoutes()) {
      const { status, verifications: count } = await send(route, true);
      expect(status).not.toBe(401);
      if (count !== 1) counts.push(`${route.key} → ${count}`);
    }
    expect(counts).toEqual([]);
  });
});

describe("a path no router registered", () => {
  for (const path of ["/v1/does-not-exist", "/.well-known/nope"]) {
    it(`GET ${path} without credentials answers 404`, async () => {
      verifications = 0;
      const res = await fetch(`${baseUrl}${path}`);
      expect(res.status).toBe(404);
      expect((await readJson<ApiErrorBody>(res)).error).toBe("not_found");
      expect(verifications).toBe(0);
    });
  }
});
