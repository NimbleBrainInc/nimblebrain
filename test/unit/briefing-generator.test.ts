import { describe, expect, it } from "bun:test";
import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider";
import type { ActivityOutput, HomeConfig } from "../../src/services/home-types.ts";
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
					inputTokens: {
						total: 100,
						noCache: undefined,
						cacheRead: undefined,
						cacheWrite: undefined,
					},
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
					inputTokens: {
						total: 100,
						noCache: undefined,
						cacheRead: undefined,
						cacheWrite: undefined,
					},
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
		userName: "Mat",
		timezone: "Pacific/Honolulu",
		cacheTtlMinutes: 15,
		...overrides,
	};
}

/** Build a generator with the simplified (model, modelString, config) ctor. */
function makeGen(
	model: LanguageModelV3,
	modelString: string | null = "anthropic:claude-sonnet-4-6",
	config: HomeConfig = makeConfig(),
): BriefingGenerator {
	return new BriefingGenerator(model, modelString, config);
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
			const gen = makeGen(model);
			const result = await gen.generate(emptyActivity());

			expect(result.state).toBe("quiet");
			expect(result.lede).toContain("quiet");
			expect(result.sections).toEqual([]);
			expect(result.cached).toBe(false);
			expect(calls).toHaveLength(0);
		});
	});

	describe("greeting", () => {
		it("greets the user by name", async () => {
			const { model } = createTrackingModelV3("{}");
			const gen = makeGen(model, null, makeConfig({ timezone: "Pacific/Honolulu" }));
			const result = await gen.generate(emptyActivity());

			expect(result.greeting).toContain("Mat");
			expect(
				result.greeting.startsWith("Good morning") ||
					result.greeting.startsWith("Good afternoon") ||
					result.greeting.startsWith("Good evening"),
			).toBe(true);
		});

		it("falls back when timezone is empty", async () => {
			const { model } = createTrackingModelV3("{}");
			const gen = makeGen(model, null, makeConfig({ timezone: "" }));
			const result = await gen.generate(emptyActivity());

			expect(result.greeting).toContain("Mat");
		});

		it("falls back when timezone is invalid", async () => {
			const { model } = createTrackingModelV3("{}");
			const gen = makeGen(model, null, makeConfig({ timezone: "Invalid/Zone" }));
			const result = await gen.generate(emptyActivity());

			expect(result.greeting).toContain("Mat");
		});
	});

	describe("date formatting", () => {
		it("formats date as weekday, month day, year", async () => {
			const model = createMockModelV3("{}");
			const gen = makeGen(model);
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
			const gen = makeGen(model);
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
			const gen = makeGen(model);
			const result = await gen.generate(activeActivity());

			expect(result.lede).toBe("All systems normal.");
			expect(result.sections).toHaveLength(1);
		});

		it("throws on invalid JSON", async () => {
			// Failures are no longer hidden by a heuristic fallback —
			// generate() throws and the caller (core-source.ts) renders
			// an error result the UI shows as a clear retry state.
			const model = createMockModelV3("This is not JSON at all");
			const gen = makeGen(model);

			await expect(gen.generate(activeActivity())).rejects.toThrow();
		});

		it("throws when JSON is missing lede", async () => {
			const model = createMockModelV3(JSON.stringify({ sections: [] }));
			const gen = makeGen(model);

			await expect(gen.generate(activeActivity())).rejects.toThrow();
		});

		it("throws when JSON is missing sections", async () => {
			const model = createMockModelV3(JSON.stringify({ lede: "Hi" }));
			const gen = makeGen(model);

			await expect(gen.generate(activeActivity())).rejects.toThrow();
		});

		it("repairs truncated JSON when finishReason is length", async () => {
			const truncated = `{"lede": "3 follow-ups overdue.", "sections": [{"id": "followups", "text": "3 follow-ups need attention in CRM.", "type": "warning", "category": "attention"}, {"id": "tasks", "text": "You have 1 high-priority task du`;
			const model = createTruncatedModelV3(truncated);
			const gen = makeGen(model);
			const result = await gen.generate(activeActivity());

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
			const gen = makeGen(model);
			const result = await gen.generate(activeActivity());

			expect(result.lede).toBe("3 items need attention.");
			expect(result.sections).toHaveLength(2);
		});

		it("repairs truncated JSON wrapped in markdown fences", async () => {
			const truncated =
				'```json\n{"lede": "All clear.", "sections": [{"id": "status", "text": "Running smoothly.", "type": "positive", "category": "recent"}';
			const model = createTruncatedModelV3(truncated);
			const gen = makeGen(model);
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
			const gen = makeGen(model);
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
			const gen = makeGen(model);
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
			const gen = makeGen(model);
			const result = await gen.generate(activeActivity());

			expect(result.state).toBe("normal");
		});
	});

	describe("model call parameters", () => {
		it("passes calibrated maxOutputTokens, JSON response format, and timeout", async () => {
			const llmResponse = JSON.stringify({ lede: "Ok.", sections: [] });
			const { model, calls } = createTrackingModelV3(llmResponse);
			const gen = makeGen(model);
			await gen.generate(activeActivity());

			expect(calls).toHaveLength(1);
			expect(calls[0].maxOutputTokens).toBe(1500);
			expect(calls[0].responseFormat?.type).toBe("json");
			expect(calls[0].responseFormat).toHaveProperty("schema");
			expect(calls[0].responseFormat).toHaveProperty("name", "briefing");
			expect(calls[0].abortSignal).toBeDefined();
		});

		it("reports the generation's usage via onUsage", async () => {
			const llmResponse = JSON.stringify({ lede: "Ok.", sections: [] });
			const { model } = createTrackingModelV3(llmResponse);
			let seen: { inputTokens: number; outputTokens: number } | undefined;
			const gen = new BriefingGenerator(
				model,
				"anthropic:claude-sonnet-4-6",
				makeConfig(),
				(usage) => {
					seen = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
				},
			);
			await gen.generate(activeActivity());

			expect(seen?.inputTokens).toBe(100);
			expect(seen?.outputTokens).toBe(50);
		});

		it("disables Anthropic thinking for reasoning-capable Claude models", async () => {
			const llmResponse = JSON.stringify({ lede: "Ok.", sections: [] });
			const { model, calls } = createTrackingModelV3(llmResponse);
			const gen = makeGen(model, "anthropic:claude-sonnet-4-6");
			await gen.generate(activeActivity());

			expect(calls[0].providerOptions).toEqual({
				anthropic: { thinking: { type: "disabled" } },
			});
		});

		it("omits Anthropic thinking option for non-reasoning Claude models", async () => {
			const llmResponse = JSON.stringify({ lede: "Ok.", sections: [] });
			const { model, calls } = createTrackingModelV3(llmResponse);
			const gen = makeGen(model, "anthropic:claude-3-5-haiku-latest");
			await gen.generate(activeActivity());

			expect(calls[0].providerOptions).toBeUndefined();
		});

		it("disables Gemini thinking budget for 2.5 series", async () => {
			const llmResponse = JSON.stringify({ lede: "Ok.", sections: [] });
			const { model, calls } = createTrackingModelV3(llmResponse);
			const gen = makeGen(model, "google:gemini-2.5-flash");
			await gen.generate(activeActivity());

			expect(calls[0].providerOptions).toEqual({
				google: { thinkingConfig: { thinkingBudget: 0 } },
			});
		});

		it("sets reasoningEffort=minimal for OpenAI reasoning models", async () => {
			const llmResponse = JSON.stringify({ lede: "Ok.", sections: [] });
			const { model, calls } = createTrackingModelV3(llmResponse);
			const gen = makeGen(model, "openai:gpt-5");
			await gen.generate(activeActivity());

			expect(calls[0].providerOptions).toEqual({
				openai: { reasoningEffort: "minimal" },
			});
		});

		it("omits providerOptions for non-reasoning models", async () => {
			const llmResponse = JSON.stringify({ lede: "Ok.", sections: [] });
			const { model, calls } = createTrackingModelV3(llmResponse);
			const gen = makeGen(model, "openai:gpt-4o");
			await gen.generate(activeActivity());

			expect(calls[0].providerOptions).toBeUndefined();
		});

		it("omits providerOptions when modelString is null", async () => {
			const llmResponse = JSON.stringify({ lede: "Ok.", sections: [] });
			const { model, calls } = createTrackingModelV3(llmResponse);
			const gen = makeGen(model, null);
			await gen.generate(activeActivity());

			expect(calls[0].providerOptions).toBeUndefined();
		});

		it("sends activity as user message JSON", async () => {
			const llmResponse = JSON.stringify({ lede: "Ok.", sections: [] });
			const { model, calls } = createTrackingModelV3(llmResponse);
			const gen = makeGen(model);
			const activity = activeActivity();
			await gen.generate(activity);

			const userMsgs = calls[0].prompt.filter((m) => m.role === "user");
			expect(userMsgs).toHaveLength(1);
			const userContent = userMsgs[0].content;
			expect(Array.isArray(userContent)).toBe(true);
			const textPart = (userContent as Array<{ type: string; text: string }>).find(
				(p) => p.type === "text",
			);
			const parsed = JSON.parse(textPart!.text);
			expect(parsed).toHaveProperty("system_activity");
			expect(parsed.system_activity.conversations).toBe(activity.totals.conversations);
			expect(parsed.system_activity.tool_calls).toBe(activity.totals.tool_calls);
		});
	});

	describe("input bounding", () => {
		it("truncates large facet data payloads", async () => {
			const llmResponse = JSON.stringify({ lede: "Ok.", sections: [] });
			const { model, calls } = createTrackingModelV3(llmResponse);
			const gen = makeGen(model);
			const bigData = "x".repeat(5000);
			const facetContext = {
				period: { since: "2026-03-24T00:00:00Z", until: "2026-03-25T00:00:00Z" },
				facets: [
					{
						appName: "App",
						serverName: "app",
						appRoute: "/app",
						appCategory: undefined,
						facet: {
							name: "f",
							label: "F",
							type: "activity" as const,
							entity: "thing",
						},
						data: bigData,
						ok: true,
					},
				],
			};

			await gen.generate(activeActivity(), facetContext as never);

			const userText = (calls[0].prompt[1].content as Array<{ type: string; text: string }>)[0]
				.text;
			const parsed = JSON.parse(userText);
			expect(parsed.app_facets[0].data.length).toBeLessThan(bigData.length);
			expect(parsed.app_facets[0].data).toContain("(truncated)");
		});
	});

});
