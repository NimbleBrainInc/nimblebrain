import { describe, expect, it } from "bun:test";
import { fallbackTitle, generateTitle } from "../../src/conversation/auto-title.ts";
import { createMockModel } from "../helpers/mock-model.ts";

describe("fallbackTitle", () => {
	it("returns full message when under 60 chars", () => {
		const msg = "Hello, how are you?";
		expect(fallbackTitle(msg)).toBe(msg);
	});

	it("returns full message when exactly 60 chars", () => {
		const msg = "a".repeat(60);
		expect(fallbackTitle(msg)).toBe(msg);
	});

	it("truncates at word boundary for long messages", () => {
		const msg =
			"Write a comprehensive guide about machine learning algorithms and their practical implementations in modern software";
		const result = fallbackTitle(msg);
		expect(result.length).toBeLessThanOrEqual(60);
		expect(msg.startsWith(result)).toBe(true);
		expect(msg[result.length]).toBe(" ");
	});

	it("truncates at 60 chars when no space after position 20", () => {
		const msg = "short prefix then " + "x".repeat(80);
		const result = fallbackTitle(msg);
		expect(result.length).toBe(60);
	});
});

describe("generateTitle", () => {
	it("falls back to truncated user message on API error", async () => {
		// Model that throws to trigger fallback
		const failingModel = createMockModel(() => {
			throw new Error("API error");
		});
		const title = await generateTitle(
			failingModel,
			"Tell me about quantum computing and its applications",
			"Quantum computing is a fascinating field...",
		);
		expect(title).toBe(
			"Tell me about quantum computing and its applications",
		);
	});

	it("falls back for long messages on error, truncated at word boundary", async () => {
		const failingModel = createMockModel(() => {
			throw new Error("API error");
		});
		const longMsg =
			"Please explain the differences between classical computing and quantum computing in detail with examples";
		const title = await generateTitle(
			failingModel,
			longMsg,
			"Classical computing uses bits...",
		);
		expect(title.length).toBeLessThanOrEqual(60);
		expect(longMsg.startsWith(title.trimEnd())).toBe(true);
	});
});
