import { describe, expect, it } from "bun:test";
import { getCoreResource } from "../../src/tools/core-resources/index.ts";

describe("getCoreResource", () => {
	const ALL_RESOURCES = [
		"conversations",
		"app-nav",
		"settings-link",
		"usage-bar",
		"usage-dashboard",
		"settings",
		"model-selector",
	] as const;

	it("returns null for unknown resource", () => {
		expect(getCoreResource("unknown")).toBeNull();
		expect(getCoreResource("")).toBeNull();
		expect(getCoreResource("does-not-exist")).toBeNull();
	});

	for (const name of ALL_RESOURCES) {
		it(`"${name}" returns an HTML string containing <!DOCTYPE html>`, () => {
			const html = getCoreResource(name);
			expect(html).not.toBeNull();
			expect(typeof html).toBe("string");
			expect(html!).toContain("<!DOCTYPE html>");
		});
	}

	it("conversations contains postMessage bridge code", () => {
		const html = getCoreResource("conversations")!;
		expect(html).toContain("postMessage");
		expect(html).toContain("tools/call");
	});

	it("app-nav contains postMessage bridge code", () => {
		const html = getCoreResource("app-nav")!;
		expect(html).toContain("postMessage");
		expect(html).toContain("tools/call");
	});

	it("conversations includes search input", () => {
		const html = getCoreResource("conversations")!;
		expect(html).toContain('id="search"');
		expect(html).toContain("Search conversations");
	});

	it("usage-dashboard includes period selector", () => {
		const html = getCoreResource("usage-dashboard")!;
		expect(html).toContain('id="period"');
		expect(html).toContain("Last 7 days");
		expect(html).toContain("This month");
	});

	it("all resources are self-contained (no external script/link tags)", () => {
		for (const name of ALL_RESOURCES) {
			const html = getCoreResource(name)!;
			expect(html).not.toMatch(/<script\s+src=/);
			expect(html).not.toMatch(/<link\s+.*href=.*\.css/);
		}
	});

	it("settings-link navigates to /app/settings", () => {
		const html = getCoreResource("settings-link")!;
		expect(html).toContain("/app/settings");
	});

	it("model-selector contains model input", () => {
		const html = getCoreResource("model-selector")!;
		expect(html).toContain("model-input");
		expect(html).toContain("set_model_config");
	});

	it("settings resource contains the bridge preamble", () => {
		const html = getCoreResource("settings")!;
		expect(html).toContain("Synapse");
		expect(html).toContain("callTool");
	});

	it("settings resource calls settings_manifest on load", () => {
		const html = getCoreResource("settings")!;
		expect(html).toContain('callTool("settings_manifest"');
	});

	it("settings resource contains a tab container element", () => {
		const html = getCoreResource("settings")!;
		expect(html).toContain('id="tab-bar"');
	});

	it("settings resource contains a content container element", () => {
		const html = getCoreResource("settings")!;
		expect(html).toContain('id="content"');
	});
});
