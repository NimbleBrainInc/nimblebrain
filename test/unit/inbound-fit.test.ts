import { describe, expect, it } from "bun:test";
import type { LanguageModelV3Content } from "@ai-sdk/provider";
import { normalizeForReplay } from "../../src/model/inbound-fit.ts";

describe("normalizeForReplay", () => {
	it("returns an empty array for empty input", () => {
		expect(normalizeForReplay([])).toEqual([]);
	});

	it("parses string-encoded tool-call input into an object", () => {
		const input: LanguageModelV3Content[] = [
			{
				type: "tool-call",
				toolCallId: "tc-1",
				toolName: "search",
				input: '{"query":"cats"}',
			},
		];
		const out = normalizeForReplay(input);
		expect(out[0]).toEqual({
			type: "tool-call",
			toolCallId: "tc-1",
			toolName: "search",
			input: { query: "cats" },
		});
	});

	it("falls back to empty object on unparseable tool-call input", () => {
		const input: LanguageModelV3Content[] = [
			{
				type: "tool-call",
				toolCallId: "tc-1",
				toolName: "search",
				input: "not-json",
			},
		];
		const out = normalizeForReplay(input);
		expect(out[0]).toMatchObject({
			type: "tool-call",
			input: {},
		});
	});

	it("copies providerMetadata to providerOptions on reasoning blocks (Anthropic signature path)", () => {
		const input: LanguageModelV3Content[] = [
			{
				type: "reasoning",
				text: "Need to look this up.",
				providerMetadata: { anthropic: { signature: "sig-abc" } },
			},
		];
		const out = normalizeForReplay(input);
		// Spread keeps providerMetadata; the rename adds providerOptions.
		expect(out[0]).toMatchObject({
			type: "reasoning",
			text: "Need to look this up.",
			providerMetadata: { anthropic: { signature: "sig-abc" } },
			providerOptions: { anthropic: { signature: "sig-abc" } },
		});
	});

	it("copies providerMetadata to providerOptions on tool-call blocks (Gemini thoughtSignature path)", () => {
		// Regression guard for the Gemini `nb__status` failure: when a
		// functionCall part carries `providerMetadata.google.thoughtSignature`
		// from the inbound stream, replay must surface it on `providerOptions`
		// so the prompt-side converter forwards it on the next call. Without
		// this, Gemini 400s with "Function call is missing a thought_signature
		// in functionCall parts."
		const input: LanguageModelV3Content[] = [
			{
				type: "tool-call",
				toolCallId: "tc-1",
				toolName: "nb__status",
				input: "{}",
				providerMetadata: { google: { thoughtSignature: "sig-xyz" } },
			},
		];
		const out = normalizeForReplay(input);
		expect(out[0]).toMatchObject({
			type: "tool-call",
			toolCallId: "tc-1",
			toolName: "nb__status",
			input: {},
			providerMetadata: { google: { thoughtSignature: "sig-xyz" } },
			providerOptions: { google: { thoughtSignature: "sig-xyz" } },
		});
	});

	it("copies providerMetadata to providerOptions on text blocks (Gemini thoughtSignature on text)", () => {
		// Gemini also attaches thoughtSignature to text parts; same treatment
		// keeps replay correct without a per-type branch.
		const input: LanguageModelV3Content[] = [
			{
				type: "text",
				text: "Result is 42.",
				providerMetadata: { google: { thoughtSignature: "sig-text" } },
			},
		];
		const out = normalizeForReplay(input);
		expect(out[0]).toMatchObject({
			type: "text",
			providerOptions: { google: { thoughtSignature: "sig-text" } },
		});
	});

	it("leaves parts without providerMetadata unchanged", () => {
		const input: LanguageModelV3Content[] = [
			{ type: "text", text: "plain" },
			{
				type: "tool-call",
				toolCallId: "tc-1",
				toolName: "echo",
				input: { x: 1 }, // already an object — no parse needed
			},
		];
		const out = normalizeForReplay(input);
		expect(out[0]).toEqual({ type: "text", text: "plain" });
		expect(out[1]).toEqual({
			type: "tool-call",
			toolCallId: "tc-1",
			toolName: "echo",
			input: { x: 1 },
		});
		expect("providerOptions" in out[0]!).toBe(false);
		expect("providerOptions" in out[1]!).toBe(false);
	});

	it("is idempotent — applying twice produces the same result", () => {
		const input: LanguageModelV3Content[] = [
			{
				type: "tool-call",
				toolCallId: "tc-1",
				toolName: "nb__status",
				input: '{"k":"v"}',
				providerMetadata: { google: { thoughtSignature: "sig" } },
			},
			{
				type: "reasoning",
				text: "thinking",
				providerMetadata: { anthropic: { signature: "sig-r" } },
			},
		];
		const once = normalizeForReplay(input);
		const twice = normalizeForReplay(once);
		expect(twice).toEqual(once);
	});

	it("handles tool-call with both string input AND providerMetadata in one pass", () => {
		// The Gemini `nb__status` failure exercised exactly this shape:
		// stream-encoded JSON-string input + thoughtSignature metadata.
		// Both transformations must apply to the same part.
		const input: LanguageModelV3Content[] = [
			{
				type: "tool-call",
				toolCallId: "tc-1",
				toolName: "nb__status",
				input: '{"verbose":true}',
				providerMetadata: { google: { thoughtSignature: "sig-combined" } },
			},
		];
		const out = normalizeForReplay(input);
		expect(out[0]).toMatchObject({
			input: { verbose: true },
			providerOptions: { google: { thoughtSignature: "sig-combined" } },
		});
	});

	it("does not mutate the input array or its parts", () => {
		const original: LanguageModelV3Content[] = [
			{
				type: "reasoning",
				text: "thoughts",
				providerMetadata: { anthropic: { signature: "sig" } },
			},
		];
		const snapshot = JSON.parse(JSON.stringify(original));
		normalizeForReplay(original);
		expect(original).toEqual(snapshot);
	});
});
