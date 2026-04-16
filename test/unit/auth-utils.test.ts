import { describe, expect, it } from "bun:test";
import { constantTimeEqual } from "../../src/api/auth-utils.ts";

describe("constantTimeEqual", () => {
	it("returns true for matching strings", () => {
		expect(constantTimeEqual("abc", "abc")).toBe(true);
	});

	it("returns false for different strings of same length", () => {
		expect(constantTimeEqual("abc", "abd")).toBe(false);
	});

	it("returns false for different-length strings", () => {
		expect(constantTimeEqual("abc", "abcd")).toBe(false);
	});

	it("returns true for empty strings", () => {
		expect(constantTimeEqual("", "")).toBe(true);
	});
});
