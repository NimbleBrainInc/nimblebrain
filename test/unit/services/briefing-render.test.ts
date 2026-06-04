import { describe, expect, test } from "bun:test";
import { renderBriefingText } from "../../../src/services/briefing-render.ts";
import type { BriefingOutput, BriefingSection } from "../../../src/services/home-types.ts";

function section(overrides: Partial<BriefingSection> & Pick<BriefingSection, "category">): BriefingSection {
	return {
		id: "s1",
		text: "Something happened",
		type: "neutral",
		...overrides,
	};
}

function makeBriefing(overrides?: Partial<BriefingOutput>): BriefingOutput {
	return {
		greeting: "Good morning, Mat",
		date: "Tuesday, June 2, 2026",
		lede: "Two things need your attention.",
		sections: [],
		state: "normal",
		generated_at: "2026-06-02T16:00:00.000Z",
		cached: false,
		...overrides,
	};
}

describe("renderBriefingText", () => {
	// The core regression: the briefing body must land in the rendered text, not
	// only in structuredContent. The model only ever sees this string.
	test("renders the section body text the model needs", () => {
		const out = renderBriefingText(
			makeBriefing({
				sections: [
					section({ category: "attention", type: "warning", text: "Invoice #42 is overdue" }),
					section({ category: "recent", type: "positive", text: "Deploy succeeded" }),
				],
			}),
		);
		expect(out).toContain("Invoice #42 is overdue");
		expect(out).toContain("Deploy succeeded");
	});

	test("includes greeting and lede", () => {
		const out = renderBriefingText(makeBriefing());
		expect(out).toContain("Good morning, Mat");
		expect(out).toContain("Two things need your attention.");
	});

	// Guards the schema category names (home.ts: attention/recent/upcoming).
	// A renderer keyed on the inline script's stale names (needs_attention/
	// coming_up) would silently drop every section — the failure mode this fix
	// exists to prevent.
	test("groups sections under labels using the schema category names", () => {
		const out = renderBriefingText(
			makeBriefing({
				sections: [
					section({ category: "upcoming", text: "Renewal due Friday" }),
					section({ category: "attention", text: "API key expiring" }),
					section({ category: "recent", text: "3 new conversations" }),
				],
			}),
		);
		expect(out).toContain("## Needs attention");
		expect(out).toContain("## Recent");
		expect(out).toContain("## Coming up");
		// attention surfaces before recent, which surfaces before upcoming
		expect(out.indexOf("## Needs attention")).toBeLessThan(out.indexOf("## Recent"));
		expect(out.indexOf("## Recent")).toBeLessThan(out.indexOf("## Coming up"));
	});

	test("omits headings for empty categories", () => {
		const out = renderBriefingText(
			makeBriefing({ sections: [section({ category: "recent", text: "Only recent activity" })] }),
		);
		expect(out).toContain("## Recent");
		expect(out).not.toContain("## Needs attention");
		expect(out).not.toContain("## Coming up");
	});

	test("renders a quiet briefing as greeting + lede with no headings", () => {
		const out = renderBriefingText(makeBriefing({ sections: [], lede: "All clear." }));
		expect(out).toContain("Good morning, Mat");
		expect(out).toContain("All clear.");
		expect(out).not.toContain("##");
	});
});
