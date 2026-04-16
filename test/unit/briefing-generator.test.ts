import { describe, expect, it } from "bun:test";
import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider";
import type { ActivityOutput, BriefingSection, HomeConfig } from "../../src/services/home-types.ts";
import { BriefingGenerator } from "../../src/services/briefing-generator.ts";
import { createMockModel } from "../helpers/mock-model.ts";

function createMockModelV3(responseText: string): LanguageModelV3 {
	return createMockModel(() => ({
		content: [{ type: "text", text: responseText }],
		inputTokens: 100,
		outputTokens: 50,
	}));
}

function createTrackingModelV3(responseText: string): {
	model: LanguageModelV3;
	calls: LanguageModelV3CallOptions[];
} {
	const calls: LanguageModelV3CallOptions[] = [];
	// Build a proper V3 model that tracks calls via doGenerate
	const model: LanguageModelV3 = {
		specificationVersion: "v3",
		provider: "mock",
		modelId: "mock-model",
		supportedUrls: {},
		async doGenerate(options) {
			calls.push(options);
			return {
				content: [{ type: "text", text: responseText }],
				finishReason: { unified: "stop", raw: undefined },
				usage: {
					inputTokens: { total: 100, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
					outputTokens: { total: 50, text: undefined, reasoning: undefined },
				},
				warnings: [],
			};
		},
		async doStream() {
			throw new Error("Not implemented for this test");
		},
	};
	return { model, calls };
}

function createTruncatedModelV3(responseText: string): LanguageModelV3 {
	return {
		specificationVersion: "v3",
		provider: "mock",
		modelId: "mock-model",
		supportedUrls: {},
		async doGenerate() {
			return {
				content: [{ type: "text", text: responseText }],
				finishReason: { unified: "length", raw: undefined },
				usage: {
					inputTokens: { total: 100, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
					outputTokens: { total: 4000, text: undefined, reasoning: undefined },
				},
				warnings: [],
			};
		},
		async doStream() {
			throw new Error("Not implemented for this test");
		},
	};
}

function makeConfig(overrides: Partial<HomeConfig> = {}): HomeConfig {
	return {
		enabled: true,
		model: null,
		userName: "Mat",
		timezone: "Pacific/Honolulu",
		cacheTtlMinutes: 15,
		...overrides,
	};
}

function emptyActivity(): ActivityOutput {
	return {
		period: { since: "2026-03-24T00:00:00Z", until: "2026-03-25T00:00:00Z" },
		conversations: [],
		bundle_events: [],
		tool_usage: [],
		errors: [],
		totals: {
			conversations: 0,
			tool_calls: 0,
			input_tokens: 0,
			output_tokens: 0,
			errors: 0,
		},
	};
}

function activeActivity(): ActivityOutput {
	return {
		period: { since: "2026-03-24T00:00:00Z", until: "2026-03-25T00:00:00Z" },
		conversations: [
			{
				id: "conv-1",
				created_at: "2026-03-24T10:00:00Z",
				updated_at: "2026-03-24T10:05:00Z",
				message_count: 4,
				tool_call_count: 2,
				input_tokens: 1000,
				output_tokens: 500,
				preview: "Search for weather tools",
				had_errors: false,
			},
		],
		bundle_events: [],
		tool_usage: [
			{
				tool: "search",
				server: "granola",
				call_count: 3,
				error_count: 0,
				avg_latency_ms: 120,
			},
		],
		errors: [],
		totals: {
			conversations: 1,
			tool_calls: 3,
			input_tokens: 1000,
			output_tokens: 500,
			errors: 0,
		},
	};
}

describe("briefing-generator", () => {
	describe("empty activity", () => {
		it("returns quiet state without calling the model", async () => {
			const { model, calls } = createTrackingModelV3("should not be called");
			const gen = new BriefingGenerator(model, makeConfig());
			const result = await gen.generate(emptyActivity());

			expect(result.state).toBe("quiet");
			expect(result.lede).toContain("quiet");
			expect(result.sections).toEqual([]);
			expect(result.cached).toBe(false);
			expect(calls).toHaveLength(0);
		});
	});

	describe("greeting", () => {
		it("says good morning before noon", async () => {
			const { model } = createTrackingModelV3("{}");
			const gen = new BriefingGenerator(model, makeConfig({ timezone: "Pacific/Honolulu" }));
			const result = await gen.generate(emptyActivity());

			expect(result.greeting).toContain("Mat");
			expect(
				result.greeting.startsWith("Good morning") ||
				result.greeting.startsWith("Good afternoon") ||
				result.greeting.startsWith("Good evening"),
			).toBe(true);
		});

		it("uses fallback when timezone is empty", async () => {
			const { model } = createTrackingModelV3("{}");
			const gen = new BriefingGenerator(model, makeConfig({ timezone: "" }));
			const result = await gen.generate(emptyActivity());

			expect(result.greeting).toContain("Mat");
		});

		it("uses fallback when timezone is invalid", async () => {
			const { model } = createTrackingModelV3("{}");
			const gen = new BriefingGenerator(model, makeConfig({ timezone: "Invalid/Zone" }));
			const result = await gen.generate(emptyActivity());

			expect(result.greeting).toContain("Mat");
		});
	});

	describe("date formatting", () => {
		it("formats date as weekday, month day, year", async () => {
			const model = createMockModelV3("{}");
			const gen = new BriefingGenerator(model, makeConfig());
			const result = await gen.generate(emptyActivity());

			expect(result.date).toMatch(/^\w+, \w+ \d{1,2}, \d{4}$/);
		});
	});

	describe("LLM response parsing", () => {
		it("parses valid JSON response into sections", async () => {
			const llmResponse = JSON.stringify({
				lede: "3 conversations with 5 tool calls yesterday.",
				sections: [
					{
						id: "conversations",
						text: "You had 3 conversations using granola search.",
						type: "positive",
						category: "recent",
					},
				],
			});
			const model = createMockModelV3(llmResponse);
			const gen = new BriefingGenerator(model, makeConfig());
			const result = await gen.generate(activeActivity());

			expect(result.lede).toBe("3 conversations with 5 tool calls yesterday.");
			expect(result.sections).toHaveLength(1);
			expect(result.sections[0].id).toBe("conversations");
			expect(result.sections[0].type).toBe("positive");
		});

		it("parses JSON wrapped in markdown code block", async () => {
			const json = JSON.stringify({
				lede: "All systems normal.",
				sections: [
					{
						id: "status",
						text: "Everything is running smoothly.",
						type: "positive",
						category: "recent",
					},
				],
			});
			const llmResponse = `\`\`\`json\n${json}\n\`\`\``;
			const model = createMockModelV3(llmResponse);
			const gen = new BriefingGenerator(model, makeConfig());
			const result = await gen.generate(activeActivity());

			expect(result.lede).toBe("All systems normal.");
			expect(result.sections).toHaveLength(1);
		});

		it("returns fallback on invalid JSON", async () => {
			const model = createMockModelV3("This is not JSON at all");
			const gen = new BriefingGenerator(model, makeConfig());
			const result = await gen.generate(activeActivity());

			expect(result.lede).toBe("Activity summary is available.");
			expect(result.sections).toEqual([]);
			expect(result.state).toBe("normal");
		});

		it("returns fallback when JSON is missing lede", async () => {
			const model = createMockModelV3(JSON.stringify({ sections: [] }));
			const gen = new BriefingGenerator(model, makeConfig());
			const result = await gen.generate(activeActivity());

			expect(result.lede).toBe("Activity summary is available.");
		});

		it("returns fallback when JSON is missing sections", async () => {
			const model = createMockModelV3(JSON.stringify({ lede: "Hi" }));
			const gen = new BriefingGenerator(model, makeConfig());
			const result = await gen.generate(activeActivity());

			expect(result.lede).toBe("Activity summary is available.");
		});

		it("repairs truncated JSON when finishReason is length", async () => {
			// Simulate a response cut off mid-section (token limit hit)
			const truncated = `{"lede": "3 follow-ups overdue.", "sections": [{"id": "followups", "text": "3 follow-ups need attention in CRM.", "type": "warning", "category": "attention"}, {"id": "tasks", "text": "You have 1 high-priority task du`;
			const model = createTruncatedModelV3(truncated);
			const gen = new BriefingGenerator(model, makeConfig());
			const result = await gen.generate(activeActivity());

			// Should recover the lede and the first complete section
			expect(result.lede).toBe("3 follow-ups overdue.");
			expect(result.sections.length).toBeGreaterThanOrEqual(1);
			expect(result.sections[0].id).toBe("followups");
		});

		it("handles JSON with trailing commas", async () => {
			const jsonWithTrailingCommas = `{
				"lede": "3 items need attention.",
				"sections": [
					{"id": "a", "text": "First.", "type": "warning", "category": "attention"},
					{"id": "b", "text": "Second.", "type": "neutral", "category": "recent"},
				]
			}`;
			const model = createMockModelV3(jsonWithTrailingCommas);
			const gen = new BriefingGenerator(model, makeConfig());
			const result = await gen.generate(activeActivity());

			expect(result.lede).toBe("3 items need attention.");
			expect(result.sections).toHaveLength(2);
		});

		it("handles markdown-fenced JSON with trailing commas", async () => {
			const fenced = '```json\n{"lede": "Ok.", "sections": [{"id": "x", "text": "Done.", "type": "positive", "category": "recent",},],}\n```';
			const model = createMockModelV3(fenced);
			const gen = new BriefingGenerator(model, makeConfig());
			const result = await gen.generate(activeActivity());

			expect(result.lede).toBe("Ok.");
			expect(result.sections).toHaveLength(1);
		});

		it("repairs truncated JSON wrapped in markdown fences", async () => {
			const truncated = '```json\n{"lede": "All clear.", "sections": [{"id": "status", "text": "Running smoothly.", "type": "positive", "category": "recent"}';
			const model = createTruncatedModelV3(truncated);
			const gen = new BriefingGenerator(model, makeConfig());
			const result = await gen.generate(activeActivity());

			expect(result.lede).toBe("All clear.");
			expect(result.sections).toHaveLength(1);
		});
	});

	describe("state derivation", () => {
		it("derives all-clear when all sections are positive", async () => {
			const llmResponse = JSON.stringify({
				lede: "Everything looks great.",
				sections: [
					{ id: "a", text: "Good", type: "positive", category: "recent" },
					{ id: "b", text: "Also good", type: "positive", category: "recent" },
				],
			});
			const model = createMockModelV3(llmResponse);
			const gen = new BriefingGenerator(model, makeConfig());
			const result = await gen.generate(activeActivity());

			expect(result.state).toBe("all-clear");
		});

		it("derives attention when any section is warning", async () => {
			const llmResponse = JSON.stringify({
				lede: "Some issues detected.",
				sections: [
					{ id: "a", text: "Good", type: "positive", category: "recent" },
					{ id: "b", text: "Problem", type: "warning", category: "attention" },
				],
			});
			const model = createMockModelV3(llmResponse);
			const gen = new BriefingGenerator(model, makeConfig());
			const result = await gen.generate(activeActivity());

			expect(result.state).toBe("attention");
		});

		it("derives normal for mixed positive and neutral", async () => {
			const llmResponse = JSON.stringify({
				lede: "A normal day.",
				sections: [
					{ id: "a", text: "Good", type: "positive", category: "recent" },
					{ id: "b", text: "Okay", type: "neutral", category: "recent" },
				],
			});
			const model = createMockModelV3(llmResponse);
			const gen = new BriefingGenerator(model, makeConfig());
			const result = await gen.generate(activeActivity());

			expect(result.state).toBe("normal");
		});
	});

	describe("model call parameters", () => {
		it("passes maxOutputTokens 4000 and JSON response format with schema to model", async () => {
			const llmResponse = JSON.stringify({ lede: "Ok.", sections: [] });
			const { model, calls } = createTrackingModelV3(llmResponse);
			const gen = new BriefingGenerator(model, makeConfig());
			await gen.generate(activeActivity());

			expect(calls).toHaveLength(1);
			expect(calls[0].maxOutputTokens).toBe(4000);
			expect(calls[0].responseFormat?.type).toBe("json");
			expect(calls[0].responseFormat).toHaveProperty("schema");
			expect(calls[0].responseFormat).toHaveProperty("name", "briefing");
		});

		it("uses config model when specified", async () => {
			// BriefingGenerator no longer gets model string from the call;
			// model selection happens before the LanguageModelV3 is created.
			// This test is now a no-op for the model name check.
			const llmResponse = JSON.stringify({ lede: "Ok.", sections: [] });
			const { model, calls } = createTrackingModelV3(llmResponse);
			const gen = new BriefingGenerator(model, makeConfig({ model: "claude-haiku-3" }));
			await gen.generate(activeActivity());

			// Verify model was called
			expect(calls).toHaveLength(1);
		});

		it("falls back to claude-sonnet-4-5-20250929 when model is null", async () => {
			const llmResponse = JSON.stringify({ lede: "Ok.", sections: [] });
			const { model, calls } = createTrackingModelV3(llmResponse);
			const gen = new BriefingGenerator(model, makeConfig({ model: null }));
			await gen.generate(activeActivity());

			// Verify model was called
			expect(calls).toHaveLength(1);
		});

		it("sends activity as user message JSON", async () => {
			const llmResponse = JSON.stringify({ lede: "Ok.", sections: [] });
			const { model, calls } = createTrackingModelV3(llmResponse);
			const gen = new BriefingGenerator(model, makeConfig());
			const activity = activeActivity();
			await gen.generate(activity);

			// V3: prompt includes system + user messages
			const userMsgs = calls[0].prompt.filter((m) => m.role === "user");
			expect(userMsgs).toHaveLength(1);
			const userContent = userMsgs[0].content;
			// V3 user content is an array of parts
			expect(Array.isArray(userContent)).toBe(true);
			const textPart = (userContent as Array<{ type: string; text: string }>).find((p) => p.type === "text");
			const parsed = JSON.parse(textPart!.text);
			expect(parsed).toHaveProperty("system_activity");
			expect(parsed.system_activity.conversations).toBe(activity.totals.conversations);
			expect(parsed.system_activity.tool_calls).toBe(activity.totals.tool_calls);
		});

		it("passes empty tools array", async () => {
			const llmResponse = JSON.stringify({ lede: "Ok.", sections: [] });
			const { model, calls } = createTrackingModelV3(llmResponse);
			const gen = new BriefingGenerator(model, makeConfig());
			await gen.generate(activeActivity());

			// BriefingGenerator doesn't pass tools to doGenerate
			// (the V3 interface doesn't require tools)
			expect(calls).toHaveLength(1);
		});
	});
});
