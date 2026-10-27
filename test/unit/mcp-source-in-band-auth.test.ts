import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import {
  serverDetailToCatalogEntry,
  validateServerDetailSafety,
} from "../../src/connectors/catalog/projection.ts";
import type { ServerDetail } from "../../src/connectors/catalog/server-detail.ts";
import type { ConnectorCatalogEntry } from "../../src/connectors/catalog/types.ts";
import {
  inBandAuthErrorsFor,
  setInBandAuthErrorsCatalog,
} from "../../src/connectors/runtime/in-band-auth-errors.ts";
import type { ConnectorRef } from "../../src/connectors/runtime/types.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";
import { TASKS_EXTENSION_ID, type TaskClient } from "../../src/tools/mcp-task-client.ts";
import { resetRefreshExchanges } from "../../src/tools/oauth-refresh-fetch.ts";
import { WorkspaceOAuthProvider } from "../../src/tools/workspace-oauth-provider.ts";
import {
  installTestCredentialStore,
  resetTestCredentialStore,
} from "../helpers/credential-store.ts";
import { mcpSourceInternals } from "../helpers/mcp-source-internals.ts";
import { stub } from "../helpers/stub.ts";
import { seedWorkspaceRoot } from "../helpers/test-workspace.ts";

/**
 * Some servers reject an access token in-band: HTTP 200, an `isError` result
 * whose text says the token expired, instead of the 401 the SDK refreshes on.
 * A connection whose catalog entry declares that text must answer it the way
 * the transport answers a 401: refresh once with the stored refresh token and
 * retry, and flip to `reauth_required` only when that cannot help.
 *
 * These drive a real `WorkspaceOAuthProvider` and the SDK's own `auth()` against
 * a fake rotating vendor (reached through the global `fetch`, which the source's
 * authorization fetch chain calls), with a stubbed MCP client standing in for the
 * server's `tools/call`: it accepts only the access tokens the test marks valid.
 */

const WS = "ws_0076759dbbe19fcc";
const SERVER = "inband-srv";
const MCP_URL = "https://mcp.inband.example/mcp";
const ISSUER = "https://auth.inband.example";
const TOKEN_URL = `${ISSUER}/oauth/token`;
const CALLBACK = "http://localhost:27247/v1/mcp-auth/callback";
const REJECTION =
  "Query failed: Your authentication token has expired or is invalid. Please refresh your token and retry.";
const PHRASE = "authentication token has expired or is invalid";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The vendor's authorization server: discovery, and a token endpoint that rotates. */
function vendor(opts: { refuse?: boolean } = {}) {
  let current = "rt_1";
  let issued = 1;
  let refreshPosts = 0;
  let gate: Promise<void> | null = null;
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return json({ resource: MCP_URL, authorization_servers: [ISSUER] });
    }
    if (
      url.pathname.startsWith("/.well-known/oauth-authorization-server") ||
      url.pathname.startsWith("/.well-known/openid-configuration")
    ) {
      return json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/oauth/authorize`,
        token_endpoint: TOKEN_URL,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (url.href === TOKEN_URL) {
      refreshPosts++;
      if (gate) await gate;
      const raw = init?.body;
      const body = new URLSearchParams(
        ArrayBuffer.isView(raw) ? new TextDecoder().decode(raw) : String(raw ?? ""),
      );
      if (opts.refuse || body.get("refresh_token") !== current) {
        return json({ error: "invalid_grant" }, 400);
      }
      current = `rt_${++issued}`;
      return json({
        access_token: `at_${issued}`,
        token_type: "Bearer",
        expires_in: 28800,
        refresh_token: current,
      });
    }
    return new Response("not found", { status: 404 });
  };
  return {
    fetchImpl,
    refreshPosts: () => refreshPosts,
    /** Hold token responses until the returned release runs, so refreshes overlap. */
    hold(): () => void {
      let release!: () => void;
      gate = new Promise<void>((r) => {
        release = r;
      });
      return () => {
        gate = null;
        release();
      };
    },
  };
}

function makeProvider(onAuthLost?: () => void): WorkspaceOAuthProvider {
  return new WorkspaceOAuthProvider({
    owner: { type: "workspace", wsId: WS },
    serverName: SERVER,
    callbackUrl: CALLBACK,
    ...(onAuthLost ? { onAuthLost } : {}),
  });
}

async function seedConnection(): Promise<void> {
  const p = makeProvider();
  await p.saveClientInformation({ client_id: "client-1", redirect_uris: [CALLBACK] });
  await p.saveTokens({
    access_token: "at_1",
    token_type: "Bearer",
    refresh_token: "rt_1",
    issuer: ISSUER,
  } as Parameters<WorkspaceOAuthProvider["saveTokens"]>[0]);
}

const textOf = (r: { content: { type: string; text?: string }[] }) =>
  r.content.map((c) => c.text ?? "").join("\n");

/**
 * A started remote source whose `tools/call` answers by the bearer the provider
 * serves: an accepted token gets `ok`, any other the in-band rejection.
 */
function startedSource(opts: {
  provider?: WorkspaceOAuthProvider;
  accepted: Set<string>;
  inBandAuthErrors?: string[];
}) {
  const calls: string[] = [];
  const source = new McpSource(
    SERVER,
    {
      type: "remote",
      url: new URL(MCP_URL),
      ...(opts.provider ? { authProvider: opts.provider } : {}),
      ...(opts.inBandAuthErrors ? { inBandAuthErrors: opts.inBandAuthErrors } : {}),
    },
    new NoopEventSink(),
  );
  const internal = mcpSourceInternals(source);
  internal.client = stub<Client>({
    callTool: async () => {
      const bearer = (await opts.provider?.tokens())?.access_token ?? "none";
      calls.push(bearer);
      return opts.accepted.has(bearer)
        ? { content: [{ type: "text", text: "ok" }] }
        : { content: [{ type: "text", text: REJECTION }], isError: true };
    },
    close: () => Promise.resolve(),
  });
  internal.dead = false;
  source.start = () => Promise.resolve();
  return { source, calls };
}

/**
 * The same source on a 2026-07-28 connection whose server advertises the tasks
 * extension, so every call takes the task path: each `tools/call` opens a task
 * that answers by the bearer the provider serves.
 */
function startedTaskSource(opts: { provider: WorkspaceOAuthProvider; accepted: Set<string> }) {
  const { source, calls } = startedSource({ ...opts, inBandAuthErrors: [PHRASE] });
  const internal = mcpSourceInternals(source);
  internal.client = stub<Client>({
    close: () => Promise.resolve(),
    getServerCapabilities: () => ({ extensions: { [TASKS_EXTENSION_ID]: {} } }),
  });
  internal.protocolEra = "modern";
  internal.taskClient = stub<TaskClient>({
    callToolStream: async function* () {
      const bearer = (await opts.provider.tokens())?.access_token ?? "none";
      calls.push(bearer);
      const now = new Date().toISOString();
      yield {
        type: "taskCreated",
        task: {
          taskId: `t${calls.length}`,
          status: "working",
          ttl: 60_000,
          createdAt: now,
          lastUpdatedAt: now,
        },
      };
      yield {
        type: "result",
        result: opts.accepted.has(bearer)
          ? { content: [{ type: "text", text: "ok" }] }
          : { content: [{ type: "text", text: REJECTION }], isError: true },
      };
    },
    getTask: () => Promise.reject(new Error("getTask not expected")),
  });
  return { source, calls };
}

describe("McpSource — in-band access-token rejection", () => {
  let server: ReturnType<typeof vendor>;
  let fetchSpy: ReturnType<typeof spyOn>;

  function useVendor(v: ReturnType<typeof vendor>): void {
    server = v;
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(((
      input: string | URL | Request,
      init?: RequestInit,
    ) => server.fetchImpl(input, init)) as typeof fetch);
  }

  beforeEach(async () => {
    const workDir = mkdtempSync(join(tmpdir(), "nb-inband-auth-"));
    seedWorkspaceRoot(workDir, WS);
    installTestCredentialStore(workDir);
    resetRefreshExchanges();
    await seedConnection();
  });
  afterEach(() => {
    fetchSpy?.mockRestore();
    resetTestCredentialStore();
  });

  it("test_in_band_rejection_refreshes_once_and_retries_on_new_token", async () => {
    useVendor(vendor());
    const onAuthLost = mock(() => {});
    const { source, calls } = startedSource({
      provider: makeProvider(onAuthLost),
      accepted: new Set(["at_2"]),
      inBandAuthErrors: [PHRASE],
    });

    const result = await source.execute("executeQuery", {});

    expect(result.isError).toBe(false);
    expect(textOf(result)).toBe("ok");
    expect(server.refreshPosts()).toBe(1);
    expect(calls).toEqual(["at_1", "at_2"]);
    expect(onAuthLost).not.toHaveBeenCalled();
  });

  it("test_in_band_rejection_refresh_refused_flips_reauth_once", async () => {
    useVendor(vendor({ refuse: true }));
    const onAuthLost = mock(() => {});
    const { source, calls } = startedSource({
      provider: makeProvider(onAuthLost),
      accepted: new Set(),
      inBandAuthErrors: [PHRASE],
    });

    const result = await source.execute("executeQuery", {});

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.reason).toBe("reauth_required");
    expect(onAuthLost).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["at_1"]);
  });

  it("test_in_band_rejection_of_refreshed_token_flips_reauth_without_more_refreshes", async () => {
    useVendor(vendor());
    const onAuthLost = mock(() => {});
    const { source } = startedSource({
      provider: makeProvider(onAuthLost),
      accepted: new Set(),
      inBandAuthErrors: [PHRASE],
    });

    const first = await source.execute("executeQuery", {});
    expect(first.structuredContent?.reason).toBe("reauth_required");
    expect(server.refreshPosts()).toBe(1);

    const second = await source.execute("executeQuery", {});
    expect(second.structuredContent?.reason).toBe("reauth_required");
    expect(server.refreshPosts()).toBe(1);
    expect(onAuthLost).toHaveBeenCalledTimes(1);
  });

  it("test_in_band_rejection_after_refreshed_token_worked_refreshes_again", async () => {
    useVendor(vendor());
    const onAuthLost = mock(() => {});
    const accepted = new Set(["at_2"]);
    const { source, calls } = startedSource({
      provider: makeProvider(onAuthLost),
      accepted,
      inBandAuthErrors: [PHRASE],
    });

    expect((await source.execute("executeQuery", {})).isError).toBe(false);
    expect((await source.execute("executeQuery", {})).isError).toBe(false);
    // The refreshed token expires later; the next refresh is still owed.
    accepted.clear();
    accepted.add("at_3");
    const result = await source.execute("executeQuery", {});

    expect(result.isError).toBe(false);
    expect(server.refreshPosts()).toBe(2);
    expect(calls).toEqual(["at_1", "at_2", "at_2", "at_2", "at_3"]);
    expect(onAuthLost).not.toHaveBeenCalled();
  });

  it("test_in_band_rejection_on_task_path_refreshes_without_replaying_the_task", async () => {
    useVendor(vendor());
    const onAuthLost = mock(() => {});
    const { source, calls } = startedTaskSource({
      provider: makeProvider(onAuthLost),
      accepted: new Set(["at_2"]),
    });

    const rejected = await source.execute("executeQuery", {});
    expect(rejected.isError).toBe(true);
    expect(rejected.structuredContent?.reason).not.toBe("reauth_required");
    expect(textOf(rejected)).toContain(REJECTION);
    expect(calls).toEqual(["at_1"]);
    expect(server.refreshPosts()).toBe(1);

    const next = await source.execute("executeQuery", {});
    expect(next.isError).toBe(false);
    expect(calls).toEqual(["at_1", "at_2"]);
    expect(onAuthLost).not.toHaveBeenCalled();
  });

  it("test_in_band_rejection_on_task_path_refresh_refused_flips_reauth", async () => {
    useVendor(vendor({ refuse: true }));
    const onAuthLost = mock(() => {});
    const { source, calls } = startedTaskSource({
      provider: makeProvider(onAuthLost),
      accepted: new Set(),
    });

    const result = await source.execute("executeQuery", {});

    expect(result.structuredContent?.reason).toBe("reauth_required");
    expect(calls).toEqual(["at_1"]);
    expect(onAuthLost).toHaveBeenCalledTimes(1);
  });

  it("test_in_band_rejection_parallel_calls_spend_one_refresh", async () => {
    useVendor(vendor());
    const { source } = startedSource({
      provider: makeProvider(),
      accepted: new Set(["at_2"]),
      inBandAuthErrors: [PHRASE],
    });

    const release = server.hold();
    const pending = Promise.all(
      Array.from({ length: 5 }, () => source.execute("executeQuery", {})),
    );
    // Let every call reach its rejection before the token endpoint answers.
    await new Promise((r) => setTimeout(r, 20));
    release();
    const results = await pending;

    expect(results.every((r) => r.isError === false)).toBe(true);
    expect(server.refreshPosts()).toBe(1);
  });

  it("test_in_band_rejection_after_token_renewed_retries_without_refresh", async () => {
    useVendor(vendor());
    const provider = makeProvider();
    const { source, calls } = startedSource({
      provider,
      accepted: new Set(["at_fresh"]),
      inBandAuthErrors: [PHRASE],
    });
    // Another call renews the token while this one is in flight.
    const internal = mcpSourceInternals(source);
    const client = internal.client;
    internal.client = stub<Client>({
      callTool: async (...args: Parameters<Client["callTool"]>) => {
        const answer = await client?.callTool(...args);
        if (calls.length === 1) {
          await provider.saveTokens({
            access_token: "at_fresh",
            token_type: "Bearer",
            refresh_token: "rt_1",
            issuer: ISSUER,
          } as Parameters<WorkspaceOAuthProvider["saveTokens"]>[0]);
        }
        return answer as Awaited<ReturnType<Client["callTool"]>>;
      },
      close: () => Promise.resolve(),
    });

    const result = await source.execute("executeQuery", {});

    expect(result.isError).toBe(false);
    expect(calls).toEqual(["at_1", "at_fresh"]);
    expect(server.refreshPosts()).toBe(0);
  });

  it("test_rejection_text_without_declaration_is_surfaced_unchanged", async () => {
    useVendor(vendor());
    const onAuthLost = mock(() => {});
    const { source, calls } = startedSource({
      provider: makeProvider(onAuthLost),
      accepted: new Set(),
    });

    const result = await source.execute("executeQuery", {});

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(REJECTION);
    expect(calls).toEqual(["at_1"]);
    expect(server.refreshPosts()).toBe(0);
    expect(onAuthLost).not.toHaveBeenCalled();
  });

  it("test_in_band_rejection_on_static_auth_remote_is_surfaced_unchanged", async () => {
    useVendor(vendor());
    const { source, calls } = startedSource({
      accepted: new Set(),
      inBandAuthErrors: [PHRASE],
    });

    const result = await source.execute("executeQuery", {});

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.reason).not.toBe("reauth_required");
    expect(textOf(result)).toContain(REJECTION);
    expect(calls).toEqual(["none"]);
    expect(server.refreshPosts()).toBe(0);
  });
});

describe("in-band auth errors bind from the catalog entry the ref is", () => {
  const entry: ConnectorCatalogEntry = {
    id: "com.example/mcp",
    name: "Example",
    description: "",
    url: "https://mcp.example.com/mcp",
    auth: "static",
    inBandAuthErrors: [PHRASE],
  };
  const ref = (url: string): ConnectorRef => ({ url, serverName: "com-example-mcp" });

  afterEach(() => setInBandAuthErrorsCatalog(null));

  it("test_in_band_auth_errors_reach_a_ref_bound_to_the_entry", async () => {
    setInBandAuthErrorsCatalog(async () => [entry]);
    expect(await inBandAuthErrorsFor(ref("https://mcp.example.com/mcp"))).toEqual([PHRASE]);
  });

  it("test_in_band_auth_errors_never_reach_another_server_under_the_name", async () => {
    setInBandAuthErrorsCatalog(async () => [entry]);
    expect(await inBandAuthErrorsFor(ref("https://evil.example.net/mcp"))).toBeUndefined();
  });

  it("test_in_band_auth_errors_unset_catalog_reaches_nothing", async () => {
    expect(await inBandAuthErrorsFor(ref("https://mcp.example.com/mcp"))).toBeUndefined();
  });
});

describe("catalog entries declare in-band auth errors", () => {
  const detail = (inBandAuthErrors: unknown): ServerDetail =>
    ({
      name: "com.example/mcp",
      description: "",
      version: "1.0.0",
      remotes: [{ type: "streamable-http", url: "https://mcp.example.com/mcp" }],
      _meta: { "ai.nimblebrain/connector": { inBandAuthErrors } },
    }) as ServerDetail;

  it("test_in_band_auth_errors_project_onto_the_catalog_entry", () => {
    expect(validateServerDetailSafety(detail([PHRASE]))).toBeNull();
    expect(serverDetailToCatalogEntry(detail([PHRASE]))?.inBandAuthErrors).toEqual([PHRASE]);
  });

  it("test_in_band_auth_errors_short_fragment_drops_the_entry", () => {
    expect(validateServerDetailSafety(detail(["token"]))).toMatch(/inBandAuthErrors/);
  });

  it("test_in_band_auth_errors_not_a_list_drops_the_entry", () => {
    expect(validateServerDetailSafety(detail(PHRASE))).toMatch(/inBandAuthErrors/);
  });
});
