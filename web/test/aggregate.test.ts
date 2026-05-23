import { describe, expect, it } from "bun:test";
import { aggregateGroup } from "../src/lib/tool-display/aggregate";
import type { Tone, ToolDescription } from "../src/lib/tool-display/types";

function desc(overrides: Partial<ToolDescription> & { verb: string }): ToolDescription {
	return {
		id: `id_${Math.random().toString(36).slice(2, 8)}`,
		name: overrides.name ?? "tool",
		verb: overrides.verb,
		object: "",
		tone: "ok" as Tone,
		summary: null,
		headSubject: null,
		input: [],
		resultText: null,
		resultJson: null,
		errorText: null,
		durationMs: null,
		...overrides,
	};
}

describe("aggregateGroup — verb selection", () => {
	it("uses the call's own verb when there is exactly one call", () => {
		const g = aggregateGroup([desc({ verb: "Searched" })]);
		expect(g.verb).toBe("Searched");
	});

	it("uses the verb shared by every call", () => {
		const g = aggregateGroup([
			desc({ verb: "Searched" }),
			desc({ verb: "Searched" }),
			desc({ verb: "Searched" }),
		]);
		expect(g.verb).toBe("Searched");
	});

	it("uses the majority verb when one covers more than half", () => {
		// 2 of 3 "Searched" — majority wins.
		const g = aggregateGroup([
			desc({ verb: "Searched" }),
			desc({ verb: "Searched" }),
			desc({ verb: "Read" }),
		]);
		expect(g.verb).toBe("Searched");
	});

	it("falls back to a neutral verb when no verb has a strict majority", () => {
		// 3-way split — nobody has >50%. Neutral fallback rather than picking
		// the verb that happens to sort last.
		const g = aggregateGroup([
			desc({ verb: "Searched" }),
			desc({ verb: "Read" }),
			desc({ verb: "Listed" }),
		]);
		expect(g.verb).toBe("Worked");
	});

	it("treats a 2-2 tie as no majority (strictly >50%)", () => {
		const g = aggregateGroup([
			desc({ verb: "Searched" }),
			desc({ verb: "Searched" }),
			desc({ verb: "Read" }),
			desc({ verb: "Read" }),
		]);
		expect(g.verb).toBe("Worked");
	});

	it("emits a fallback for an empty group instead of throwing", () => {
		const g = aggregateGroup([]);
		expect(g.verb).toBe("Worked");
		expect(g.count).toBe(0);
		expect(g.tone).toBe("ok");
	});

	it("produces a present-progressive form alongside the past-tense verb", () => {
		const g = aggregateGroup([desc({ verb: "Searched" })]);
		expect(g.verb).toBe("Searched");
		expect(g.verbPresent).toBe("Searching");
	});
});

describe("aggregateGroup — agreed fields", () => {
	it("surfaces an object when every non-null value agrees", () => {
		const g = aggregateGroup([
			desc({ verb: "Read", object: "files" }),
			desc({ verb: "Read", object: "files" }),
		]);
		expect(g.object).toBe("files");
	});

	it("returns null when objects disagree", () => {
		const g = aggregateGroup([
			desc({ verb: "Read", object: "files" }),
			desc({ verb: "Read", object: "issues" }),
		]);
		expect(g.object).toBeNull();
	});

	it("tolerates partial coverage when the non-null values agree", () => {
		// Two calls share "news"; the third has no object inference. We still
		// surface "news" — it's the only signal we have and it doesn't conflict.
		const g = aggregateGroup([
			desc({ verb: "Searched", object: "news" }),
			desc({ verb: "Searched", object: "news" }),
			desc({ verb: "Searched", object: "" }),
		]);
		expect(g.object).toBe("news");
	});

	it("agrees on subject under the same rules", () => {
		const g = aggregateGroup([
			desc({ verb: "Searched", headSubject: "top news" }),
			desc({ verb: "Searched", headSubject: "top news" }),
		]);
		expect(g.subject).toBe("top news");
	});

	it("returns null when subjects disagree", () => {
		const g = aggregateGroup([
			desc({ verb: "Searched", headSubject: "Mercury" }),
			desc({ verb: "Searched", headSubject: "Venus" }),
		]);
		expect(g.subject).toBeNull();
	});
});

describe("aggregateGroup — tone", () => {
	it("returns running when any call is running, regardless of other tones", () => {
		const g = aggregateGroup([
			desc({ verb: "Searched", tone: "ok" }),
			desc({ verb: "Searched", tone: "running" }),
			desc({ verb: "Searched", tone: "error" }),
		]);
		expect(g.tone).toBe("running");
	});

	it("returns ok when every call settled cleanly", () => {
		const g = aggregateGroup([
			desc({ verb: "Searched", tone: "ok" }),
			desc({ verb: "Searched", tone: "ok" }),
		]);
		expect(g.tone).toBe("ok");
	});

	it("treats error → success as recovery (terminal outcome wins)", () => {
		// Agentic self-correction: the model tried, it failed, it adjusted,
		// it succeeded. The chip head shouldn't shout "error" when the
		// model actually got there.
		const g = aggregateGroup([
			desc({ verb: "Searched", tone: "error" }),
			desc({ verb: "Searched", tone: "ok" }),
		]);
		expect(g.tone).toBe("ok");
	});

	it("treats success → error as a terminal failure", () => {
		// The model had something working, then broke it (or moved on to a
		// call that failed). The latest state is what the user needs to know
		// about.
		const g = aggregateGroup([
			desc({ verb: "Searched", tone: "ok" }),
			desc({ verb: "Searched", tone: "error" }),
		]);
		expect(g.tone).toBe("error");
	});

	it("returns error when every call failed (no recovery)", () => {
		const g = aggregateGroup([
			desc({ verb: "Searched", tone: "error" }),
			desc({ verb: "Searched", tone: "error" }),
			desc({ verb: "Searched", tone: "error" }),
		]);
		expect(g.tone).toBe("error");
	});
});

describe("aggregateGroup — totalMs", () => {
	it("sums known durations", () => {
		const g = aggregateGroup([
			desc({ verb: "Searched", durationMs: 100 }),
			desc({ verb: "Searched", durationMs: 250 }),
		]);
		expect(g.totalMs).toBe(350);
	});

	it("skips calls without a known duration but still sums the rest", () => {
		const g = aggregateGroup([
			desc({ verb: "Searched", durationMs: 100 }),
			desc({ verb: "Searched", durationMs: null }),
			desc({ verb: "Searched", durationMs: 50 }),
		]);
		expect(g.totalMs).toBe(150);
	});

	it("returns null when no call has a known duration", () => {
		const g = aggregateGroup([
			desc({ verb: "Searched", durationMs: null }),
			desc({ verb: "Searched", durationMs: null }),
		]);
		expect(g.totalMs).toBeNull();
	});
});

describe("aggregateGroup — count", () => {
	it("counts every description in the group", () => {
		const g = aggregateGroup([
			desc({ verb: "Searched" }),
			desc({ verb: "Read" }),
			desc({ verb: "Listed" }),
		]);
		expect(g.count).toBe(3);
	});
});

describe("aggregateGroup — fallback verb suppresses object", () => {
	// "Worked manage tools" is nonsense — the verb already admits we don't
	// know what happened, so pinning it to a shared object pretends we do.
	// When verb falls back, object collapses to null and the chip head
	// reads as just the fallback verb (plus subject / count, which remain
	// meaningful).
	it("clears object when no verb has a majority but objects agree", () => {
		const g = aggregateGroup([
			desc({ verb: "Added", object: "tools" }),
			desc({ verb: "Listed", object: "tools" }),
			desc({ verb: "Removed", object: "tools" }),
		]);
		expect(g.verb).toBe("Worked");
		expect(g.object).toBeNull();
	});

	it("preserves subject even when the verb is the fallback", () => {
		// Subject comes from the user's input, not from tool semantics — it
		// remains true regardless of what verb we settle on.
		const g = aggregateGroup([
			desc({ verb: "Added", object: "tools", headSubject: "alpha" }),
			desc({ verb: "Listed", object: "tools", headSubject: "alpha" }),
			desc({ verb: "Removed", object: "tools", headSubject: "alpha" }),
		]);
		expect(g.verb).toBe("Worked");
		expect(g.object).toBeNull();
		expect(g.subject).toBe("alpha");
	});

	it("still includes object for a single call (no fallback path triggered)", () => {
		const g = aggregateGroup([desc({ verb: "Worked", object: "tools" })]);
		// Single-call short-circuit returns the call's own verb; "Worked" here
		// is the literal verb, not the aggregation fallback, so object stays.
		expect(g.verb).toBe("Worked");
		expect(g.object).toBe("tools");
	});
});

describe("aggregateGroup — user's mixed-tool scenario", () => {
	// The case from the screenshot: three search-shaped tools with different
	// names but the same inferred verb ("Searched") and a shared subject
	// pulled from the user's prompt ("news headlines"). The old hard-coded
	// rule said "Used tools" because tool *names* differed. The aggregator
	// now uses the verb because all three describe Searches.
	it("uses the shared verb when tool NAMES differ but VERBS agree", () => {
		const g = aggregateGroup([
			desc({ verb: "Searched", name: "news_search", headSubject: "news headlines" }),
			desc({ verb: "Searched", name: "web_search", headSubject: "news headlines" }),
			desc({ verb: "Searched", name: "headlines_lookup", headSubject: "news headlines" }),
		]);
		expect(g.verb).toBe("Searched");
		expect(g.subject).toBe("news headlines");
		expect(g.count).toBe(3);
	});
});
