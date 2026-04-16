import { describe, expect, it } from "bun:test";
import { BROWSER_HTML } from "../../../../src/bundles/conversations/src/ui/browser.ts";

describe("Conversations browser resource", () => {
	it("exports BROWSER_HTML as a non-empty string", () => {
		expect(typeof BROWSER_HTML).toBe("string");
		expect(BROWSER_HTML.length).toBeGreaterThan(100);
	});

	it("is a valid HTML document", () => {
		expect(BROWSER_HTML).toContain("<!DOCTYPE html>");
		expect(BROWSER_HTML).toContain("<html");
		expect(BROWSER_HTML).toContain("</html>");
		expect(BROWSER_HTML).toContain("<head");
		expect(BROWSER_HTML).toContain("<body");
	});

	it("contains the postMessage bridge code", () => {
		expect(BROWSER_HTML).toContain("callTool");
		expect(BROWSER_HTML).toContain("postMessage");
		expect(BROWSER_HTML).toContain("jsonrpc");
		expect(BROWSER_HTML).toContain("tools/call");
	});

	it("references tool names without prefix (McpSource adds prefix)", () => {
		// Tool names are bare (list, search) — McpSource prefixes them with conversations__
		expect(BROWSER_HTML).toContain('"list"');
		expect(BROWSER_HTML).toContain('"search"');
		expect(BROWSER_HTML).not.toContain("nb__list_conversations");
		expect(BROWSER_HTML).not.toContain("nb__conversation_history");
	});

	it("uses ext-apps spec CSS variables for theming", () => {
		expect(BROWSER_HTML).toContain("--color-background-primary");
		expect(BROWSER_HTML).toContain("--color-text-primary");
		expect(BROWSER_HTML).toContain("--font-sans");
	});

	it("has no external resource references", () => {
		// No CDN links, no external stylesheets, no external scripts
		expect(BROWSER_HTML).not.toMatch(/https?:\/\/cdn\./);
		expect(BROWSER_HTML).not.toMatch(/<link[^>]+href="https?:/);
		expect(BROWSER_HTML).not.toMatch(/<script[^>]+src="https?:/);
	});

	it("includes Resume in Chat via semantic action", () => {
		expect(BROWSER_HTML).toContain("synapse/action");
		expect(BROWSER_HTML).toContain("openConversation");
	});

	it("includes datachanged listener", () => {
		expect(BROWSER_HTML).toContain("data-changed");
	});

	it("includes parseResult helper", () => {
		expect(BROWSER_HTML).toContain("parseResult");
	});
});
