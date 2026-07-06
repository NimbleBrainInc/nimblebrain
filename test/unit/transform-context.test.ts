import { describe, expect, it } from "bun:test";
import type { LanguageModelV3Message } from "@ai-sdk/provider";
import { buildTransformContext } from "../../src/runtime/runtime.ts";

// --- builders (mirroring window.test.ts / the engine's per-step append) -------

function userMsg(text: string): LanguageModelV3Message {
	return { role: "user", content: [{ type: "text" as const, text }] };
}

/** One agentic step = an assistant tool-call + its tool-result (one group). */
function step(i: number): LanguageModelV3Message[] {
	return [
		{
			role: "assistant",
			content: [
				{ type: "tool-call" as const, toolCallId: `c${i}`, toolName: "t", input: { i } },
			],
		},
		{
			role: "tool",
			content: [
				{
					type: "tool-result" as const,
					toolCallId: `c${i}`,
					toolName: "t",
					output: { type: "text" as const, value: `result ${i}` },
				},
			],
		},
	];
}

/** history = initial user message + `nSteps` groups. */
function history(nSteps: number): LanguageModelV3Message[] {
	const msgs: LanguageModelV3Message[] = [userMsg("go")];
	for (let i = 0; i < nSteps; i++) msgs.push(...step(i));
	return msgs;
}

const PROVIDER = "anthropic";
// Huge budget so windowMessages never trims — isolates the append-only behavior.
const BIG_BUDGET = 5_000_000;

describe("buildTransformContext — append-only history", () => {
	it("does not front-slice: a long history passes through unchanged", () => {
		const transform = buildTransformContext(BIG_BUDGET, PROVIDER);
		const h = history(60); // well past any former group cap
		expect(transform(h, undefined)).toEqual(h);
	});

	it("appending a step leaves the prior prefix byte-identical (no cache bust)", () => {
		const transform = buildTransformContext(BIG_BUDGET, PROVIDER);
		const h50 = history(50);
		const out50 = transform(h50, undefined);
		const out51 = transform([...h50, ...step(50)], undefined);
		// The prefix (everything but the newly appended step) is unchanged, so
		// the prompt cache reads it back instead of re-writing it.
		expect(out51.slice(0, out50.length)).toEqual(out50);
	});

	it("still trims to the token budget on overflow (windowMessages is the guard)", () => {
		// A tiny budget forces windowMessages to drop oldest groups — the
		// overflow guard still works now that per-call slicing is gone.
		const transform = buildTransformContext(500, PROVIDER);
		const h = history(60);
		const out = transform(h, undefined);
		expect(out.length).toBeLessThan(h.length);
		expect(out[0]).toEqual(h[0]); // first message always kept
	});
});
