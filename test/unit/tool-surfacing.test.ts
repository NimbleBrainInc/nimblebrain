import { describe, expect, it } from "bun:test";
import { DEFAULT_MAX_DIRECT_TOOLS } from "../../src/limits.ts";
import { surfaceTools } from "../../src/runtime/tools.ts";
import { composeSystemPrompt } from "../../src/prompt/compose.ts";
import type { PromptAppInfo } from "../../src/prompt/compose.ts";
import type { ToolSchema } from "../../src/engine/types.ts";
import type { Skill } from "../../src/skills/types.ts";

// --- Helpers ---

function makeTool(name: string): ToolSchema {
	return { name, description: `${name} tool`, inputSchema: { type: "object", properties: {} } };
}

function makeSystemTools(count = 4): ToolSchema[] {
	const names = ["nb__search", "nb__manage_app", "nb__status", "nb__set_preferences"];
	return names.slice(0, count).map(makeTool);
}

function makeAppTools(prefix: string, count: number): ToolSchema[] {
	return Array.from({ length: count }, (_, i) => makeTool(`${prefix}__tool_${i}`));
}

function makeSkill(opts: { allowedTools?: string[] } = {}): Skill {
	return {
		manifest: {
			name: "test-skill",
			description: "Test",
			version: "1.0.0",
			type: "skill",
			priority: 50,
			allowedTools: opts.allowedTools,
			metadata: { keywords: ["test"], triggers: [] },
		},
		body: "You are a test expert.",
		sourcePath: "/test/skill.md",
	};
}

// --- surfaceTools tests ---

describe("surfaceTools", () => {
	it("Tier 1: 10 total tools — all surfaced directly, nothing proxied", () => {
		const system = makeSystemTools();
		const app = makeAppTools("tasks", 6);
		const all = [...system, ...app];

		const result = surfaceTools(all, null);

		expect(result.direct).toHaveLength(10);
		expect(result.proxied).toHaveLength(0);
	});

	it("Tier 1: exactly maxDirectTools — all surfaced directly", () => {
		const system = makeSystemTools();
		const app = makeAppTools("tasks", 26);
		const all = [...system, ...app];

		const result = surfaceTools(all, null, { maxDirectTools: DEFAULT_MAX_DIRECT_TOOLS });

		expect(result.direct).toHaveLength(DEFAULT_MAX_DIRECT_TOOLS);
		expect(result.proxied).toHaveLength(0);
	});

	it("Tier 2: 50 total tools, no skill — only nb__* direct, rest proxied", () => {
		const system = makeSystemTools(4);
		const appA = makeAppTools("tasks", 23);
		const appB = makeAppTools("weather", 23);
		const all = [...system, ...appA, ...appB];

		expect(all).toHaveLength(50);

		const result = surfaceTools(all, null);

		expect(result.direct).toHaveLength(4);
		expect(result.proxied).toHaveLength(46);
		for (const t of result.direct) {
			expect(t.name.startsWith("nb__")).toBe(true);
		}
		for (const t of result.proxied) {
			expect(t.name.startsWith("nb__")).toBe(false);
		}
	});

	it("Tier 2: skill matched but has no allowedTools — falls through to Tier 2", () => {
		const system = makeSystemTools(4);
		const app = makeAppTools("tasks", 30);
		const all = [...system, ...app];
		const skill = makeSkill(); // no allowedTools

		const result = surfaceTools(all, skill);

		expect(result.direct).toHaveLength(4);
		expect(result.proxied).toHaveLength(30);
	});

	it("Tier 3: skill with allowed-tools glob — matching + system direct", () => {
		const system = makeSystemTools(4);
		const tasks = makeAppTools("tasks", 10);
		const weather = makeAppTools("weather", 10);
		const crm = makeAppTools("crm", 10);
		const all = [...system, ...tasks, ...weather, ...crm];
		const skill = makeSkill({ allowedTools: ["tasks__*"] });

		const result = surfaceTools(all, skill);

		// 4 system + 10 tasks = 14 direct
		expect(result.direct).toHaveLength(14);
		// 10 weather + 10 crm = 20 proxied
		expect(result.proxied).toHaveLength(20);

		const directNames = result.direct.map((t) => t.name);
		for (const t of tasks) {
			expect(directNames).toContain(t.name);
		}
		for (const t of system) {
			expect(directNames).toContain(t.name);
		}
	});

	it("Tier 3: skill with multiple allowed-tools globs", () => {
		const system = makeSystemTools(4);
		const tasks = makeAppTools("tasks", 5);
		const weather = makeAppTools("weather", 5);
		const crm = makeAppTools("crm", 5);
		const all = [...system, ...tasks, ...weather, ...crm];
		const skill = makeSkill({ allowedTools: ["tasks__*", "crm__*"] });

		const result = surfaceTools(all, skill);

		// 4 system + 5 tasks + 5 crm = 14 direct
		expect(result.direct).toHaveLength(14);
		expect(result.proxied).toHaveLength(5); // only weather
	});

	it("Tier 3: skill with exact tool name in allowedTools", () => {
		const system = makeSystemTools(4);
		const tasks = makeAppTools("tasks", 5);
		const all = [...system, ...tasks];
		const skill = makeSkill({ allowedTools: ["tasks__tool_0"] });

		const result = surfaceTools(all, skill);

		// 4 system + 1 exact match = 5 direct
		expect(result.direct).toHaveLength(5);
		expect(result.proxied).toHaveLength(4);
	});

	it("custom maxDirectTools threshold", () => {
		const system = makeSystemTools(4);
		const app = makeAppTools("tasks", 7);
		const all = [...system, ...app];

		// 11 total tools, max 10 → Tier 2
		const result = surfaceTools(all, null, { maxDirectTools: 10 });

		expect(result.direct).toHaveLength(4);
		expect(result.proxied).toHaveLength(7);
	});

	it("direct and proxied are mutually exclusive and cover all tools", () => {
		const system = makeSystemTools(4);
		const app = makeAppTools("tasks", 40);
		const all = [...system, ...app];

		const result = surfaceTools(all, null);

		const combined = [...result.direct, ...result.proxied];
		expect(combined).toHaveLength(all.length);

		const directSet = new Set(result.direct.map((t) => t.name));
		for (const t of result.proxied) {
			expect(directSet.has(t.name)).toBe(false);
		}
	});
});

// --- focusedServerName promotion tests ---

describe("surfaceTools — focusedServerName", () => {
	it("Tier 2: focused app's tools promoted to direct, others remain proxied", () => {
		const system = makeSystemTools(4);
		const tasks = makeAppTools("tasks", 20);
		const weather = makeAppTools("weather", 20);
		const all = [...system, ...tasks, ...weather];

		expect(all).toHaveLength(44);

		const result = surfaceTools(all, null, { focusedServerName: "tasks" });

		// 4 system + 20 tasks promoted = 24 direct
		expect(result.direct).toHaveLength(24);
		// 20 weather remain proxied
		expect(result.proxied).toHaveLength(20);

		const directNames = new Set(result.direct.map((t) => t.name));
		for (const t of tasks) {
			expect(directNames.has(t.name)).toBe(true);
		}
		for (const t of system) {
			expect(directNames.has(t.name)).toBe(true);
		}
		for (const t of weather) {
			expect(directNames.has(t.name)).toBe(false);
		}
	});

	it("Tier 3: focused app's tools in direct even if not in skill globs", () => {
		const system = makeSystemTools(4);
		const tasks = makeAppTools("tasks", 10);
		const weather = makeAppTools("weather", 10);
		const crm = makeAppTools("crm", 10);
		const all = [...system, ...tasks, ...weather, ...crm];
		const skill = makeSkill({ allowedTools: ["tasks__*"] });

		const result = surfaceTools(all, skill, { focusedServerName: "crm" });

		// 4 system + 10 tasks (skill) + 10 crm (focused) = 24 direct
		expect(result.direct).toHaveLength(24);
		// 10 weather proxied
		expect(result.proxied).toHaveLength(10);

		const directNames = new Set(result.direct.map((t) => t.name));
		for (const t of crm) {
			expect(directNames.has(t.name)).toBe(true);
		}
		for (const t of tasks) {
			expect(directNames.has(t.name)).toBe(true);
		}
		for (const t of weather) {
			expect(directNames.has(t.name)).toBe(false);
		}
	});

	it("Tier 1: no change when all tools already direct", () => {
		const system = makeSystemTools(4);
		const app = makeAppTools("tasks", 6);
		const all = [...system, ...app];

		const result = surfaceTools(all, null, { focusedServerName: "tasks" });

		expect(result.direct).toHaveLength(10);
		expect(result.proxied).toHaveLength(0);
	});

	it("without focusedServerName: existing tier behavior unchanged", () => {
		const system = makeSystemTools(4);
		const tasks = makeAppTools("tasks", 20);
		const weather = makeAppTools("weather", 20);
		const all = [...system, ...tasks, ...weather];

		const result = surfaceTools(all, null);

		// Tier 2: only system tools direct
		expect(result.direct).toHaveLength(4);
		expect(result.proxied).toHaveLength(40);
	});

	it("nb__* tools always in direct regardless of focused app", () => {
		const system = makeSystemTools(4);
		const tasks = makeAppTools("tasks", 20);
		const weather = makeAppTools("weather", 20);
		const all = [...system, ...tasks, ...weather];

		const result = surfaceTools(all, null, { focusedServerName: "weather" });

		const directNames = new Set(result.direct.map((t) => t.name));
		for (const t of system) {
			expect(directNames.has(t.name)).toBe(true);
		}
	});
});

// --- composeSystemPrompt apps injection tests ---

describe("composeSystemPrompt — apps injection", () => {
	const apps: PromptAppInfo[] = [
		{ name: "Tasks", trustScore: 92, ui: { name: "Tasks", primaryView: "Task Board" } },
		{ name: "Weather", trustScore: 78, ui: null },
	];

	it("injects Installed Apps section with correct names, UI status, and trust scores", () => {
		const result = composeSystemPrompt([], null, apps);

		expect(result).toContain("## Installed Apps");
		expect(result).toContain("- Tasks (has UI: Tasks) — MTF Score: 92");
		expect(result).toContain("- Weather (no UI) — MTF Score: 78");
	});

	it("includes sidebar instruction when apps have UI", () => {
		const result = composeSystemPrompt([], null, apps);

		expect(result).toContain(
			"When you create or modify data in apps that have a UI, mention that the user can view the result in the sidebar.",
		);
	});

	it("no apps section injected when apps list is empty", () => {
		const result = composeSystemPrompt([], null, []);

		expect(result).not.toContain("## Installed Apps");
		expect(result).not.toContain("MTF Score");
	});

	it("no apps section injected when apps parameter is undefined", () => {
		const result = composeSystemPrompt([]);

		expect(result).not.toContain("## Installed Apps");
	});

	it("apps section placed between context skills and matched skill", () => {
		const ctx: Skill = {
			manifest: { name: "soul", description: "", version: "1.0.0", type: "context", priority: 0 },
			body: "I am the identity layer.",
			sourcePath: "/test/soul.md",
		};
		const skill: Skill = {
			manifest: {
				name: "test",
				description: "",
				version: "1.0.0",
				type: "skill",
				priority: 50,
				metadata: { keywords: [], triggers: [] },
			},
			body: "Skill instructions here.",
			sourcePath: "/test/skill.md",
		};

		const result = composeSystemPrompt([ctx], skill, apps);

		const identityIdx = result.indexOf("I am the identity layer.");
		const appsIdx = result.indexOf("## Installed Apps");
		const skillIdx = result.indexOf("Skill instructions here.");

		expect(identityIdx).toBeGreaterThanOrEqual(0);
		expect(appsIdx).toBeGreaterThan(identityIdx);
		expect(skillIdx).toBeGreaterThan(appsIdx);
	});

	it("UI with no primaryView falls back to app name", () => {
		const appWithUiNoPrimaryView: PromptAppInfo[] = [
			{ name: "CRM", trustScore: 87, ui: { name: "Contact Manager" } },
		];

		const result = composeSystemPrompt([], null, appWithUiNoPrimaryView);

		expect(result).toContain("- CRM (has UI: Contact Manager) — MTF Score: 87");
	});
});

describe("surfaceTools — internal annotation filtering", () => {
	it("excludes tools with ai.nimblebrain/internal annotation from direct tools", () => {
		const internalTool: ToolSchema = {
			name: "nb__manage_identity",
			description: "Internal identity tool",
			inputSchema: { type: "object", properties: {} },
			annotations: { "ai.nimblebrain/internal": true },
		};
		const visibleTool = makeTool("nb__search");
		const all = [internalTool, visibleTool];

		const result = surfaceTools(all, null);

		const directNames = result.direct.map((t) => t.name);
		expect(directNames).not.toContain("nb__manage_identity");
		expect(directNames).toContain("nb__search");
	});

	it("excludes internal tools even when total is under maxDirectTools", () => {
		const internalTool: ToolSchema = {
			name: "nb__get_config",
			description: "Internal config",
			inputSchema: { type: "object", properties: {} },
			annotations: { "ai.nimblebrain/internal": true },
		};
		const tools = [...makeSystemTools(4), internalTool];

		const result = surfaceTools(tools, null);

		expect(result.direct).toHaveLength(4); // internal excluded
		expect(result.proxied).toHaveLength(0); // internal not proxied either
	});
});
