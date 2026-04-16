import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { extractText } from "../../src/engine/content-helpers.ts";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSystemTools } from "../../src/tools/system-tools.ts";
import type { GetSkillsFn } from "../../src/tools/system-tools.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { InlineSource } from "../../src/tools/inline-source.ts";
import type { Skill } from "../../src/skills/types.ts";
import {
	createPrivilegeHook,
	NoopConfirmationGate,
} from "../../src/config/privilege.ts";
import type { ConfirmationGate } from "../../src/config/privilege.ts";
import { readSkill } from "../../src/skills/writer.ts";

const noopSink = new NoopEventSink();

function makeRegistry(): ToolRegistry {
	const registry = new ToolRegistry();
	const source = new InlineSource("test", [
		{
			name: "greet",
			description: "Say hello to someone",
			inputSchema: {
				type: "object",
				properties: { name: { type: "string" } },
			},
			handler: async (input) => ({
				content: `Hello ${input.name}!`,
				isError: false,
			}),
		},
		{
			name: "farewell",
			description: "Say goodbye to someone",
			inputSchema: {
				type: "object",
				properties: { name: { type: "string" } },
			},
			handler: async (input) => ({
				content: `Goodbye ${input.name}!`,
				isError: false,
			}),
		},
	]);
	registry.addSource(source);
	return registry;
}

describe("System Tools", () => {
	it("search with scope=tools returns matching tools by substring", async () => {
		const registry = makeRegistry();
		const systemTools = createSystemTools(() => registry);
		const result = await systemTools.execute("search", {
			scope: "tools",
			query: "hello",
		});
		expect(result.isError).toBe(false);
		expect(extractText(result.content)).toContain("test__greet");
	});

	it("search with scope=tools and empty query returns all tools grouped", async () => {
		const registry = makeRegistry();
		const systemTools = createSystemTools(() => registry);
		const result = await systemTools.execute("search", { scope: "tools", query: "" });
		expect(result.isError).toBe(false);
		expect(extractText(result.content)).toContain("test");
		expect(extractText(result.content)).toContain("2 tools");
	});

	it("search with scope=tools returns no-match message", async () => {
		const registry = makeRegistry();
		const systemTools = createSystemTools(() => registry);
		const result = await systemTools.execute("search", {
			scope: "tools",
			query: "nonexistent",
		});
		expect(result.isError).toBe(false);
		expect(extractText(result.content)).toContain('No tools matched "nonexistent"');
	});

	it("search with scope=registry searches mpak registry", async () => {
		const registry = makeRegistry();
		const systemTools = createSystemTools(() => registry);
		const result = await systemTools.execute("search", {
			scope: "registry",
			query: "ipinfo",
		});
		expect(result.isError).toBe(false);
		// Should contain actual search results (mpak must be installed)
		expect(extractText(result.content)).toContain("ipinfo");
	}, 15_000);

	it("manage_app install requires lifecycle context", async () => {
		const registry = makeRegistry();
		const systemTools = createSystemTools(() => registry);
		const result = await systemTools.execute("manage_app", {
			action: "install",
			name: "@test/nonexistent-bundle-xyz",
		});
		expect(result.isError).toBe(true);
		expect(extractText(result.content)).toContain("lifecycle context");
	}, 15_000);

	it("manage_app uninstall requires lifecycle context", async () => {
		const registry = makeRegistry();
		const systemTools = createSystemTools(() => registry);
		const result = await systemTools.execute("manage_app", {
			action: "uninstall",
			name: "nonexistent",
		});
		expect(result.isError).toBe(true);
		expect(extractText(result.content)).toContain("lifecycle context");
	});

	it("tools() returns prefixed tool names", async () => {
		const registry = makeRegistry();
		const systemTools = createSystemTools(() => registry);
		const tools = await systemTools.tools();
		const names = tools.map((t) => t.name);
		expect(names).toContain("nb__search");
		expect(names).toContain("nb__manage_app");
	});
});

describe("ConfirmationGate", () => {
	it("NoopConfirmationGate always approves", async () => {
		const gate = new NoopConfirmationGate();
		expect(await gate.confirm("test?", {})).toBe(true);
		expect(gate.supportsInteraction).toBe(false);
	});

	it("privilege hook passes through non-privileged tools", async () => {
		const gate = new NoopConfirmationGate();
		const hook = createPrivilegeHook(gate, noopSink);
		const call = { id: "1", name: "test__greet", input: {} };
		const result = await hook(call);
		expect(result).toEqual(call);
	});

	it("privilege hook gates privileged tools — deny", async () => {
		const gate: ConfirmationGate = {
			supportsInteraction: true,
			confirm: async () => false,
		};
		const hook = createPrivilegeHook(gate, noopSink);
		const call = {
			id: "1",
			name: "nb__manage_app",
			input: { action: "install", name: "@test/bundle" },
		};
		const result = await hook(call);
		expect(result).toBeNull();
	});

	it("privilege hook allows approved privileged tools", async () => {
		const gate: ConfirmationGate = {
			supportsInteraction: true,
			confirm: async () => true,
		};
		const hook = createPrivilegeHook(gate, noopSink);
		const call = {
			id: "1",
			name: "nb__manage_app",
			input: { action: "install", name: "@test/bundle" },
		};
		const result = await hook(call);
		expect(result).toEqual(call);
	});
});

describe("manage_skill tool", () => {
	let skillDir: string;
	let reloadCalled: boolean;
	const noopReload = async () => {
		reloadCalled = true;
	};
	const approveGate: ConfirmationGate = {
		supportsInteraction: true,
		confirm: async () => true,
		promptConfigValue: async () => null,
	};
	const denyGate: ConfirmationGate = {
		supportsInteraction: true,
		confirm: async () => false,
		promptConfigValue: async () => null,
	};

	beforeEach(() => {
		skillDir = mkdtempSync(join(tmpdir(), "nb-manage-skill-"));
		reloadCalled = false;
	});

	afterEach(() => {
		rmSync(skillDir, { recursive: true, force: true });
	});

	function makeSource(gate?: ConfirmationGate) {
		const registry = makeRegistry();
		return createSystemTools(
			() => registry,
			undefined,
			gate,
			undefined,
			undefined,
			skillDir,
			noopReload,
		);
	}

	it("create writes a skill file and reloads", async () => {
		const source = makeSource(approveGate);
		const result = await source.execute("manage_skill", {
			action: "create",
			name: "my-helper",
			skill: {
				description: "A helper skill",
				type: "skill",
				priority: 50,
				body: "You are a helpful assistant.",
				triggers: ["help me"],
				keywords: ["help", "assist"],
			},
		});
		expect(result.isError).toBe(false);
		expect(extractText(result.content)).toContain("created successfully");
		expect(reloadCalled).toBe(true);

		const saved = readSkill(skillDir, "my-helper");
		expect(saved).not.toBeNull();
		expect(saved!.manifest.description).toBe("A helper skill");
		expect(saved!.manifest.priority).toBe(50);
		expect(saved!.body).toContain("You are a helpful assistant.");
	});

	it("create with priority 5 returns validation error", async () => {
		const source = makeSource(approveGate);
		const result = await source.execute("manage_skill", {
			action: "create",
			name: "bad-priority",
			skill: {
				description: "Bad priority",
				priority: 5,
				body: "test",
			},
		});
		expect(result.isError).toBe(true);
		// Schema-level validation at the InlineSource layer catches this before
		// the handler runs (schema declares minimum: 11).
		expect(extractText(result.content)).toContain("priority");
		expect(extractText(result.content)).toContain(">= 11");
	});

	it("create with reserved name returns error", async () => {
		const source = makeSource(approveGate);
		const result = await source.execute("manage_skill", {
			action: "create",
			name: "soul",
			skill: { description: "Hijack soul", body: "test" },
		});
		expect(result.isError).toBe(true);
		expect(extractText(result.content)).toContain("reserved");
	});

	it("create without name returns error", async () => {
		const source = makeSource(approveGate);
		const result = await source.execute("manage_skill", {
			action: "create",
			skill: { description: "No name" },
		});
		expect(result.isError).toBe(true);
		expect(extractText(result.content)).toContain("name is required");
	});

	it("create denied by gate returns error", async () => {
		const source = makeSource(denyGate);
		const result = await source.execute("manage_skill", {
			action: "create",
			name: "denied-skill",
			skill: { description: "Will be denied", body: "test" },
		});
		expect(result.isError).toBe(true);
		expect(extractText(result.content)).toContain("denied");
	});

	it("edit with partial update preserves unchanged fields", async () => {
		// First create a skill
		const source = makeSource(approveGate);
		await source.execute("manage_skill", {
			action: "create",
			name: "editable",
			skill: {
				description: "Original description",
				type: "skill",
				priority: 30,
				body: "Original body",
				keywords: ["original"],
			},
		});

		// Now edit just the description
		const result = await source.execute("manage_skill", {
			action: "edit",
			name: "editable",
			skill: { description: "Updated description" },
		});
		expect(result.isError).toBe(false);
		expect(extractText(result.content)).toContain("updated successfully");

		const saved = readSkill(skillDir, "editable");
		expect(saved).not.toBeNull();
		expect(saved!.manifest.description).toBe("Updated description");
		expect(saved!.manifest.priority).toBe(30);
		expect(saved!.body).toContain("Original body");
	});

	it("edit on non-existent skill returns error", async () => {
		const source = makeSource(approveGate);
		const result = await source.execute("manage_skill", {
			action: "edit",
			name: "ghost",
			skill: { description: "Does not exist" },
		});
		expect(result.isError).toBe(true);
		expect(extractText(result.content)).toContain("not found");
	});

	it("delete removes file and reloads", async () => {
		const source = makeSource(approveGate);
		await source.execute("manage_skill", {
			action: "create",
			name: "to-delete",
			skill: { description: "Will be deleted", body: "bye" },
		});
		reloadCalled = false;

		const result = await source.execute("manage_skill", {
			action: "delete",
			name: "to-delete",
		});
		expect(result.isError).toBe(false);
		expect(extractText(result.content)).toContain("deleted successfully");
		expect(reloadCalled).toBe(true);
		expect(existsSync(join(skillDir, "to-delete.md"))).toBe(false);
	});

	it("delete on non-existent skill returns error", async () => {
		const source = makeSource(approveGate);
		const result = await source.execute("manage_skill", {
			action: "delete",
			name: "ghost",
		});
		expect(result.isError).toBe(true);
		expect(extractText(result.content)).toContain("not found");
	});

	it("list returns all user skills", async () => {
		const source = makeSource(approveGate);
		await source.execute("manage_skill", {
			action: "create",
			name: "skill-a",
			skill: { description: "First skill", body: "a" },
		});
		await source.execute("manage_skill", {
			action: "create",
			name: "skill-b",
			skill: { description: "Second skill", body: "b" },
		});

		const result = await source.execute("manage_skill", {
			action: "list",
		});
		expect(result.isError).toBe(false);
		expect(extractText(result.content)).toContain("skill-a");
		expect(extractText(result.content)).toContain("skill-b");
		expect(extractText(result.content)).toContain("2 user skill(s)");
	});

	it("list returns empty message when no skills", async () => {
		const source = makeSource(approveGate);
		const result = await source.execute("manage_skill", {
			action: "list",
		});
		expect(result.isError).toBe(false);
		expect(extractText(result.content)).toContain("No user skills found");
	});

	it("show returns full skill content", async () => {
		const source = makeSource(approveGate);
		await source.execute("manage_skill", {
			action: "create",
			name: "showable",
			skill: {
				description: "A visible skill",
				priority: 42,
				body: "This is the full body.",
				triggers: ["show me"],
			},
		});

		const result = await source.execute("manage_skill", {
			action: "show",
			name: "showable",
		});
		expect(result.isError).toBe(false);
		expect(extractText(result.content)).toContain("showable");
		expect(extractText(result.content)).toContain("A visible skill");
		expect(extractText(result.content)).toContain("42");
		expect(extractText(result.content)).toContain("This is the full body.");
	});

	it("show on non-existent skill returns error", async () => {
		const source = makeSource(approveGate);
		const result = await source.execute("manage_skill", {
			action: "show",
			name: "ghost",
		});
		expect(result.isError).toBe(true);
		expect(extractText(result.content)).toContain("not found");
	});

	it("tool is registered as nb__manage_skill", async () => {
		const source = makeSource();
		const tools = await source.tools();
		const names = tools.map((t) => t.name);
		expect(names).toContain("nb__manage_skill");
	});
});

describe("status tool — scope: skills", () => {
	const coreSkill: Skill = {
		manifest: { name: "soul", description: "Identity", version: "1.0.0", type: "context", priority: 0 },
		body: "You are helpful.",
		sourcePath: "/src/skills/core/soul.md",
	};
	const userContextSkill: Skill = {
		manifest: { name: "spanish", description: "Respond in Spanish", version: "1.0.0", type: "context", priority: 20 },
		body: "Always respond in Spanish.",
		sourcePath: "/home/.nimblebrain/skills/spanish.md",
	};
	const matchableSkill: Skill = {
		manifest: {
			name: "compliance",
			description: "Compliance reviewer",
			version: "1.0.0",
			type: "skill",
			priority: 50,
			requiresBundles: ["@acme/policy-search"],
			metadata: { keywords: ["compliance"], triggers: ["check compliance"], },
		},
		body: "Check policy docs first.",
		sourcePath: "/home/.nimblebrain/skills/compliance.md",
	};

	function makeStatusSource(
		skills: { context: Skill[]; matchable: Skill[] },
		lifecycleMock?: { getInstance: (name: string, wsId: string) => unknown },
	) {
		const registry = makeRegistry();
		const getSkills = () => skills;
		const runtimeMock = { requireWorkspaceId: () => "ws_test" } as unknown as import("../../src/runtime/runtime.ts").Runtime;
		return createSystemTools(
			() => registry,
			undefined,
			undefined,
			lifecycleMock as unknown as import("../../src/bundles/lifecycle.ts").BundleLifecycleManager,
			undefined,
			undefined,
			undefined,
			getSkills,
			undefined,
			undefined,
			runtimeMock,
		);
	}

	it("shows core skills as immutable", async () => {
		const source = makeStatusSource({ context: [coreSkill], matchable: [] });
		const result = await source.execute("status", { scope: "skills" });
		expect(result.isError).toBe(false);
		expect(extractText(result.content)).toContain("Core Skills");
		expect(extractText(result.content)).toContain("soul");
		expect(extractText(result.content)).toContain("immutable");
	});

	it("shows user context skills with priority", async () => {
		const source = makeStatusSource({ context: [coreSkill, userContextSkill], matchable: [] });
		const result = await source.execute("status", { scope: "skills" });
		expect(result.isError).toBe(false);
		expect(extractText(result.content)).toContain("User Context");
		expect(extractText(result.content)).toContain("spanish");
		expect(extractText(result.content)).toContain("priority 20");
	});

	it("shows matchable skills with triggers", async () => {
		const source = makeStatusSource({ context: [], matchable: [matchableSkill] });
		const result = await source.execute("status", { scope: "skills" });
		expect(result.isError).toBe(false);
		expect(extractText(result.content)).toContain("Matchable");
		expect(extractText(result.content)).toContain("compliance");
		expect(extractText(result.content)).toContain("check compliance");
	});

	it("returns detailed info for specific skill", async () => {
		const source = makeStatusSource({ context: [coreSkill], matchable: [matchableSkill] });
		const result = await source.execute("status", { scope: "skills", name: "compliance" });
		expect(result.isError).toBe(false);
		expect(extractText(result.content)).toContain("compliance");
		expect(extractText(result.content)).toContain("Check policy docs first");
	});

	it("returns error for non-existent skill", async () => {
		const source = makeStatusSource({ context: [coreSkill], matchable: [] });
		const result = await source.execute("status", { scope: "skills", name: "nonexistent" });
		expect(result.isError).toBe(true);
	});

	it("shows dependency as installed when bundle exists", async () => {
		const lifecycle = { getInstance: (name: string, _wsId: string) => name === "policy-search" ? { status: "running" } : null };
		const source = makeStatusSource({ context: [], matchable: [matchableSkill] }, lifecycle);
		const result = await source.execute("status", { scope: "skills" });
		expect(extractText(result.content)).toContain("@acme/policy-search (installed)");
	});

	it("shows dependency as missing when bundle not installed", async () => {
		const lifecycle = { getInstance: () => null };
		const source = makeStatusSource({ context: [], matchable: [matchableSkill] }, lifecycle);
		const result = await source.execute("status", { scope: "skills" });
		expect(extractText(result.content)).toContain("@acme/policy-search (missing)");
	});
});

// ---------------------------------------------------------------------------
// search — feature flag runtime gating
// ---------------------------------------------------------------------------

describe("search — feature flag gating", () => {
	it("scope=tools returns error when toolDiscovery is disabled", async () => {
		const registry = makeRegistry();
		const features = {
			bundleManagement: true, skillManagement: true, delegation: true,
			toolDiscovery: false, bundleDiscovery: true,
			mcpServer: true, fileContext: true, userManagement: true, workspaceManagement: true,
		};
		const systemTools = createSystemTools(
			() => registry,
			undefined, undefined, undefined, undefined, undefined, undefined,
			undefined, undefined, features,
		);
		const result = await systemTools.execute("search", { scope: "tools", query: "test" });
		expect(result.isError).toBe(true);
		expect(extractText(result.content)).toContain("disabled");
	});

	it("scope=registry returns error when bundleDiscovery is disabled", async () => {
		const registry = makeRegistry();
		const features = {
			bundleManagement: true, skillManagement: true, delegation: true,
			toolDiscovery: true, bundleDiscovery: false,
			mcpServer: true, fileContext: true, userManagement: true, workspaceManagement: true,
		};
		const systemTools = createSystemTools(
			() => registry,
			undefined, undefined, undefined, undefined, undefined, undefined,
			undefined, undefined, features,
		);
		const result = await systemTools.execute("search", { scope: "registry", query: "test" });
		expect(result.isError).toBe(true);
		expect(extractText(result.content)).toContain("disabled");
	});

	it("scope=tools works when toolDiscovery is enabled", async () => {
		const registry = makeRegistry();
		const features = {
			bundleManagement: true, skillManagement: true, delegation: true,
			toolDiscovery: true, bundleDiscovery: false,
			mcpServer: true, fileContext: true, userManagement: true, workspaceManagement: true,
		};
		const systemTools = createSystemTools(
			() => registry,
			undefined, undefined, undefined, undefined, undefined, undefined,
			undefined, undefined, features,
		);
		const result = await systemTools.execute("search", { scope: "tools", query: "hello" });
		expect(result.isError).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// status — overview and config scopes
// ---------------------------------------------------------------------------

describe("status tool — scope: overview", () => {
	it("returns model, apps, and skills info", async () => {
		const registry = makeRegistry();
		const getSkills: GetSkillsFn = () => ({
			context: [{
				manifest: { name: "soul", description: "Identity", version: "1.0.0", type: "context", priority: 0 },
				body: "You are helpful.",
				sourcePath: "/src/skills/core/soul.md",
			}],
			matchable: [],
		});
		const systemTools = createSystemTools(
			() => registry,
			undefined, undefined, undefined, undefined, undefined, undefined,
			getSkills,
		);
		const result = await systemTools.execute("status", {});
		expect(result.isError).toBe(false);
		const text = extractText(result.content);
		expect(text).toContain("Platform Status");
		expect(text).toContain("Skills:");
	});
});

describe("status tool — scope: config", () => {
	it("returns error-free response without runtime", async () => {
		const registry = makeRegistry();
		const systemTools = createSystemTools(() => registry);
		const result = await systemTools.execute("status", { scope: "config" });
		expect(result.isError).toBe(false);
		// Without runtime, returns "not available"
		expect(extractText(result.content)).toContain("not available");
	});
});

// ---------------------------------------------------------------------------
// Input validation — system tools error paths
// ---------------------------------------------------------------------------

describe("System Tools — input validation", () => {
	it("manage_app with unknown action returns error", async () => {
		const registry = makeRegistry();
		const systemTools = createSystemTools(() => registry);
		const result = await systemTools.execute("manage_app", {
			action: "explode",
			name: "test",
		});
		expect(result.isError).toBe(true);
		const text = extractText(result.content);
		// Should indicate invalid action, not crash
		expect(text.length).toBeGreaterThan(0);
	});

	it("manage_app install without name returns error", async () => {
		const registry = makeRegistry();
		const systemTools = createSystemTools(() => registry);
		const result = await systemTools.execute("manage_app", {
			action: "install",
		});
		expect(result.isError).toBe(true);
		const text = extractText(result.content);
		expect(text.length).toBeGreaterThan(0);
	});

	it("manage_app uninstall without name returns error", async () => {
		const registry = makeRegistry();
		const systemTools = createSystemTools(() => registry);
		const result = await systemTools.execute("manage_app", {
			action: "uninstall",
		});
		expect(result.isError).toBe(true);
	});

	it("search with missing query defaults gracefully", async () => {
		const registry = makeRegistry();
		const systemTools = createSystemTools(() => registry);
		// Omit query entirely but provide scope
		const result = await systemTools.execute("search", { scope: "tools" });
		expect(result.isError).toBe(false);
		// Should return all tools (empty query matches everything)
		expect(extractText(result.content)).toContain("test");
	});
});

describe("manage_skill — additional validation", () => {
	let skillDir: string;
	const approveGate: ConfirmationGate = {
		supportsInteraction: true,
		confirm: async () => true,
		promptConfigValue: async () => null,
	};

	beforeEach(() => {
		skillDir = mkdtempSync(join(tmpdir(), "nb-skill-validation-"));
	});

	afterEach(() => {
		rmSync(skillDir, { recursive: true, force: true });
	});

	function makeSource(gate?: ConfirmationGate) {
		const registry = makeRegistry();
		return createSystemTools(
			() => registry,
			undefined,
			gate,
			undefined,
			undefined,
			skillDir,
			async () => {},
		);
	}

	it("create with priority 100 (above max) returns validation error", async () => {
		const source = makeSource(approveGate);
		const result = await source.execute("manage_skill", {
			action: "create",
			name: "high-priority",
			skill: {
				description: "Too high priority",
				priority: 100,
				body: "test",
			},
		});
		expect(result.isError).toBe(true);
		// Schema declares maximum: 99 — caught at the InlineSource layer.
		expect(extractText(result.content)).toContain("priority");
		expect(extractText(result.content)).toContain("<= 99");
	});

	it("create with priority exactly 11 (minimum) succeeds", async () => {
		const source = makeSource(approveGate);
		const result = await source.execute("manage_skill", {
			action: "create",
			name: "min-priority",
			skill: {
				description: "Minimum priority",
				priority: 11,
				body: "test",
			},
		});
		expect(result.isError).toBe(false);
		const saved = readSkill(skillDir, "min-priority");
		expect(saved).not.toBeNull();
		expect(saved!.manifest.priority).toBe(11);
	});

	it("create with priority exactly 99 (maximum) succeeds", async () => {
		const source = makeSource(approveGate);
		const result = await source.execute("manage_skill", {
			action: "create",
			name: "max-priority",
			skill: {
				description: "Maximum priority",
				priority: 99,
				body: "test",
			},
		});
		expect(result.isError).toBe(false);
		const saved = readSkill(skillDir, "max-priority");
		expect(saved).not.toBeNull();
		expect(saved!.manifest.priority).toBe(99);
	});

	it("create with empty body still succeeds", async () => {
		const source = makeSource(approveGate);
		const result = await source.execute("manage_skill", {
			action: "create",
			name: "empty-body",
			skill: {
				description: "Skill with empty body",
				body: "",
			},
		});
		expect(result.isError).toBe(false);
	});

	it("unknown action on manage_skill returns error", async () => {
		const source = makeSource(approveGate);
		const result = await source.execute("manage_skill", {
			action: "purge",
			name: "test",
		});
		expect(result.isError).toBe(true);
	});

	it("edit with invalid priority rejects without modifying file", async () => {
		const source = makeSource(approveGate);
		// Create a valid skill first
		await source.execute("manage_skill", {
			action: "create",
			name: "safe-skill",
			skill: {
				description: "Original",
				priority: 50,
				body: "Original body",
			},
		});

		// Try to edit with invalid priority
		const result = await source.execute("manage_skill", {
			action: "edit",
			name: "safe-skill",
			skill: { priority: 3 },
		});
		expect(result.isError).toBe(true);

		// Original skill should be unchanged
		const saved = readSkill(skillDir, "safe-skill");
		expect(saved).not.toBeNull();
		expect(saved!.manifest.priority).toBe(50);
		expect(saved!.manifest.description).toBe("Original");
	});

	it("delete denied by gate returns error and preserves file", async () => {
		const denyGate: ConfirmationGate = {
			supportsInteraction: true,
			confirm: async () => false,
			promptConfigValue: async () => null,
		};
		const source = makeSource(approveGate);
		await source.execute("manage_skill", {
			action: "create",
			name: "keep-me",
			skill: { description: "Should survive", body: "test" },
		});

		// Now try to delete with deny gate
		const denySource = makeSource(denyGate);
		const result = await denySource.execute("manage_skill", {
			action: "delete",
			name: "keep-me",
		});
		expect(result.isError).toBe(true);

		// File should still exist
		expect(existsSync(join(skillDir, "keep-me.md"))).toBe(true);
	});
});
