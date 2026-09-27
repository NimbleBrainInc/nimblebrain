/**
 * An AuthKit token from one of the operator's own apps is first-party.
 *
 * The WorkOS provider classifies an AuthKit token by the client it was issued
 * to — its signed `client_id` claim — against `firstPartyClientIds`. A listed
 * client's token is admitted on every route, like the web login, and
 * membership gates it. Any other AuthKit token is a resource token, valid only
 * at the `/mcp/<wsId>` its `aud` names and on no `/v1/*` route.
 *
 * Mostly negative cases. The audience never confers first-party standing: an
 * MCP client that refreshes without a `resource` gets the same `aud` (the
 * environment's client ID) as a first-party app, so admitting that audience
 * would give every MCP client REST access.
 *
 * The real `WorkosIdentityProvider` verifies real RS256 signatures here; only
 * its JWKS fetch and the WorkOS user API are stubbed.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mcpResourceUrl } from "../../src/api/mcp-resource.ts";
import { type ServerHandle, startServer } from "../../src/api/server.ts";
import type { WorkosAuth } from "../../src/identity/instance.ts";
import { WorkosIdentityProvider } from "../../src/identity/providers/workos.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import type { WorkspaceStore } from "../../src/workspace/workspace-store.ts";
import { createEchoModel } from "../helpers/echo-model.ts";

const AUTHKIT_DOMAIN = "testapp";
const AUTHKIT_ISSUER = `https://${AUTHKIT_DOMAIN}.authkit.app`;
/** The environment's client ID: this instance's login client, and the `aud` of a token requested without a resource. */
const ENV_CLIENT_ID = "client_test_environment";
/** The operator's own app — a chat-channel bridge, say. */
const CHANNELS_CLIENT_ID = "client_test_channels";
/** An external MCP client's registration. */
const MCP_CLIENT_ID = "client_test_mcp_client";

const USER = "user_test_channels";
const KID = "authkit-key-1";

const testDir = join(tmpdir(), `nb-first-party-clients-${Date.now()}`);

let privateKey: CryptoKey;
let publicJwk: JsonWebKey;
let runtime: Runtime;
/** Wall-clock deadline for every token, so tests share one clock. */
let nowSec: number;
/** A workspace USER belongs to. */
let wsMember: string;
/** A workspace USER does not belong to. */
let wsForeign: string;

const servers: ServerHandle[] = [];

// ── JWT helpers ───────────────────────────────────────────────────

function base64UrlEncode(data: Uint8Array): string {
  const binary = String.fromCharCode(...data);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function authkitToken(claims: Record<string, unknown>): Promise<string> {
  const header = { alg: "RS256", typ: "JWT", kid: KID };
  const payload = { sub: USER, iss: AUTHKIT_ISSUER, iat: nowSec, exp: nowSec + 300, ...claims };
  const enc = (o: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(o)));
  const signingInput = `${enc(header)}.${enc(payload)}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/** A token shaped like the one the channels bridge presents: aud is the environment's client ID. */
function channelsLike(clientId: string): Promise<string> {
  return authkitToken({ client_id: clientId, aud: ENV_CLIENT_ID, org_id: "org_test" });
}

// ── A server per configuration ────────────────────────────────────

function workosProvider(config: Partial<WorkosAuth>, store: WorkspaceStore): WorkosIdentityProvider {
  const provider = new WorkosIdentityProvider(
    {
      adapter: "workos",
      clientId: ENV_CLIENT_ID,
      redirectUri: "http://localhost/callback",
      organizationId: "org_test",
      apiKey: "sk_test_fake",
      authkitDomain: AUTHKIT_DOMAIN,
      ...config,
    },
    undefined,
    store,
  );
  const workos = (provider as unknown as { workos: Record<string, unknown> }).workos;
  workos.userManagement = {
    getUser: async (id: string) => ({
      id,
      email: `${id}@example.com`,
      firstName: "Test",
      lastName: "User",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    listOrganizationMemberships: async (opts: { userId: string; organizationId: string }) => ({
      data: [
        {
          id: "om_test",
          userId: opts.userId,
          organizationId: opts.organizationId,
          role: { slug: "member" },
          status: "active",
        },
      ],
    }),
  };
  provider.fetcher = async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== `${AUTHKIT_ISSUER}/oauth2/jwks`) return new Response("Not Found", { status: 404 });
    const { kty, n, e } = publicJwk;
    return Response.json({ keys: [{ kty, kid: KID, n, e, alg: "RS256", use: "sig" }] });
  };
  return provider;
}

function serve(config: Partial<WorkosAuth>): string {
  const handle = startServer({
    runtime,
    port: 0,
    provider: workosProvider(config, runtime.getWorkspaceStore()),
  });
  servers.push(handle);
  return `http://localhost:${handle.port}`;
}

/** With the channels bridge configured as first-party. */
let configured: string;
/** With no first-party list at all. */
let unconfigured: string;

beforeAll(async () => {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  privateKey = keyPair.privateKey;
  publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  nowSec = Math.floor(Date.now() / 1000);

  mkdirSync(testDir, { recursive: true });
  runtime = await Runtime.start({
    model: { provider: "custom", adapter: createEchoModel() },
    logging: { disabled: true },
    workDir: testDir,
  });
  const store = runtime.getWorkspaceStore();
  wsMember = (await store.create("Acme Corp")).id;
  wsForeign = (await store.create("Elsewhere")).id;
  await store.addMember(wsMember, USER, "member");
  await store.addMember(wsForeign, "user_test_someone_else", "admin");
  await runtime.ensureWorkspaceRegistry(wsMember);

  configured = serve({ firstPartyClientIds: [CHANNELS_CLIENT_ID] });
  unconfigured = serve({});
});

afterAll(async () => {
  for (const handle of servers) handle.stop(true);
  await runtime.shutdown();
  rmSync(testDir, { recursive: true, force: true });
});

// ── Requests ──────────────────────────────────────────────────────

function chatStart(base: string, wsId: string, token: string): Promise<Response> {
  return fetch(`${base}/v1/workspaces/${wsId}/chat/start`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message: "hello from a channel" }),
  });
}

function bootstrap(base: string, token: string): Promise<Response> {
  return fetch(`${base}/v1/bootstrap`, { headers: { Authorization: `Bearer ${token}` } });
}

function mcpInitialize(base: string, wsId: string, token: string): Promise<Response> {
  return fetch(`${base}/mcp/${wsId}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "first-party-client-test", version: "1.0.0" },
      },
    }),
  });
}

// ── A listed client is first-party ────────────────────────────────

describe("a channels-like token whose client_id is listed", () => {
  it("is admitted on POST /v1/workspaces/<member ws>/chat/start", async () => {
    const res = await chatStart(configured, wsMember, await channelsLike(CHANNELS_CLIENT_ID));
    expect(res.status).toBe(200);
    expect((await res.json()).conversationId).toMatch(/^conv_/);
  });

  it("is admitted on GET /v1/bootstrap", async () => {
    const res = await bootstrap(configured, await channelsLike(CHANNELS_CLIENT_ID));
    expect(res.status).toBe(200);
  });

  it("is admitted at /mcp/<member ws>, though its aud names no resource", async () => {
    const res = await mcpInitialize(configured, wsMember, await channelsLike(CHANNELS_CLIENT_ID));
    expect(res.status).toBe(200);
  });

  it("gets the unknown-workspace 404 for a workspace its user does not belong to", async () => {
    const token = await channelsLike(CHANNELS_CLIENT_ID);
    for (const [label, send] of [
      ["chat/start", (ws: string) => chatStart(configured, ws, token)],
      ["/mcp", (ws: string) => mcpInitialize(configured, ws, token)],
    ] as const) {
      const foreign = await send(wsForeign);
      const unknown = await send("ws_0000000000000000");
      expect(foreign.status, label).toBe(404);
      expect(unknown.status, label).toBe(404);
      expect(await foreign.text(), label).toBe(await unknown.text());
    }
  });
});

// ── Anything else stays a resource token ──────────────────────────

describe("an AuthKit token whose client_id is not listed", () => {
  // The case the audience alone cannot tell apart: an MCP client that
  // refreshes without `resource` holds a token whose aud is the environment's
  // client ID, exactly like the channels bridge.
  it("is refused on /v1/* and at /mcp/<ws> with the same aud as a first-party app", async () => {
    const token = await channelsLike(MCP_CLIENT_ID);
    expect((await chatStart(configured, wsMember, token)).status).toBe(401);
    expect((await bootstrap(configured, token)).status).toBe(401);
    expect((await mcpInitialize(configured, wsMember, token)).status).toBe(401);
  });

  it("is refused when its aud is a first-party client ID", async () => {
    const token = await authkitToken({ client_id: MCP_CLIENT_ID, aud: CHANNELS_CLIENT_ID });
    expect((await chatStart(configured, wsMember, token)).status).toBe(401);
    expect((await bootstrap(configured, token)).status).toBe(401);
    expect((await mcpInitialize(configured, wsMember, token)).status).toBe(401);
  });

  it("is refused when it carries no client_id", async () => {
    const token = await authkitToken({ aud: ENV_CLIENT_ID });
    expect((await bootstrap(configured, token)).status).toBe(401);
  });

  it("is still admitted at the /mcp/<ws> its aud names, and nowhere on /v1/*", async () => {
    const token = await authkitToken({ client_id: MCP_CLIENT_ID, aud: mcpResourceUrl(wsMember) });
    expect((await mcpInitialize(configured, wsMember, token)).status).toBe(200);
    expect((await chatStart(configured, wsMember, token)).status).toBe(401);
    expect((await bootstrap(configured, token)).status).toBe(401);
  });
});

// ── No list, no first-party AuthKit token ─────────────────────────

describe("with no first-party client IDs configured", () => {
  it("refuses a token whose client_id looks first-party", async () => {
    const token = await channelsLike(CHANNELS_CLIENT_ID);
    expect((await chatStart(unconfigured, wsMember, token)).status).toBe(401);
    expect((await bootstrap(unconfigured, token)).status).toBe(401);
    expect((await mcpInitialize(unconfigured, wsMember, token)).status).toBe(401);
  });

  it("refuses it with an empty list too", async () => {
    const empty = serve({ firstPartyClientIds: [] });
    const token = await channelsLike(CHANNELS_CLIENT_ID);
    expect((await chatStart(empty, wsMember, token)).status).toBe(401);
    expect((await bootstrap(empty, token)).status).toBe(401);
  });
});
