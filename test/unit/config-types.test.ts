import { describe, expect, it } from "bun:test";
import { getValidator } from "../../src/config/index.ts";
import type { BundleState, AppInfo, HostManifestMeta, BundleUiMeta } from "../../src/bundles/types.ts";
import type { AgentProfile, RuntimeConfig } from "../../src/runtime/types.ts";
import type { EngineEventType } from "../../src/engine/types.ts";

describe("JSON Schema validation", () => {
	const validate = getValidator();

	function isValid(config: Record<string, unknown>): boolean {
		return validate(config) as boolean;
	}

	it("accepts config with no new fields (backward compatible)", () => {
		expect(isValid({})).toBe(true);
	});

	it("accepts bundles in config", () => {
		// bundles is a valid top-level config field
		expect(isValid({ bundles: [] })).toBe(true);
		expect(isValid({ bundles: [{ name: "@test/echo" }] })).toBe(true);
		expect(isValid({ bundles: [{ url: "https://example.com/mcp" }] })).toBe(true);
	});

	it("rejects workspace-owned fields (agents, skillDirs, etc.)", () => {
		// These fields are not part of nimblebrain.json schema
		expect(isValid({ agents: {} })).toBe(false);
		expect(isValid({ skillDirs: [] })).toBe(false);
		expect(isValid({ skills: [] })).toBe(false);
		expect(isValid({ noDefaultBundles: true })).toBe(false);
		expect(isValid({ home: { enabled: true } })).toBe(false);
		expect(isValid({ preferences: { displayName: "Test" } })).toBe(false);
	});

	it("accepts http config with port and host", () => {
		expect(isValid({ http: { port: 8080, host: "0.0.0.0" } })).toBe(true);
	});

	it("accepts http config with port only", () => {
		expect(isValid({ http: { port: 3000 } })).toBe(true);
	});

	it("accepts http config with no fields (all optional)", () => {
		expect(isValid({ http: {} })).toBe(true);
	});

	it("rejects negative port", () => {
		expect(isValid({ http: { port: -1 } })).toBe(false);
	});

	it("rejects port above 65535", () => {
		expect(isValid({ http: { port: 70000 } })).toBe(false);
	});

	it("accepts features config", () => {
		expect(
			isValid({
				features: {
					bundleManagement: true,
					delegation: false,
				},
			}),
		).toBe(true);
	});
});

describe("BundleState type", () => {
	it("covers all 5 states", () => {
		const states: BundleState[] = ["starting", "running", "crashed", "dead", "stopped"];
		expect(states).toHaveLength(5);
		// Verify uniqueness
		expect(new Set(states).size).toBe(5);
	});
});

describe("AgentProfile type", () => {
	it("has correct required and optional fields", () => {
		// Required fields only
		const minimal: AgentProfile = {
			description: "test",
			systemPrompt: "test prompt",
			tools: ["*"],
		};
		expect(minimal.description).toBe("test");
		expect(minimal.maxIterations).toBeUndefined();
		expect(minimal.model).toBeUndefined();

		// All fields
		const full: AgentProfile = {
			description: "test",
			systemPrompt: "test prompt",
			tools: ["rfpsearch__*"],
			maxIterations: 5,
			model: "claude-sonnet-4-5-20250929",
		};
		expect(full.maxIterations).toBe(5);
		expect(full.model).toBe("claude-sonnet-4-5-20250929");
	});
});

describe("EngineEventType", () => {
	it("includes all new event types", () => {
		const newEvents: EngineEventType[] = [
			"bundle.installed",
			"bundle.uninstalled",
			"bundle.crashed",
			"bundle.recovered",
			"bundle.dead",
			"data.changed",
			"tool.progress",
		];
		// These are compile-time checked — if any is not in the union, TypeScript errors.
		// At runtime, just verify they are all strings.
		for (const evt of newEvents) {
			expect(typeof evt).toBe("string");
		}
		expect(newEvents).toHaveLength(7);
	});

	it("includes all original event types", () => {
		const origEvents: EngineEventType[] = [
			"run.start",
			"text.delta",
			"tool.start",
			"tool.done",
			"llm.done",
			"run.done",
			"run.error",
		];
		for (const evt of origEvents) {
			expect(typeof evt).toBe("string");
		}
	});
});

describe("AppInfo type", () => {
	it("matches the GET /v1/apps response shape", () => {
		const app: AppInfo = {
			name: "tasks",
			bundleName: "@nimblebraininc/tasks",
			version: "1.2.0",
			status: "running",
			type: "upjack",
			toolCount: 12,
			trustScore: 92,
			ui: {
				name: "Tasks",
				icon: "✓",
				primaryView: { resourceUri: "ui://tasks/board" },
			},
		};
		expect(app.name).toBe("tasks");
		expect(app.status).toBe("running");
		expect(app.ui?.primaryView?.resourceUri).toBe("ui://tasks/board");
	});

	it("supports null ui for apps without a frontend", () => {
		const app: AppInfo = {
			name: "weather",
			bundleName: "@nimblebraininc/weather",
			version: "0.3.0",
			status: "running",
			type: "plain",
			toolCount: 3,
			trustScore: 78,
			ui: null,
		};
		expect(app.ui).toBeNull();
	});
});

describe("HostManifestMeta type", () => {
	it("matches manifest _meta structure", () => {
		const meta: HostManifestMeta = {
			host_version: "1.0",
			name: "Tasks",
			icon: "✓",
			primaryView: { resourceUri: "ui://tasks/board" },
		};
		expect(meta.name).toBe("Tasks");
		expect(meta.primaryView?.resourceUri).toBe("ui://tasks/board");
	});
});
