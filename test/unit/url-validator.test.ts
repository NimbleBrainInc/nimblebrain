import { describe, expect, it } from "bun:test";
import { validateBundleUrl } from "../../src/bundles/url-validator.ts";

describe("validateBundleUrl", () => {
	it("allows HTTPS URLs", () => {
		expect(() => validateBundleUrl(new URL("https://example.com/mcp"))).not.toThrow();
	});

	it("rejects HTTP URLs without allowInsecure", () => {
		expect(() => validateBundleUrl(new URL("http://example.com/mcp"))).toThrow();
	});

	it("allows http://localhost with allowInsecure", () => {
		expect(() =>
			validateBundleUrl(new URL("http://localhost:3000/mcp"), { allowInsecure: true }),
		).not.toThrow();
	});

	it("rejects private IP 10.0.0.1", () => {
		expect(() => validateBundleUrl(new URL("http://10.0.0.1/mcp"))).toThrow(
			/private\/reserved/,
		);
	});

	it("rejects private IP 192.168.1.1", () => {
		expect(() => validateBundleUrl(new URL("http://192.168.1.1/mcp"))).toThrow(
			/private\/reserved/,
		);
	});

	it("rejects link-local / cloud metadata IP 169.254.169.254", () => {
		expect(() => validateBundleUrl(new URL("http://169.254.169.254/metadata"))).toThrow(
			/private\/reserved/,
		);
	});

	it("rejects cloud metadata hostname", () => {
		expect(() =>
			validateBundleUrl(new URL("https://metadata.google.internal/endpoint")),
		).toThrow(/private\/reserved/);
	});

	it("rejects embedded credentials", () => {
		expect(() =>
			validateBundleUrl(new URL("https://user:pass@example.com/mcp")),
		).toThrow(/credentials/);
	});

	it("rejects private IP even with allowInsecure", () => {
		expect(() =>
			validateBundleUrl(new URL("http://10.0.0.1/mcp"), { allowInsecure: true }),
		).toThrow(/private\/reserved/);
	});

	describe("IPv4-mapped IPv6 SSRF bypass", () => {
		it("rejects ::ffff:169.254.169.254 (cloud metadata)", () => {
			expect(() =>
				validateBundleUrl(new URL("https://[::ffff:169.254.169.254]/")),
			).toThrow(/private\/reserved/);
		});

		it("rejects ::ffff:10.0.0.1 (RFC 1918)", () => {
			expect(() =>
				validateBundleUrl(new URL("https://[::ffff:10.0.0.1]/")),
			).toThrow(/private\/reserved/);
		});

		it("rejects ::ffff:192.168.1.1 (RFC 1918)", () => {
			expect(() =>
				validateBundleUrl(new URL("https://[::ffff:192.168.1.1]/")),
			).toThrow(/private\/reserved/);
		});

		it("rejects ::ffff:172.16.0.1 (RFC 1918)", () => {
			expect(() =>
				validateBundleUrl(new URL("https://[::ffff:172.16.0.1]/")),
			).toThrow(/private\/reserved/);
		});

		it("rejects ::ffff:127.0.0.1 (loopback) without allowInsecure", () => {
			expect(() =>
				validateBundleUrl(new URL("https://[::ffff:127.0.0.1]/")),
			).not.toThrow();
		});

		it("allows ::ffff:127.0.0.1 as localhost with allowInsecure", () => {
			expect(() =>
				validateBundleUrl(new URL("http://[::ffff:127.0.0.1]:3000/mcp"), {
					allowInsecure: true,
				}),
			).not.toThrow();
		});

		it("allows ::ffff:8.8.8.8 (public IP)", () => {
			expect(() =>
				validateBundleUrl(new URL("https://[::ffff:8.8.8.8]/")),
			).not.toThrow();
		});
	});
});
