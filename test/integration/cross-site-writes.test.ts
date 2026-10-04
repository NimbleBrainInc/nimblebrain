import type {
  ApiErrorBody,
  ChatCancelResponse,
  ChatStartResponse,
} from "../../src/api/schemas/responses.ts";
import { readJson } from "../helpers/http.ts";
/**
 * A browser write from another origin is refused on every route unless CORS
 * allows that origin, and nothing else changes.
 *
 * The provider here authenticates the way the web app's login does: the
 * `nb_session` cookie, set by the auth-code callback and renewed by
 * `/v1/auth/refresh` from `nb_refresh`. A browser attaches that cookie to a
 * form or `text/plain` post from another origin on the same site with no
 * preflight, which is the request the guard exists to refuse. A bearer token
 * stands in for a server caller.
 *
 * The route-table test at the bottom is the one that keeps new routes covered:
 * it walks every non-safe route the real app serves.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerHandle } from "../../src/api/server.ts";
import { startServer } from "../../src/api/server.ts";
import { _resetComposioConfigForTest } from "../../src/connectors/providers/composio/config.ts";
import type {
  ProviderCapabilities,
  TokenResult,
  VerifiedIdentity,
} from "../../src/identity/provider.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import type { IdentityStores } from "../../src/runtime/types.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { TEST_IDENTITY, TestAuthAdapter } from "../helpers/test-auth-adapter.ts";

const API_KEY = "cross-site-writes-test-key";
const SESSION = "session-token";
const REFRESH = "refresh-token";

const PUBLIC_ORIGIN = "https://nb.example.com";
/** Named in ALLOWED_ORIGINS. */
const PARTNER = "https://partner.example.com";
/** Another origin on the same site, not allowlisted. */
const FOREIGN = "https://tenant-a.example.com";

/** The web app's login: `nb_session` authenticates, the auth-code flow and refresh set it. */
class CookieSessionProvider extends TestAuthAdapter {
  override readonly capabilities: ProviderCapabilities = {
    authCodeFlow: true,
    tokenRefresh: true,
    managedUsers: false,
    authorizationServer: false,
  };

  getAuthorizationUrl(): string {
    return "https://idp.example.com/authorize";
  }

  async exchangeCode(): Promise<TokenResult> {
    return { accessToken: SESSION, refreshToken: REFRESH };
  }

  async refreshToken(token: string): Promise<TokenResult> {
    if (token !== REFRESH) throw new Error("unknown refresh token");
    return { accessToken: SESSION, refreshToken: REFRESH };
  }

  override async verifyRequest(req: Request): Promise<VerifiedIdentity | null> {
    const cookies = req.headers.get("cookie") ?? "";
    const hasSession = cookies.split(";").some((p) => p.trim() === `nb_session=${SESSION}`);
    if (!hasSession) return super.verifyRequest(req);
    return super.verifyRequest(
      new Request(req.url, { headers: { authorization: `Bearer ${API_KEY}` } }),
    );
  }
}

const ENV_KEYS = [
  "ALLOWED_ORIGINS",
  "NB_PUBLIC_ORIGIN",
  "NB_TENANT_ID",
  "NB_HOOK_TOKEN_KEY",
  "COMPOSIO_API_KEY",
] as const;
const savedEnv = new Map<string, string | undefined>();

const testDir = join(tmpdir(), `nb-cross-site-writes-${Date.now()}`);
let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;
let wsId: string;

beforeAll(async () => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  process.env.ALLOWED_ORIGINS = PARTNER;
  process.env.NB_PUBLIC_ORIGIN = PUBLIC_ORIGIN;
  // Hook deliveries and the Composio routes mount only when configured.
  process.env.NB_TENANT_ID = "tenant-a";
  process.env.NB_HOOK_TOKEN_KEY = randomBytes(32).toString("base64");
  process.env.COMPOSIO_API_KEY = "test-composio-key";
  // The Composio config is resolved once per process; re-read it from this env.
  _resetComposioConfigForTest();

  mkdirSync(testDir, { recursive: true });
  runtime = await Runtime.start({
    identityProvider: ({ workDir, userStore }: IdentityStores) =>
      new CookieSessionProvider(API_KEY, userStore, workDir),
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

/** Where a browser request came from, as the browser labels it. */
type Source =
  | { site: "same-site" | "cross-site"; origin: string }
  | { site: "same-origin" }
  | { site: "none" };

const SAME_ORIGIN: Source = { site: "same-origin" };
const FOREIGN_SOURCES: Source[] = [
  { site: "same-site", origin: FOREIGN },
  { site: "cross-site", origin: FOREIGN },
];
const PARTNER_SOURCE: Source = { site: "cross-site", origin: PARTNER };

function browserHeaders(source: Source, cookie = `nb_session=${SESSION}`): Record<string, string> {
  const headers: Record<string, string> = { "Sec-Fetch-Site": source.site, Cookie: cookie };
  if (source.site === "same-origin") headers.Origin = PUBLIC_ORIGIN;
  if ("origin" in source) headers.Origin = source.origin;
  return headers;
}

function post(path: string, headers: Record<string, string>, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function expectRefused(res: Response): Promise<void> {
  expect(res.status).toBe(403);
  expect((await readJson<ApiErrorBody>(res)).error).toBe("cross_site_request");
}

async function startConversation(): Promise<string> {
  const res = await post(`/v1/workspaces/${wsId}/chat/start`, browserHeaders(SAME_ORIGIN), {
    message: "hello",
  });
  expect(res.status).toBe(200);
  return (await readJson<ChatStartResponse>(res)).conversationId;
}

const MCP_INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "cross-site-writes-test", version: "1.0.0" },
  },
};
const MCP_ACCEPT = { Accept: "application/json, text/event-stream" };

/**
 * The routes outside `/v1/workspaces/` a cookie authenticates or that set one,
 * each with the answer its own handler gives once the guard lets it through.
 */
const GUARDED: Array<{
  name: string;
  send: (headers: Record<string, string>) => Promise<Response>;
  admitted: (res: Response) => Promise<void>;
}> = [
  {
    name: "POST /v1/conversations/:id/cancel",
    send: async (headers) => post(`/v1/conversations/${await startConversation()}/cancel`, headers),
    admitted: async (res) => {
      expect(res.status).toBe(200);
      expect(typeof (await readJson<ChatCancelResponse>(res)).cancelled).toBe("boolean");
    },
  },
  {
    name: "POST /v1/mcp-auth/initiate-identity",
    send: (headers) => post("/v1/mcp-auth/initiate-identity", headers, { serverName: "absent" }),
    admitted: async (res) => {
      expect(res.status).toBe(404);
      expect((await readJson<ApiErrorBody>(res)).error).toBe("connector_not_found");
    },
  },
  {
    name: "POST /v1/composio-auth/initiate-identity",
    send: (headers) =>
      post("/v1/composio-auth/initiate-identity", headers, { connectorId: "com.example/absent" }),
    admitted: async (res) => {
      expect(res.status).toBe(404);
      expect((await readJson<ApiErrorBody>(res)).error).toBe("connector_not_found");
    },
  },
  {
    name: "POST /v1/auth/refresh",
    send: (headers) => post("/v1/auth/refresh", { ...headers, Cookie: `nb_refresh=${REFRESH}` }),
    admitted: async (res) => {
      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie")).toContain(`nb_session=${SESSION}`);
    },
  },
  {
    name: "POST /v1/auth/logout",
    send: (headers) => post("/v1/auth/logout", headers, {}),
    admitted: async (res) => {
      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie")).toContain("nb_session=;");
    },
  },
  {
    name: "POST /mcp/:wsId",
    send: (headers) => post(`/mcp/${wsId}`, { ...MCP_ACCEPT, ...headers }, MCP_INITIALIZE),
    admitted: async (res) => {
      expect(res.status).toBe(200);
    },
  },
];

describe("routes outside /v1/workspaces/ that a cookie authenticates", () => {
  for (const route of GUARDED) {
    describe(route.name, () => {
      it("refuses a same-site or cross-site write from an origin CORS does not allow", async () => {
        for (const source of FOREIGN_SOURCES) {
          const res = await route.send(browserHeaders(source));
          await expectRefused(res);
          expect(res.headers.get("set-cookie")).toBeNull();
        }
      });

      it("admits the same write from an allowlisted origin", async () => {
        await route.admitted(await route.send(browserHeaders(PARTNER_SOURCE)));
      });

      it("admits the same write from the same origin", async () => {
        await route.admitted(await route.send(browserHeaders(SAME_ORIGIN)));
      });
    });
  }
});

describe("server callers send no Sec-Fetch-Site and are unaffected", () => {
  const bearer = { Authorization: `Bearer ${API_KEY}` };

  it("a hook delivery reaches the hooks door", async () => {
    // An id no registration was minted for: the door's own answer is a bare
    // 404, which only the door gives. The guard's answer is a JSON 403.
    const path = "/v1/hooks/unregistered-delivery-id";
    const res = await post(path, { "Content-Type": "application/json" }, { event: "ping" });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
    await expectRefused(await post(path, browserHeaders({ site: "cross-site", origin: FOREIGN })));
  });

  it("an OAuth callback reaches its handler, from a server or a vendor's redirect", async () => {
    for (const headers of [{}, { "Sec-Fetch-Site": "cross-site" }]) {
      for (const path of ["/v1/mcp-auth/callback", "/v1/composio-auth/callback"]) {
        const res = await fetch(`${baseUrl}${path}`, { headers, redirect: "manual" });
        expect(res.status).not.toBe(403);
        expect(res.headers.get("content-type") ?? "").not.toContain("application/json");
      }
    }
  });

  it("a /v1/workspaces/* write with a bearer token", async () => {
    const res = await post(`/v1/workspaces/${wsId}/tools/call`, bearer, {
      server: "nb",
      tool: "manage_workspaces",
      arguments: { action: "list" },
    });
    expect(res.status).toBe(200);
  });

  it("an MCP client at /mcp/<wsId>", async () => {
    const res = await post(`/mcp/${wsId}`, { ...bearer, ...MCP_ACCEPT }, MCP_INITIALIZE);
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeTruthy();
  });
});

describe("the web app's own flows", () => {
  function setCookies(res: Response): string[] {
    return res.headers.getSetCookie();
  }

  it("signs in through the auth-code flow and refreshes the session", async () => {
    const authorize = await fetch(`${baseUrl}/v1/auth/authorize`, {
      headers: { "Sec-Fetch-Site": "same-origin" },
      redirect: "manual",
    });
    expect(authorize.status).toBe(302);
    const state = new URL(authorize.headers.get("location") ?? "").searchParams.get("state");
    expect(state).toBeTruthy();

    // The identity provider redirects the browser back: a cross-site navigation.
    const callback = await fetch(`${baseUrl}/v1/auth/callback?code=c&state=${state}`, {
      headers: { "Sec-Fetch-Site": "cross-site" },
      redirect: "manual",
    });
    expect(callback.status).toBe(302);
    const issued = setCookies(callback);
    expect(issued.some((c) => c.startsWith(`nb_session=${SESSION}`))).toBe(true);
    expect(issued.some((c) => c.startsWith(`nb_refresh=${REFRESH}`))).toBe(true);

    // The web app's silent refresh: a same-origin POST carrying nb_refresh.
    const refresh = await post("/v1/auth/refresh", {
      "Sec-Fetch-Site": "same-origin",
      Origin: PUBLIC_ORIGIN,
      Cookie: `nb_refresh=${REFRESH}`,
    });
    expect(refresh.status).toBe(200);
    expect(setCookies(refresh).some((c) => c.startsWith(`nb_session=${SESSION}`))).toBe(true);
  });

  it("cancels its own turn", async () => {
    const id = await startConversation();
    const res = await post(`/v1/conversations/${id}/cancel`, browserHeaders(SAME_ORIGIN));
    expect(res.status).toBe(200);
  });

  it("starts a personal connector sign-in", async () => {
    // Nothing is installed, so the handler answers 404: the request reached it
    // authenticated, which is all the guard decides.
    const res = await post("/v1/mcp-auth/initiate-identity", browserHeaders(SAME_ORIGIN), {
      serverName: "absent",
    });
    expect(res.status).toBe(404);
    expect((await readJson<ApiErrorBody>(res)).error).toBe("connector_not_found");
  });
});

describe("every non-safe route in the table", () => {
  const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

  /** A concrete path for a route pattern: real workspace, placeholder elsewhere. */
  function concrete(path: string): string {
    return path
      .replace(":wsId", wsId)
      .replace(/:[A-Za-z]+/g, "x")
      .replace(/\*$/, "x");
  }

  it("refuses a cookie-carrying write from another origin on the same site", async () => {
    const routes = [
      ...new Set(handle.app.routes.filter((r) => !SAFE.has(r.method)).map((r) => concrete(r.path))),
    ];
    // The walk covers the routes that motivated the guard; if the table stops
    // listing them, this is not testing the app it thinks it is.
    for (const known of [
      "/v1/conversations/x/cancel",
      "/v1/mcp-auth/initiate-identity",
      "/v1/composio-auth/initiate-identity",
      "/v1/auth/refresh",
      "/v1/auth/logout",
      `/mcp/${wsId}`,
      "/v1/hooks/x",
      `/v1/workspaces/${wsId}/tools/call`,
    ]) {
      expect(routes).toContain(known);
    }

    const admitted: string[] = [];
    for (const path of routes) {
      const res = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
          ...browserHeaders({ site: "same-site", origin: FOREIGN }),
          "Content-Type": "text/plain",
        },
        body: "{}",
      });
      const body: Partial<ApiErrorBody> =
        res.status === 403 ? await readJson<ApiErrorBody>(res) : {};
      if (body.error !== "cross_site_request") admitted.push(`${path} → ${res.status}`);
    }
    expect(admitted).toEqual([]);
  });
});
