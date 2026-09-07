import { describe, expect, it } from "bun:test";
import { validateConnectorUrl } from "../../src/connectors/runtime/url-validator.ts";

describe("validateConnectorUrl", () => {
	it("allows HTTPS URLs", () => {
		expect(() => validateConnectorUrl(new URL("https://example.com/mcp"))).not.toThrow();
	});

	it("rejects HTTP URLs without allowInsecure", () => {
		expect(() => validateConnectorUrl(new URL("http://example.com/mcp"))).toThrow();
	});

	it("allows http://localhost with allowInsecure", () => {
		expect(() =>
			validateConnectorUrl(new URL("http://localhost:3000/mcp"), { allowInsecure: true }),
		).not.toThrow();
	});

	it("rejects private IP 10.0.0.1", () => {
		expect(() => validateConnectorUrl(new URL("http://10.0.0.1/mcp"))).toThrow(
			/private\/reserved/,
		);
	});

	it("rejects private IP 192.168.1.1", () => {
		expect(() => validateConnectorUrl(new URL("http://192.168.1.1/mcp"))).toThrow(
			/private\/reserved/,
		);
	});

	it("rejects link-local / cloud metadata IP 169.254.169.254", () => {
		expect(() => validateConnectorUrl(new URL("http://169.254.169.254/metadata"))).toThrow(
			/private\/reserved/,
		);
	});

	it("rejects cloud metadata hostname", () => {
		expect(() =>
			validateConnectorUrl(new URL("https://metadata.google.internal/endpoint")),
		).toThrow(/private\/reserved/);
	});

	it("rejects embedded credentials", () => {
		expect(() =>
			validateConnectorUrl(new URL("https://user:pass@example.com/mcp")),
		).toThrow(/credentials/);
	});

	it("rejects private IP even with allowInsecure", () => {
		expect(() =>
			validateConnectorUrl(new URL("http://10.0.0.1/mcp"), { allowInsecure: true }),
		).toThrow(/private\/reserved/);
	});

	describe("IPv4-mapped IPv6 SSRF bypass", () => {
		it("rejects ::ffff:169.254.169.254 (cloud metadata)", () => {
			expect(() =>
				validateConnectorUrl(new URL("https://[::ffff:169.254.169.254]/")),
			).toThrow(/private\/reserved/);
		});

		it("rejects ::ffff:10.0.0.1 (RFC 1918)", () => {
			expect(() =>
				validateConnectorUrl(new URL("https://[::ffff:10.0.0.1]/")),
			).toThrow(/private\/reserved/);
		});

		it("rejects ::ffff:192.168.1.1 (RFC 1918)", () => {
			expect(() =>
				validateConnectorUrl(new URL("https://[::ffff:192.168.1.1]/")),
			).toThrow(/private\/reserved/);
		});

		it("rejects ::ffff:172.16.0.1 (RFC 1918)", () => {
			expect(() =>
				validateConnectorUrl(new URL("https://[::ffff:172.16.0.1]/")),
			).toThrow(/private\/reserved/);
		});

		it("rejects ::ffff:127.0.0.1 (loopback) without allowInsecure", () => {
			expect(() =>
				validateConnectorUrl(new URL("https://[::ffff:127.0.0.1]/")),
			).not.toThrow();
		});

		it("allows ::ffff:127.0.0.1 as localhost with allowInsecure", () => {
			expect(() =>
				validateConnectorUrl(new URL("http://[::ffff:127.0.0.1]:3000/mcp"), {
					allowInsecure: true,
				}),
			).not.toThrow();
		});

		it("allows ::ffff:8.8.8.8 (public IP)", () => {
			expect(() =>
				validateConnectorUrl(new URL("https://[::ffff:8.8.8.8]/")),
			).not.toThrow();
		});
	});

	describe("fleetInternal (in-cluster fleet sources over http)", () => {
		it("allows http to a .svc.cluster.local host when fleetInternal", () => {
			expect(() =>
				validateConnectorUrl(new URL("http://mcp-web.mcp-shared.svc.cluster.local/mcp"), {
					fleetInternal: true,
				}),
			).not.toThrow();
		});

		it("allows http to a bare .svc short-form host when fleetInternal", () => {
			expect(() =>
				validateConnectorUrl(new URL("http://mcp-web.mcp-shared.svc/mcp"), { fleetInternal: true }),
			).not.toThrow();
		});

		it("STILL rejects http to an external host even when fleetInternal", () => {
			expect(() =>
				validateConnectorUrl(new URL("http://evil.example.com/mcp"), { fleetInternal: true }),
			).toThrow(/HTTPS/);
		});

		it("does NOT allow http to .svc.cluster.local without fleetInternal", () => {
			expect(() =>
				validateConnectorUrl(new URL("http://mcp-web.mcp-shared.svc.cluster.local/mcp")),
			).toThrow(/HTTPS/);
			// the dev-only allowInsecure flag must not unlock in-cluster http either
			expect(() =>
				validateConnectorUrl(new URL("http://mcp-web.mcp-shared.svc.cluster.local/mcp"), {
					allowInsecure: true,
				}),
			).toThrow(/HTTPS/);
		});

		it("STILL rejects a raw private IP even when fleetInternal (private block stays above)", () => {
			expect(() =>
				validateConnectorUrl(new URL("http://10.0.0.1/mcp"), { fleetInternal: true }),
			).toThrow(/private\/reserved/);
		});
	});
});
