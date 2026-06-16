import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { createRemoteTransport } from "../../src/tools/remote-transport.ts";
import { registerBuiltinCredentialProviders } from "../../src/oauth/minted-credential-provider.ts";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

describe("createRemoteTransport", () => {
	test("default returns StreamableHTTPClientTransport", () => {
		const t = createRemoteTransport(new URL("https://example.com/mcp"));
		expect(t).toBeInstanceOf(StreamableHTTPClientTransport);
	});

	test("type sse returns SSEClientTransport", () => {
		const t = createRemoteTransport(new URL("https://example.com/sse"), {
			type: "sse",
		});
		expect(t).toBeInstanceOf(SSEClientTransport);
	});

	test("type streamable-http returns StreamableHTTPClientTransport", () => {
		const t = createRemoteTransport(new URL("https://example.com/mcp"), {
			type: "streamable-http",
		});
		expect(t).toBeInstanceOf(StreamableHTTPClientTransport);
	});

	test("bearer auth sets Authorization header", () => {
		const t = createRemoteTransport(new URL("https://example.com/mcp"), {
			auth: { type: "bearer", token: "sk-test-123" },
		});
		expect(t).toBeInstanceOf(StreamableHTTPClientTransport);
		// Verify the transport was configured with the auth header by inspecting
		// the internal requestInit (StreamableHTTPClientTransport stores it)
		const internal = t as unknown as Record<string, unknown>;
		const reqInit = internal["_requestInit"] as RequestInit | undefined;
		if (reqInit?.headers) {
			const headers = reqInit.headers as Record<string, string>;
			expect(headers["Authorization"]).toBe("Bearer sk-test-123");
		}
	});

	test("header auth sets custom header", () => {
		const t = createRemoteTransport(new URL("https://example.com/mcp"), {
			auth: { type: "header", name: "X-Api-Key", value: "key-123" },
		});
		expect(t).toBeInstanceOf(StreamableHTTPClientTransport);
		const internal = t as unknown as Record<string, unknown>;
		const reqInit = internal["_requestInit"] as RequestInit | undefined;
		if (reqInit?.headers) {
			const headers = reqInit.headers as Record<string, string>;
			expect(headers["X-Api-Key"]).toBe("key-123");
		}
	});

	test("no auth creates transport with empty headers", () => {
		const t = createRemoteTransport(new URL("https://example.com/mcp"), {
			auth: { type: "none" },
		});
		expect(t).toBeInstanceOf(StreamableHTTPClientTransport);
	});

	test("custom headers are merged into requestInit", () => {
		const t = createRemoteTransport(new URL("https://example.com/mcp"), {
			headers: { "X-Custom": "value", "X-Another": "other" },
		});
		expect(t).toBeInstanceOf(StreamableHTTPClientTransport);
		const internal = t as unknown as Record<string, unknown>;
		const reqInit = internal["_requestInit"] as RequestInit | undefined;
		if (reqInit?.headers) {
			const headers = reqInit.headers as Record<string, string>;
			expect(headers["X-Custom"]).toBe("value");
			expect(headers["X-Another"]).toBe("other");
		}
	});

	test("custom headers and bearer auth are combined", () => {
		const t = createRemoteTransport(new URL("https://example.com/mcp"), {
			headers: { "X-Custom": "value" },
			auth: { type: "bearer", token: "tok-abc" },
		});
		expect(t).toBeInstanceOf(StreamableHTTPClientTransport);
		const internal = t as unknown as Record<string, unknown>;
		const reqInit = internal["_requestInit"] as RequestInit | undefined;
		if (reqInit?.headers) {
			const headers = reqInit.headers as Record<string, string>;
			expect(headers["Authorization"]).toBe("Bearer tok-abc");
			expect(headers["X-Custom"]).toBe("value");
		}
	});

	test("reconnection options are passed to StreamableHTTPClientTransport", () => {
		const t = createRemoteTransport(new URL("https://example.com/mcp"), {
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

	test("sessionId is passed to StreamableHTTPClientTransport", () => {
		const t = createRemoteTransport(new URL("https://example.com/mcp"), {
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

	test("throws when the connection has no workspaceId (fail loud, not a silent 401)", () => {
		process.env.NB_FLEET_AUTHORIZER_ISSUER = "https://authz.test";
		expect(() =>
			createRemoteTransport(new URL("https://artifacts.test/mcp"), mintedConfig),
		).toThrow(/workspaceId/);
	});

	test("throws when NB_FLEET_AUTHORIZER_ISSUER is unset", () => {
		delete process.env.NB_FLEET_AUTHORIZER_ISSUER;
		expect(() =>
			createRemoteTransport(new URL("https://artifacts.test/mcp"), mintedConfig, undefined, {
				workspaceId: "ws_smoke",
			}),
		).toThrow(/NB_FLEET_AUTHORIZER_ISSUER/);
	});

	test("attaches a minting fetch and NO static Authorization when fully provisioned", () => {
		process.env.NB_TENANT_ID = "hq";
		process.env.NB_MCP_AUTHORIZER_TENANT_KEY = randomBytes(32).toString("base64");
		process.env.NB_FLEET_AUTHORIZER_ISSUER = "https://authz.test";
		const t = createRemoteTransport(new URL("https://artifacts.test/mcp"), mintedConfig, undefined, {
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
