import { describe, expect, it } from "bun:test";
import {
	APP_NAV_STYLES,
	BASE_STYLES,
	CONVERSATIONS_STYLES,
	MODEL_SELECTOR_STYLES,
	SETTINGS_LINK_STYLES,
	SETTINGS_STYLES,
	USAGE_BAR_STYLES,
	USAGE_DASHBOARD_STYLES,
} from "../../../src/tools/core-resources/styles.ts";

describe("core-resources styles use CSS variables", () => {
	it("BASE_STYLES uses --color-background-primary (not bare #fafafa)", () => {
		expect(BASE_STYLES).toContain("var(--color-background-primary");
		expect(BASE_STYLES).not.toMatch(/background:\s*#fafafa/);
	});

	it("BASE_STYLES uses --color-text-primary (not bare #18181b)", () => {
		expect(BASE_STYLES).toContain("var(--color-text-primary");
		expect(BASE_STYLES).not.toMatch(/color:\s*#18181b/);
	});

	it("BASE_STYLES uses --font-sans (not bare -apple-system)", () => {
		expect(BASE_STYLES).toContain("var(--font-sans");
		expect(BASE_STYLES).not.toMatch(/font-family:\s*-apple-system/);
	});

	it("all style constants have balanced parentheses", () => {
		const styles = [
			BASE_STYLES,
			CONVERSATIONS_STYLES,
			APP_NAV_STYLES,
			SETTINGS_LINK_STYLES,
			USAGE_BAR_STYLES,
			USAGE_DASHBOARD_STYLES,
			SETTINGS_STYLES,
			MODEL_SELECTOR_STYLES,
		];
		for (const css of styles) {
			const opens = (css.match(/\(/g) || []).length;
			const closes = (css.match(/\)/g) || []).length;
			expect(opens).toBe(closes);
		}
	});

	it("no bare hex colors outside var() fallbacks in migrated constants", () => {
		// Match hex colors that are NOT inside a var() fallback or rgba()
		// Strategy: strip all var(...) and rgba(...) blocks, then check for remaining hex colors
		const styles = [
			BASE_STYLES,
			CONVERSATIONS_STYLES,
			APP_NAV_STYLES,
			SETTINGS_LINK_STYLES,
			USAGE_BAR_STYLES,
			USAGE_DASHBOARD_STYLES,
			MODEL_SELECTOR_STYLES,
		];
		for (const css of styles) {
			// Remove var(...) expressions (including nested parens for rgba fallbacks)
			const stripped = css.replace(/var\([^)]*(?:\([^)]*\)[^)]*)*\)/g, "");
			// Remove rgba(...) expressions
			const noRgba = stripped.replace(/rgba?\([^)]*\)/g, "");
			// Should have no remaining hex colors
			const remaining = noRgba.match(/#[0-9a-fA-F]{3,8}\b/g);
			expect(remaining).toBeNull();
		}
	});

	it("SETTINGS_STYLES uses NB extension tokens for status colors", () => {
		expect(SETTINGS_STYLES).toContain("--nb-color-success");
		expect(SETTINGS_STYLES).toContain("--nb-color-danger");
		expect(SETTINGS_STYLES).toContain("color-mix(");
	});
});
