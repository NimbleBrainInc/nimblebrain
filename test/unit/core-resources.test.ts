import { describe, expect, it } from "bun:test";
import { buildCoreResourceMap } from "../../src/tools/core-resources/index.ts";

const RESOURCES = buildCoreResourceMap();

const ALL_NAMES = [
	"conversations",
	"app-nav",
	"settings-link",
	"usage-bar",
	"usage-dashboard",
	"settings",
	"model-selector",
] as const;

function get(name: string): string | undefined {
	return RESOURCES.get(`ui://nb/${name}`);
}

describe("buildCoreResourceMap", () => {
	it("does not include unknown resources", () => {
		expect(RESOURCES.has("ui://nb/unknown")).toBe(false);
		expect(RESOURCES.has("")).toBe(false);
		expect(RESOURCES.has("ui://nb/does-not-exist")).toBe(false);
	});

	for (const name of ALL_NAMES) {
		it(`"${name}" maps to an HTML string containing <!DOCTYPE html>`, () => {
			const html = get(name);
			expect(html).toBeDefined();
			expect(typeof html).toBe("string");
			expect(html!).toContain("<!DOCTYPE html>");
		});
	}

	it("conversations contains postMessage bridge code", () => {
		const html = get("conversations")!;
		expect(html).toContain("postMessage");
		expect(html).toContain("tools/call");
	});

	it("app-nav contains postMessage bridge code", () => {
		const html = get("app-nav")!;
		expect(html).toContain("postMessage");
		expect(html).toContain("tools/call");
	});

	it("conversations includes search input", () => {
		const html = get("conversations")!;
		expect(html).toContain('id="search"');
		expect(html).toContain("Search conversations");
	});

	it("usage-dashboard includes period selector", () => {
		const html = get("usage-dashboard")!;
		expect(html).toContain('id="period"');
		expect(html).toContain("Last 7 days");
		expect(html).toContain("This month");
	});

	it("all resources are self-contained (no external script/link tags)", () => {
		for (const name of ALL_NAMES) {
			const html = get(name)!;
			expect(html).not.toMatch(/<script\s+src=/);
			expect(html).not.toMatch(/<link\s+.*href=.*\.css/);
		}
	});

	it("settings-link navigates to /app/settings", () => {
		const html = get("settings-link")!;
		expect(html).toContain("/app/settings");
	});

	it("model-selector contains model input", () => {
		const html = get("model-selector")!;
		expect(html).toContain("model-input");
		expect(html).toContain("set_model_config");
	});

	it("settings resource contains the bridge preamble", () => {
		const html = get("settings")!;
		expect(html).toContain("Synapse");
		expect(html).toContain("callTool");
	});

	it("settings resource calls settings_manifest on load", () => {
		const html = get("settings")!;
		expect(html).toContain('callTool("settings_manifest"');
	});

	it("settings resource contains a tab container element", () => {
		const html = get("settings")!;
		expect(html).toContain('id="tab-bar"');
	});

	it("settings resource contains a content container element", () => {
		const html = get("settings")!;
		expect(html).toContain('id="content"');
	});
});
