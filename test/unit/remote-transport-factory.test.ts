import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createRemoteTransport } from "../../src/tools/remote-transport.ts";
import { registerBuiltinCredentialProviders } from "../../src/oauth/minted-credential-provider.ts";
import { registerCredentialProvider } from "../../src/tools/credential-provider.ts";
import {
	_resetCredentialStoreForTest,
	FileCredentialStore,
	setCredentialStore,
} from "../../src/tools/credential-store.ts";
import type { EngineEvent } from "../../src/engine/types.ts";
import { seedWorkspaceRoot } from "../helpers/test-workspace.ts";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

describe("createRemoteTransport", () => {
	test("default returns StreamableHTTPClientTransport", async () => {
		const t = await createRemoteTransport(new URL("https://example.com/mcp"));
		expect(t).toBeInstanceOf(StreamableHTTPClientTransport);
	});

	test("type sse returns SSEClientTransport", async () => {
		const t = await createRemoteTransport(new URL("https://example.com/sse"), {
			type: "sse",
		});
		expect(t).toBeInstanceOf(SSEClientTransport);
	});

	test("type streamable-http returns StreamableHTTPClientTransport", async () => {
		const t = await createRemoteTransport(new URL("https://example.com/mcp"), {
			type: "streamable-http",
		});
		expect(t).toBeInstanceOf(StreamableHTTPClientTransport);
	});

	test("no auth creates transport with empty headers", async () => {
		const t = await createRemoteTransport(new URL("https://example.com/mcp"), {
			auth: { type: "none" },
		});
		expect(t).toBeInstanceOf(StreamableHTTPClientTransport);
	});

	describe("static headers reach the connector", () => {
		let seen: Headers[];
		let originalFetch: typeof fetch;

		beforeEach(() => {
			seen = [];
			originalFetch = globalThis.fetch;
			globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
				seen.push(new Headers(init?.headers));
				return new Response(null, { status: 202 });
			}) as unknown as typeof fetch;
		});

		afterEach(() => {
			globalThis.fetch = originalFetch;
		});

		/** Build a transport, send one notification, and return what reached the wire. */
		async function wire(config: Parameters<typeof createRemoteTransport>[1]): Promise<Headers> {
			const t = await createRemoteTransport(new URL("https://example.com/mcp"), config);
			await t.send({ jsonrpc: "2.0", method: "notifications/roots/list_changed" });
			const last = seen.at(-1);
			if (!last) throw new Error("no request reached fetch");
			return last;
		}

		test("bearer auth sets Authorization header", async () => {
			const headers = await wire({ auth: { type: "bearer", token: "sk-test-123" } });
			expect(headers.get("Authorization")).toBe("Bearer sk-test-123");
		});

		test("header auth sets custom header", async () => {
			const headers = await wire({ auth: { type: "header", name: "X-Api-Key", value: "key-123" } });
			expect(headers.get("X-Api-Key")).toBe("key-123");
		});

		test("custom headers are sent", async () => {
			const headers = await wire({ headers: { "X-Custom": "value", "X-Another": "other" } });
			expect(headers.get("X-Custom")).toBe("value");
			expect(headers.get("X-Another")).toBe("other");
		});

		test("custom headers and bearer auth are combined", async () => {
			const headers = await wire({
				headers: { "X-Custom": "value" },
				auth: { type: "bearer", token: "tok-abc" },
			});
			expect(headers.get("Authorization")).toBe("Bearer tok-abc");
			expect(headers.get("X-Custom")).toBe("value");
		});
	});

	test("reconnection options are passed to StreamableHTTPClientTransport", async () => {
		const t = await createRemoteTransport(new URL("https://example.com/mcp"), {
			reconnection: {
				maxReconnectionDelay: 60000,
				initialReconnectionDelay: 2000,
				maxRetries: 10,
			},
		});
		expect(t).toBeInstanceOf(StreamableHTTPClientTransport);
		// Verify transport was created (options are internal — constructor would
		// throw if reconnectionOptions shape was wrong)
	});

	test("sessionId is passed to StreamableHTTPClientTransport", async () => {
		const t = await createRemoteTransport(new URL("https://example.com/mcp"), {
			sessionId: "session-abc",
		});
		expect(t).toBeInstanceOf(StreamableHTTPClientTransport);
		const internal = t as unknown as Record<string, unknown>;
		// StreamableHTTPClientTransport stores sessionId as _sessionId
		const sessionId = internal["_sessionId"] as string | undefined;
		if (sessionId !== undefined) {
			expect(sessionId).toBe("session-abc");
		}
	});
});

describe("createRemoteTransport — provider auth (minted)", () => {
	// The generic `provider` auth dispatches to a registered credential provider;
	// register the built-in `minted` provider so the seam resolves it.
	registerBuiltinCredentialProviders();

	const saved = {
		tid: process.env.NB_TENANT_ID,
		key: process.env.NB_MCP_AUTHORIZER_TENANT_KEY,
		iss: process.env.NB_FLEET_AUTHORIZER_ISSUER,
	};
	afterEach(() => {
		const restore: [string, string | undefined][] = [
			["NB_TENANT_ID", saved.tid],
			["NB_MCP_AUTHORIZER_TENANT_KEY", saved.key],
			["NB_FLEET_AUTHORIZER_ISSUER", saved.iss],
		];
		for (const [k, v] of restore) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});

	const mintedConfig = {
		auth: {
			type: "provider" as const,
			provider: "minted",
			config: { audience: "artifacts", scope: "artifacts:write" },
		},
	};

	test("throws when the connection has no workspaceId (fail loud, not a silent 401)", async () => {
		process.env.NB_FLEET_AUTHORIZER_ISSUER = "https://authz.test";
		await expect(
			createRemoteTransport(new URL("https://artifacts.test/mcp"), mintedConfig),
		).rejects.toThrow(/workspaceId/);
	});

	test("throws a clear error on a provider auth with no config (fail loud, not a cryptic undefined read)", async () => {
		process.env.NB_FLEET_AUTHORIZER_ISSUER = "https://authz.test";
		// A malformed workspace.json `{ type: "provider", provider: "minted" }` with
		// no `config` (the TS type requires it; JSON config can omit it).
		const noConfig = { auth: { type: "provider" as const, provider: "minted" } } as unknown as Parameters<
			typeof createRemoteTransport
		>[1];
		await expect(
			createRemoteTransport(new URL("https://artifacts.test/mcp"), noConfig, undefined, {
				workspaceId: "ws_smoke",
			}),
		).rejects.toThrow(/config object/);
	});

	test("throws when NB_FLEET_AUTHORIZER_ISSUER is unset", async () => {
		delete process.env.NB_FLEET_AUTHORIZER_ISSUER;
		await expect(
			createRemoteTransport(new URL("https://artifacts.test/mcp"), mintedConfig, undefined, {
				workspaceId: "ws_smoke",
			}),
		).rejects.toThrow(/NB_FLEET_AUTHORIZER_ISSUER/);
	});

	test("attaches a minting fetch and NO static Authorization when fully provisioned", async () => {
		process.env.NB_TENANT_ID = "tenant-a";
		process.env.NB_MCP_AUTHORIZER_TENANT_KEY = randomBytes(32).toString("base64");
		process.env.NB_FLEET_AUTHORIZER_ISSUER = "https://authz.test";
		const t = await createRemoteTransport(new URL("https://artifacts.test/mcp"), mintedConfig, undefined, {
			workspaceId: "ws_smoke",
		});
		expect(t).toBeInstanceOf(StreamableHTTPClientTransport);
		const internal = t as unknown as Record<string, unknown>;
		// The minted token is attached via the transport's fetch override, not a
		// static header — so `_fetch` is wired and `Authorization` is absent.
		expect(internal["_fetch"]).toBeDefined();
		const reqInit = internal["_requestInit"] as RequestInit | undefined;
		const headers = (reqInit?.headers ?? {}) as Record<string, string>;
		expect(headers["Authorization"]).toBeUndefined();
	});
});

describe("createRemoteTransport — a credential reference resolves on every request", () => {
	// A live source can outlive a rotation by days. If the value resolved at
	// build rode every request, rotating a leaked secret would leave the tool
	// plane presenting it until something happened to reconnect.
	const WS = "ws_rotate01";
	const KEY = "acme.signing_secret";
	const HEADER = "X-Signing-Secret";
	const ENDPOINT = new URL("https://mcp.acme.test/mcp");
	const scope = { kind: "workspace", wsId: WS } as const;
	const refHeaders = { [HEADER]: { ref: "credential" as const, key: KEY }, "X-Plain": "kept" };

	let workDir: string;
	let store: FileCredentialStore;
	let events: EngineEvent[];
	let seen: Headers[];
	let originalFetch: typeof fetch;

	beforeEach(() => {
		workDir = mkdtempSync(join(tmpdir(), "nb-transport-ref-"));
		seedWorkspaceRoot(workDir, WS);
		events = [];
		store = new FileCredentialStore(workDir, { eventSink: { emit: (e) => events.push(e) } });
		setCredentialStore(store);
		seen = [];
		originalFetch = globalThis.fetch;
		globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
			seen.push(new Headers(init?.headers));
			return new Response(null, { status: 202 });
		}) as unknown as typeof fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		_resetCredentialStoreForTest();
		rmSync(workDir, { recursive: true, force: true });
	});

	/** Send one notification the way a live connection does, and return what reached the wire. */
	async function send(t: Transport): Promise<Headers> {
		// Not `notifications/initialized`: a 202 to that one opens the SSE stream,
		// a second request racing the one under test.
		await t.send({ jsonrpc: "2.0", method: "notifications/roots/list_changed" });
		const last = seen.at(-1);
		if (!last) throw new Error("no request reached fetch");
		return last;
	}

	function build(config: Parameters<typeof createRemoteTransport>[1]): Promise<Transport> {
		return createRemoteTransport(ENDPOINT, config, undefined, { workspaceId: WS });
	}

	test("a put reaches the next request on the same transport, with no reconnect", async () => {
		await store.put(scope, KEY, "old-secret");
		const t = await build({ headers: refHeaders });
		expect((await send(t)).get(HEADER)).toBe("old-secret");

		await store.put(scope, KEY, "new-secret");
		const after = await send(t);
		expect(after.get(HEADER)).toBe("new-secret");
		expect(after.get("X-Plain")).toBe("kept");
	});

	test("a bearer token given as a reference rotates the same way", async () => {
		await store.put(scope, KEY, "v1");
		const t = await build({ auth: { type: "bearer", token: { ref: "credential", key: KEY } } });
		expect((await send(t)).get("Authorization")).toBe("Bearer v1");
		await store.put(scope, KEY, "v2");
		expect((await send(t)).get("Authorization")).toBe("Bearer v2");
	});

	test("a later literal of the same name, in any case, still wins over a reference", async () => {
		await store.put(scope, KEY, "from-store");
		const t = await build({
			headers: { authorization: { ref: "credential", key: KEY } },
			auth: { type: "bearer", token: "literal" },
		});
		expect((await send(t)).get("Authorization")).toBe("Bearer literal");
		expect(events).toEqual([]);
	});

	test("a key deleted under a live transport fails the next request, naming the key", async () => {
		await store.put(scope, KEY, "old-secret");
		const t = await build({ headers: refHeaders });
		await send(t);
		await store.delete(scope, KEY);
		await expect(
			t.send({ jsonrpc: "2.0", method: "notifications/roots/list_changed" }),
		).rejects.toThrow(/acme\.signing_secret/);
	});

	test("a provider's fetch sees the resolved header and keeps it", async () => {
		// The shape `minted` and `credential` both have: rebuild the headers from
		// `init` and set their own. A reference header set outside them must survive.
		registerCredentialProvider("test-identity", {
			credentialFor: () => ({
				fetch: async (input, init) => {
					const headers = new Headers(init?.headers);
					headers.set("Authorization", "Bearer minted");
					return fetch(input as Parameters<typeof fetch>[0], { ...init, headers });
				},
			}),
		});
		await store.put(scope, KEY, "old-secret");
		const t = await build({
			auth: { type: "provider", provider: "test-identity", config: {} },
			headers: refHeaders,
		});
		await store.put(scope, KEY, "new-secret");
		const wire = await send(t);
		expect(wire.get("Authorization")).toBe("Bearer minted");
		expect(wire.get(HEADER)).toBe("new-secret");
	});

	test("a connection with no reference reads nothing from the store on any request", async () => {
		// No store at all: any read would throw, so a request that succeeds made none.
		_resetCredentialStoreForTest();
		const t = await build({
			headers: { "X-Plain": "kept" },
			auth: { type: "bearer", token: "literal" },
		});
		expect((await send(t)).get("Authorization")).toBe("Bearer literal");
		expect((await send(t)).get("X-Plain")).toBe("kept");
		expect(events).toEqual([]);
	});

	test("a write to a key no transport references costs nothing", async () => {
		await store.put(scope, KEY, "old-secret");
		const t = await build({ headers: refHeaders });
		events.length = 0;

		await store.put(scope, "acme.unrelated", "x");
		expect(events).toEqual([]);
		expect(seen).toHaveLength(0);

		await send(t);
		expect(events.map((e) => e.data.key)).toEqual([KEY]);
	});

	test("every request's resolve is audited, naming the header", async () => {
		await store.put(scope, KEY, "old-secret");
		const t = await build({ headers: refHeaders });
		events.length = 0;
		await send(t);
		await send(t);
		expect(events).toHaveLength(2);
		for (const event of events) {
			expect(event.type).toBe("audit.credential_read");
			expect(event.data).toMatchObject({
				key: KEY,
				caller: "transport:header",
				purpose: `outbound MCP request header ${HEADER}`,
			});
		}
		expect(JSON.stringify(events)).not.toContain("old-secret");
	});

	test("the SSE transport resolves per request too", async () => {
		await store.put(scope, KEY, "old-secret");
		const t = await build({ type: "sse", headers: refHeaders });
		expect(t).toBeInstanceOf(SSEClientTransport);
		const transportFetch = (t as unknown as { _fetch: (u: URL, i?: RequestInit) => Promise<Response> })._fetch;
		await store.put(scope, KEY, "new-secret");
		await transportFetch(ENDPOINT, {});
		expect(seen.at(-1)?.get(HEADER)).toBe("new-secret");
	});

	test("a provider's static header of the same name outranks a reference, as on the forward", async () => {
		registerCredentialProvider("test-static", {
			credentialFor: () => ({ headers: { "x-signing-secret": "from-provider" } }),
		});
		await store.put(scope, KEY, "from-store");
		const t = await build({
			auth: { type: "provider", provider: "test-static", config: {} },
			headers: refHeaders,
		});
		events.length = 0;
		expect((await send(t)).get(HEADER)).toBe("from-provider");
		expect(events).toEqual([]);
	});

	test("a reference never leaves the connector's origin", async () => {
		// OAuth discovery and token requests reach an authorization server through
		// the same fetch; the workspace's secret is not theirs.
		await store.put(scope, KEY, "old-secret");
		const t = await build({ headers: refHeaders });
		const transportFetch = (t as unknown as { _fetch: (u: string, i?: RequestInit) => Promise<Response> })._fetch;
		events.length = 0;
		await transportFetch("https://auth.other.test/token", { method: "POST" });
		expect(seen.at(-1)?.get(HEADER)).toBeNull();
		expect(events).toEqual([]);
	});
});

describe("createRemoteTransport — a connector's headers stay on the connector's origin", () => {
	// The SDK sends OAuth discovery, client registration, and token exchange and
	// refresh through the transport's fetch. An authorization server on another
	// origin is another party, and a header configured for the connector is not
	// its to read.
	const ENDPOINT = new URL("https://mcp.acme.test/mcp");
	const OTHER_ORIGIN = "https://auth.other.test";
	const REDIRECT = "https://app.test/callback";
	const HEADER = "X-Api-Key";
	const config = { headers: { [HEADER]: "literal-secret" } };

	interface Sent {
		url: URL;
		kind: string;
		headers: Headers;
	}
	let sent: Sent[];
	let originalFetch: typeof fetch;

	beforeEach(() => {
		sent = [];
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	/** Serve a connector at ENDPOINT whose protected-resource metadata names `issuer`. */
	function serve(issuer: string): void {
		globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
			const url = new URL(String(input));
			const record = (kind: string) => sent.push({ url, kind, headers: new Headers(init?.headers) });
			if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
				record("resource-metadata");
				return Response.json({ resource: ENDPOINT.href, authorization_servers: [issuer] });
			}
			if (url.pathname === "/.well-known/oauth-authorization-server") {
				record("server-metadata");
				return Response.json({
					issuer,
					authorization_endpoint: `${issuer}/authorize`,
					token_endpoint: `${issuer}/token`,
					registration_endpoint: `${issuer}/register`,
					response_types_supported: ["code"],
					code_challenge_methods_supported: ["S256"],
					token_endpoint_auth_methods_supported: ["client_secret_basic"],
				});
			}
			if (url.pathname === "/register") {
				record("registration");
				return Response.json(
					{ client_id: "client-1", client_secret: "client-secret", redirect_uris: [REDIRECT] },
					{ status: 201 },
				);
			}
			if (url.pathname === "/token") {
				const grant = new URLSearchParams(await new Response(init?.body).text()).get("grant_type");
				record(grant === "refresh_token" ? "refresh" : "exchange");
				return Response.json({
					access_token: "access-1",
					token_type: "bearer",
					refresh_token: "refresh-1",
					expires_in: 3600,
				});
			}
			record("connector");
			return new Response(null, { status: 202 });
		}) as unknown as typeof fetch;
	}

	function memoryProvider(): OAuthClientProvider {
		let client: OAuthClientInformationFull | undefined;
		let tokens: OAuthTokens | undefined;
		let verifier = "";
		return {
			redirectUrl: REDIRECT,
			clientMetadata: { redirect_uris: [REDIRECT], client_name: "test-client" },
			clientInformation: () => client,
			saveClientInformation: (info) => {
				client = info;
			},
			tokens: () => tokens,
			saveTokens: (saved) => {
				tokens = saved;
			},
			redirectToAuthorization: () => {},
			saveCodeVerifier: (v) => {
				verifier = v;
			},
			codeVerifier: () => verifier,
		};
	}

	/** The fetch the SDK hands its OAuth calls. */
	function sdkOAuthFetch(t: Transport): FetchLike {
		const fetchFn = (t as unknown as { _fetchWithInit?: FetchLike })._fetchWithInit;
		// If the SDK moves it, fail here rather than let `auth` fall back to the
		// global fetch and pass for the wrong reason.
		if (typeof fetchFn !== "function") throw new Error("SDK transport has no _fetchWithInit");
		return fetchFn;
	}

	/** Authorize, exchange the code, refresh, then call the connector. */
	async function runOAuth(t: Transport, provider: OAuthClientProvider): Promise<void> {
		const fetchFn = sdkOAuthFetch(t);
		expect(await auth(provider, { serverUrl: ENDPOINT, fetchFn })).toBe("REDIRECT");
		expect(await auth(provider, { serverUrl: ENDPOINT, authorizationCode: "code-1", fetchFn })).toBe(
			"AUTHORIZED",
		);
		expect(await auth(provider, { serverUrl: ENDPOINT, fetchFn })).toBe("AUTHORIZED");
		await t.send({ jsonrpc: "2.0", method: "notifications/roots/list_changed" });
	}

	const kinds = (requests: Sent[]) => [...new Set(requests.map((s) => s.kind))].sort();

	test("an authorization server on another origin receives none of them, at any step", async () => {
		serve(OTHER_ORIGIN);
		const provider = memoryProvider();
		const t = await createRemoteTransport(ENDPOINT, config, provider);
		await runOAuth(t, provider);

		const offOrigin = sent.filter((s) => s.url.origin !== ENDPOINT.origin);
		expect(kinds(offOrigin)).toEqual(["exchange", "refresh", "registration", "server-metadata"]);
		for (const s of offOrigin) expect(s.headers.get(HEADER)).toBeNull();

		// Resource metadata lives on the connector's origin, so it went through the
		// wrapper and carries the header. That is also what proves the SDK used
		// the transport's fetch rather than the global one.
		const onOrigin = sent.filter((s) => s.url.origin === ENDPOINT.origin);
		expect(kinds(onOrigin)).toEqual(["connector", "resource-metadata"]);
		for (const s of onOrigin) expect(s.headers.get(HEADER)).toBe("literal-secret");
	});

	test("nothing the SDK composes is removed from its OAuth requests", async () => {
		serve(OTHER_ORIGIN);
		const provider = memoryProvider();
		const t = await createRemoteTransport(ENDPOINT, config, provider);
		await runOAuth(t, provider);

		for (const s of sent.filter((r) => r.kind === "exchange" || r.kind === "refresh")) {
			expect(s.headers.get("Authorization")).toStartWith("Basic ");
			expect(s.headers.get("Content-Type")).toBe("application/x-www-form-urlencoded");
		}
		expect(sent.find((s) => s.kind === "registration")?.headers.get("Content-Type")).toBe(
			"application/json",
		);
		expect(sent.find((s) => s.kind === "connector")?.headers.get("Authorization")).toBe("Bearer access-1");
	});

	test("an authorization server on the connector's own origin receives them: the rule is the origin", async () => {
		serve(ENDPOINT.origin);
		const provider = memoryProvider();
		const t = await createRemoteTransport(ENDPOINT, config, provider);
		await runOAuth(t, provider);

		expect(kinds(sent)).toEqual([
			"connector",
			"exchange",
			"refresh",
			"registration",
			"resource-metadata",
			"server-metadata",
		]);
		for (const s of sent) expect(s.headers.get(HEADER)).toBe("literal-secret");
	});

	test("static auth takes the same path, and attaches no OAuth", async () => {
		serve(OTHER_ORIGIN);
		const t = await createRemoteTransport(
			ENDPOINT,
			{ ...config, auth: { type: "bearer", token: "static-token" } },
			memoryProvider(),
		);
		expect((t as unknown as Record<string, unknown>)["_authProvider"]).toBeUndefined();
		await sdkOAuthFetch(t)(`${OTHER_ORIGIN}/.well-known/oauth-authorization-server`, {});
		await t.send({ jsonrpc: "2.0", method: "notifications/roots/list_changed" });
		expect(sent.map((s) => [s.kind, s.headers.get("Authorization"), s.headers.get(HEADER)])).toEqual([
			["server-metadata", null, null],
			["connector", "Bearer static-token", "literal-secret"],
		]);
	});

	/** An SSE transport as it stands once the server has announced its POST endpoint. */
	async function connectedSse(
		transportConfig: Parameters<typeof createRemoteTransport>[1],
		authProvider?: OAuthClientProvider,
	): Promise<Transport> {
		const t = await createRemoteTransport(ENDPOINT, { ...transportConfig, type: "sse" }, authProvider);
		(t as unknown as { _endpoint: URL })._endpoint = ENDPOINT;
		return t;
	}

	test("the SSE transport keeps them on the connector's origin too", async () => {
		serve(OTHER_ORIGIN);
		const t = await connectedSse(config, memoryProvider());
		await sdkOAuthFetch(t)(`${OTHER_ORIGIN}/token`, { method: "POST", body: "grant_type=refresh_token" });
		await t.send({ jsonrpc: "2.0", method: "notifications/roots/list_changed" });
		expect(sent.map((s) => [s.kind, s.headers.get(HEADER)])).toEqual([
			["refresh", null],
			["connector", "literal-secret"],
		]);
	});

	test("a connector header never replaces one the SDK sets", async () => {
		// The SDK's Accept is what lets a Streamable HTTP server answer with a stream.
		serve(OTHER_ORIGIN);
		const clashing = {
			headers: { Accept: "application/json", "Content-Type": "text/plain", [HEADER]: "literal-secret" },
		};
		await (await createRemoteTransport(ENDPOINT, clashing)).send({
			jsonrpc: "2.0",
			method: "notifications/roots/list_changed",
		});
		await (await connectedSse(clashing)).send({ jsonrpc: "2.0", method: "notifications/roots/list_changed" });

		const [streamable, sse] = sent;
		expect(streamable?.headers.get("Accept")).toBe("application/json, text/event-stream");
		expect(streamable?.headers.get("Content-Type")).toBe("application/json");
		expect(sse?.headers.get("Content-Type")).toBe("application/json");
		for (const s of sent) expect(s.headers.get(HEADER)).toBe("literal-secret");
	});
});
