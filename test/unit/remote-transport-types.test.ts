import { describe, expect, it } from "bun:test";
import { getValidator } from "../../src/config/index.ts";
import type { BundleRef, RemoteTransportConfig } from "../../src/bundles/types.ts";

describe("Remote transport — JSON Schema validation", () => {
	const validate = getValidator();

	function isValid(config: Record<string, unknown>): boolean {
		return validate(config) as boolean;
	}

	it("accepts bundles with url, name, and path variants", () => {
		// bundles is a valid top-level config field supporting all three BundleRef variants
		expect(isValid({ bundles: [{ url: "https://example.com/mcp" }] })).toBe(true);
		expect(isValid({ bundles: [{ name: "@nimblebraininc/echo" }] })).toBe(true);
		expect(isValid({ bundles: [{ path: "../mcp-servers/hello" }] })).toBe(true);
	});
});

describe("Remote transport — TypeScript types", () => {
	it("BundleRef url variant type-checks", () => {
		const ref: BundleRef = {
			url: "https://mcp.example.com/mcp",
			serverName: "example",
			transport: {
				type: "streamable-http",
				auth: { type: "bearer", token: "tok_123" },
			},
			protected: true,
			trustScore: 85,
			ui: null,
		};
		expect("url" in ref).toBe(true);
	});

	it("RemoteTransportConfig with bearer auth type-checks", () => {
		const config: RemoteTransportConfig = {
			type: "streamable-http",
			auth: { type: "bearer", token: "my-token" },
			headers: { "X-Trace-Id": "abc123" },
			reconnection: {
				maxReconnectionDelay: 30000,
				initialReconnectionDelay: 1000,
				maxRetries: 5,
			},
			sessionId: "sess_xyz",
		};
		expect(config.type).toBe("streamable-http");
		expect(config.auth?.type).toBe("bearer");
		expect(config.reconnection?.maxRetries).toBe(5);
	});

	it("RemoteTransportConfig with header auth type-checks", () => {
		const config: RemoteTransportConfig = {
			auth: { type: "header", name: "Authorization", value: "ApiKey secret" },
		};
		expect(config.auth?.type).toBe("header");
	});

	it("RemoteTransportConfig with no auth type-checks", () => {
		const config: RemoteTransportConfig = {
			auth: { type: "none" },
		};
		expect(config.auth?.type).toBe("none");
	});

	it("RemoteTransportConfig minimal (all optional)", () => {
		const config: RemoteTransportConfig = {};
		expect(config.type).toBeUndefined();
		expect(config.auth).toBeUndefined();
	});
});
