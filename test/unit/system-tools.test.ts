import { describe, expect, it } from "bun:test";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { extractText } from "../../src/engine/content-helpers.ts";
import { NON_ADVANCING_META_KEY } from "../../src/engine/types.ts";
import { createSystemTools } from "../../src/tools/system-tools.ts";
import type {
	GetSkillsFn,
	ToolEligibilityContext,
	ToolPromotionContext,
} from "../../src/tools/system-tools.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { textContent } from "../../src/engine/content-helpers.ts";
import { makeInProcessSource } from "../helpers/in-process-source.ts";
import type { Skill } from "../../src/skills/types.ts";
import {
	createPrivilegeHook,
	NoopConfirmationGate,
} from "../../src/config/privilege.ts";
import type { ConfirmationGate } from "../../src/config/privilege.ts";
import { resolveFeatures } from "../../src/config/features.ts";
import { isToolEligibleForPromotion } from "../../src/runtime/tool-eligibility.ts";

const noopSink = new NoopEventSink();

async function makeRegistry(): Promise<ToolRegistry> {
	const registry = new ToolRegistry();
	const source = await makeInProcessSource("test", [
		{
			name: "greet",
			description: "Say hello to someone",
			inputSchema: {
				type: "object",
				properties: { name: { type: "string" } },
			},
			handler: async (input) => ({
				content: textContent(`Hello ${input.name}!`),
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
				content: textContent(`Goodbye ${input.name}!`),
				isError: false,
			}),
		},
	]);
	registry.addSource(source);
	return registry;
}

async function makeTodoSearchRegistry(): Promise<ToolRegistry> {
	const registry = new ToolRegistry();
	const todoSource = await makeInProcessSource("synapse-todo-board", [
		{
			name: "create_board_task",
			description: "Create a task on a specific board",
			inputSchema: { type: "object", properties: {} },
			handler: async () => ({ content: textContent("ok"), isError: false }),
		},
		{
			name: "list_boards",
			description: "List available boards",
			inputSchema: { type: "object", properties: {} },
			handler: async () => ({ content: textContent("ok"), isError: false }),
		},
	]);
	const genericSource = await makeInProcessSource("scratch", [
		{
			name: "create_task_template",
			description: "Create a reusable task template",
			inputSchema: { type: "object", properties: {} },
			handler: async () => ({ content: textContent("ok"), isError: false }),
		},
	]);
	registry.addSource(todoSource);
	registry.addSource(genericSource);
	return registry;
}

async function makeManyMatchingToolsRegistry(count: number): Promise<ToolRegistry> {
	const registry = new ToolRegistry();
	const source = await makeInProcessSource(
		"many",
		Array.from({ length: count }, (_, i) => ({
			name: `common_tool_${String(i).padStart(2, "0")}`,
			description: "Common searchable helper",
			inputSchema: { type: "object", properties: {} },
			handler: async () => ({ content: textContent("ok"), isError: false }),
		})),
	);
	registry.addSource(source);
	return registry;
}

function getStructured<T>(result: { structuredContent?: unknown }): T | undefined {
	return result.structuredContent as T | undefined;
}

describe("System Tools", () => {
	it("search with scope=tools returns matching tools by substring", async () => {
		const registry = await makeRegistry();
		const systemTools = await createSystemTools(() => registry);
		const result = await systemTools.execute("search", {
			scope: "tools",
			query: "hello",
		});
		expect(result.isError).toBe(false);
		expect(extractText(result.content)).toContain("test__greet");
		expect(getStructured<{ tools?: Array<{ name: string }> }>(result)?.tools).toEqual([
			{ name: "test__greet" },
		]);
	});

	it("search auto-promotes its top matches into the active set", async () => {
		const registry = await makeRegistry();
		const added: string[] = [];
		const toolPromotionCtx: ToolPromotionContext = {
			addTool: (name) => {
				added.push(name);
				return { ok: true, toolName: name, changed: true, message: "active" };
			},
			removeTool: (name) => ({ ok: true, toolName: name, changed: false, message: "" }),
		};
		// toolPromotionCtx is the 17th positional arg (15 reserved slots after getRegistry).
		const systemTools = await createSystemTools(
			() => registry,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			toolPromotionCtx,
		);
		const result = await systemTools.execute("search", { scope: "tools", query: "greet" });

		expect(result.isError).toBe(false);
		// The matched tool was promoted into the active set (one fewer round-trip
		// than search → manage_tools → call).
		expect(added).toContain("test__greet");
		// The model is told it can call it directly, and the result reports it.
		expect(extractText(result.content)).toContain("now active");
		expect(getStructured<{ promoted?: string[] }>(result)?.promoted).toContain("test__greet");
	});

	it("search with scope=tools preserves single-word prefix substring matches", async () => {
		const registry = new ToolRegistry();
		const source = await makeInProcessSource("test", [
			{
				name: "greeting",
				description: "Friendly salutation helper",
				inputSchema: { type: "object", properties: {} },
				handler: async () => ({ content: textContent("ok"), isError: false }),
			},
		]);
		registry.addSource(source);
		const systemTools = await createSystemTools(() => registry);
		const result = await systemTools.execute("search", {
			scope: "tools",
			query: "greet",
		});

		expect(result.isError).toBe(false);
		expect(getStructured<{ tools?: Array<{ name: string }> }>(result)?.tools).toEqual([
			{ name: "test__greeting" },
		]);
	});

	it("search with scope=tools matches natural-language terms across source, name, and description", async () => {
		const registry = await makeTodoSearchRegistry();
		const systemTools = await createSystemTools(() => registry);
		const result = await systemTools.execute("search", {
			scope: "tools",
			query: "todo task create",
		});

		expect(result.isError).toBe(false);
		expect(getStructured<{ tools?: Array<{ name: string }> }>(result)?.tools?.[0]).toEqual({
			name: "synapse-todo-board__create_board_task",
		});
		expect(extractText(result.content)).toContain("synapse-todo-board__create_board_task");
	});

	it("search with scope=tools tokenizes hyphenated source names", async () => {
		const registry = await makeTodoSearchRegistry();
		const systemTools = await createSystemTools(() => registry);
		const result = await systemTools.execute("search", {
			scope: "tools",
			query: "todo board",
		});

		expect(result.isError).toBe(false);
		const names = getStructured<{ tools?: Array<{ name: string }> }>(result)?.tools?.map(
			(t) => t.name,
		);
		expect(names).toContain("synapse-todo-board__create_board_task");
		expect(names).toContain("synapse-todo-board__list_boards");
	});

	it("search with scope=tools matches description terms", async () => {
		const registry = await makeTodoSearchRegistry();
		const systemTools = await createSystemTools(() => registry);
		const result = await systemTools.execute("search", {
			scope: "tools",
			query: "specific board",
		});

		expect(result.isError).toBe(false);
		expect(getStructured<{ tools?: Array<{ name: string }> }>(result)?.tools?.[0]).toEqual({
			name: "synapse-todo-board__create_board_task",
		});
	});

	it("search with scope=tools caps broad matches at the top 25 results", async () => {
		const registry = await makeManyMatchingToolsRegistry(30);
		const systemTools = await createSystemTools(() => registry);
		const result = await systemTools.execute("search", {
			scope: "tools",
			query: "common",
		});

		expect(result.isError).toBe(false);
		expect(extractText(result.content)).toContain(
			'Found 30 tool(s) for "common" (showing top 25):',
		);
		expect(getStructured<{ tools?: Array<{ name: string }> }>(result)?.tools).toHaveLength(25);
		expect(extractText(result.content)).toContain("many__common_tool_24");
		expect(extractText(result.content)).not.toContain("many__common_tool_25");
	});

	it("search with scope=tools and empty query returns all tools grouped", async () => {
		const registry = await makeRegistry();
		const systemTools = await createSystemTools(() => registry);
		const result = await systemTools.execute("search", { scope: "tools", query: "" });
		expect(result.isError).toBe(false);
		expect(extractText(result.content)).toContain("test");
		expect(extractText(result.content)).toContain("2 tools");
		// Browse path returns machine-readable tool names so the agent can pass
		// them directly to nb__manage_tools when it wants to make discovered tools callable.
		expect(getStructured<{ tools?: Array<{ name: string }> }>(result)?.tools).toEqual([
			{ name: "test__greet" },
			{ name: "test__farewell" },
		]);
	});

	it("search with scope=tools returns no-match message", async () => {
		const registry = await makeRegistry();
		const systemTools = await createSystemTools(() => registry);
		const result = await systemTools.execute("search", {
			scope: "tools",
			query: "nonexistent",
		});
		expect(result.isError).toBe(false);
		expect(extractText(result.content)).toContain('No tools matched "nonexistent"');
		// Flagged non-advancing (via `_meta`) so repeated empty searches trip
		// the loop supervisor even as the model varies the query each call.
		expect(result._meta?.[NON_ADVANCING_META_KEY]).toBe(true);
	});

	it("search with scope=tools excludes internal tools from results", async () => {
		const registry = new ToolRegistry();
		const source = await makeInProcessSource("test", [
			{
				name: "visible",
				description: "Visible tool",
				inputSchema: { type: "object", properties: {} },
				handler: async () => ({ content: textContent("ok"), isError: false }),
			},
			{
				name: "hidden",
				description: "Hidden internal tool",
				inputSchema: { type: "object", properties: {} },
				handler: async () => ({ content: textContent("ok"), isError: false }),
				annotations: { "ai.nimblebrain/internal": true },
			},
		]);
		registry.addSource(source);
		const systemTools = await createSystemTools(() => registry);
		const result = await systemTools.execute("search", {
			scope: "tools",
			query: "tool",
		});
		expect(result.isError).toBe(false);
		const text = extractText(result.content);
		expect(text).toContain("test__visible");
		expect(text).not.toContain("test__hidden");
		expect(getStructured<{ tools?: Array<{ name: string }> }>(result)?.tools).toEqual([
			{ name: "test__visible" },
		]);
		// A search that matched is advancing — must not be flagged.
		expect(result._meta?.[NON_ADVANCING_META_KEY]).toBeUndefined();
	});

	it("search with scope=tools excludes tools that are not eligible", async () => {
		const registry = new ToolRegistry();
		const source = await makeInProcessSource("nb", [
			{
				name: "visible",
				description: "Visible tool",
				inputSchema: { type: "object", properties: {} },
				handler: async () => ({ content: textContent("ok"), isError: false }),
			},
			{
				name: "manage_users",
				description: "Manage users",
				inputSchema: { type: "object", properties: {} },
				handler: async () => ({ content: textContent("ok"), isError: false }),
			},
		]);
		registry.addSource(source);
		const features = resolveFeatures();
		const toolEligibilityCtx: ToolEligibilityContext = {
			isToolEligible: (tool) => isToolEligibleForPromotion(tool, "member", features),
		};
		const systemTools = await createSystemTools(
			() => registry,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			toolEligibilityCtx,
		);

		const result = await systemTools.execute("search", {
			scope: "tools",
			query: "tool",
		});
		expect(result.isError).toBe(false);
		const text = extractText(result.content);
		expect(text).toContain("nb__visible");
		expect(text).not.toContain("nb__manage_users");
		expect(getStructured<{ tools?: Array<{ name: string }> }>(result)?.tools).toEqual([
			{ name: "nb__visible" },
		]);
	});

	it("search with scope=tools excludes feature-disabled tools", async () => {
		const registry = new ToolRegistry();
		const source = await makeInProcessSource("nb", [
			{
				name: "visible",
				description: "Visible tool",
				inputSchema: { type: "object", properties: {} },
				handler: async () => ({ content: textContent("ok"), isError: false }),
			},
			{
				name: "manage_users",
				description: "Manage users tool",
				inputSchema: { type: "object", properties: {} },
				handler: async () => ({ content: textContent("ok"), isError: false }),
			},
		]);
		registry.addSource(source);
		const features = resolveFeatures({ userManagement: false });
		const toolEligibilityCtx: ToolEligibilityContext = {
			isToolEligible: (tool) => isToolEligibleForPromotion(tool, "admin", features),
		};
		const systemTools = await createSystemTools(
			() => registry,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			toolEligibilityCtx,
		);

		const result = await systemTools.execute("search", {
			scope: "tools",
			query: "tool",
		});
		expect(result.isError).toBe(false);
		const text = extractText(result.content);
		expect(text).toContain("nb__visible");
		expect(text).not.toContain("nb__manage_users");
		expect(getStructured<{ tools?: Array<{ name: string }> }>(result)?.tools).toEqual([
			{ name: "nb__visible" },
		]);
	});

	// `search with scope=registry` lives in test/smoke/system-tools-registry.test.ts.
	// It hits the live mpak registry over the network, which makes it a smoke
	// test by definition (CLAUDE.md: smoke tier owns "real MCP server spawns,
	// network calls"). Unit gate stays deterministic; smoke job continues to
	// validate the live wiring on main.

	it("tools() returns prefixed tool names", async () => {
		const registry = await makeRegistry();
		const systemTools = await createSystemTools(() => registry);
		const tools = await systemTools.tools();
		const names = tools.map((t) => t.name);
		expect(names).toContain("nb__search");
		expect(names).toContain("nb__manage_tools");
		expect(names).not.toContain("nb__manage_app");
	});

	it("manage_tools requires at least one of add or remove to be non-empty", async () => {
		const registry = await makeRegistry();
		const systemTools = await createSystemTools(() => registry);
		const empty = await systemTools.execute("manage_tools", {});
		expect(empty.isError).toBe(true);
		expect(extractText(empty.content)).toContain("at least one");

		const bothEmpty = await systemTools.execute("manage_tools", { add: [], remove: [] });
		expect(bothEmpty.isError).toBe(true);
		expect(extractText(bothEmpty.content)).toContain("at least one");
	});

	it("manage_tools requires an active agent run", async () => {
		const registry = await makeRegistry();
		const systemTools = await createSystemTools(() => registry);
		const result = await systemTools.execute("manage_tools", { add: ["test__greet"] });
		expect(result.isError).toBe(true);
		expect(extractText(result.content)).toContain("active agent run");
	});

	it("manage_tools delegates add and remove to active run tool controls", async () => {
		const registry = await makeRegistry();
		const calls: string[] = [];
		const toolPromotionCtx: ToolPromotionContext = {
			addTool(toolName) {
				calls.push(`add:${toolName}`);
				return { ok: true, toolName, changed: true, message: `${toolName} added` };
			},
			removeTool(toolName) {
				calls.push(`remove:${toolName}`);
				return { ok: true, toolName, changed: true, message: `${toolName} removed` };
			},
		};
		const systemTools = await createSystemTools(
			() => registry,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			toolPromotionCtx,
		);

		const result = await systemTools.execute("manage_tools", {
			add: ["test__greet", "test__farewell"],
			remove: ["test__stale"],
		});
		expect(result.isError).toBe(false);
		// Removes run before adds so atomic domain-switch frees slots first.
		expect(calls).toEqual(["remove:test__stale", "add:test__greet", "add:test__farewell"]);

		const text = extractText(result.content);
		expect(text).toContain("Promoted 2/2");
		expect(text).toContain("Released 1/1");

		const structured = getStructured<{
			promoted: Array<{ ok: boolean; toolName: string }>;
			released: Array<{ ok: boolean; toolName: string }>;
		}>(result);
		expect(structured?.promoted).toHaveLength(2);
		expect(structured?.released).toHaveLength(1);
	});

	it("manage_tools surfaces per-item failures in structuredContent without failing the call", async () => {
		const registry = await makeRegistry();
		const toolPromotionCtx: ToolPromotionContext = {
			addTool(toolName) {
				if (toolName === "internal__secret") {
					return {
						ok: false,
						toolName,
						changed: false,
						reason: "internal_tool",
						message: `${toolName} is an internal tool and cannot be added.`,
					};
				}
				return { ok: true, toolName, changed: true, message: `${toolName} added` };
			},
			removeTool(toolName) {
				return { ok: true, toolName, changed: true, message: `${toolName} removed` };
			},
		};
		const systemTools = await createSystemTools(
			() => registry,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			toolPromotionCtx,
		);

		const result = await systemTools.execute("manage_tools", {
			add: ["app__public", "internal__secret"],
		});
		// Per-item failure does not flip the call-level isError flag — the structured
		// content is the source of truth so the agent can act on partial success.
		expect(result.isError).toBe(false);
		const text = extractText(result.content);
		expect(text).toContain("Promoted 1/2");
		expect(text).toContain("internal__secret");

		const structured = getStructured<{
			promoted: Array<{ ok: boolean; toolName: string; reason?: string }>;
		}>(result);
		expect(structured?.promoted[0]?.ok).toBe(true);
		expect(structured?.promoted[1]?.ok).toBe(false);
		expect(structured?.promoted[1]?.reason).toBe("internal_tool");
	});

	it("manage_tools accepts exact tool names returned by search", async () => {
		const registry = new ToolRegistry();
		const source = await makeInProcessSource("test", [
			{
				name: "tool.with.dot",
				description: "Dotted tool name",
				inputSchema: { type: "object", properties: {} },
				handler: async () => ({ content: textContent("ok"), isError: false }),
			},
		]);
		registry.addSource(source);
		const calls: string[] = [];
		const toolPromotionCtx: ToolPromotionContext = {
			addTool(toolName) {
				calls.push(`add:${toolName}`);
				return { ok: true, toolName, changed: true, message: `${toolName} added` };
			},
			removeTool(toolName) {
				calls.push(`remove:${toolName}`);
				return { ok: true, toolName, changed: true, message: `${toolName} removed` };
			},
		};
		const systemTools = await createSystemTools(
			() => registry,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			toolPromotionCtx,
		);

		const searchResult = await systemTools.execute("search", {
			scope: "tools",
			query: "dotted",
		});
		expect(searchResult.isError).toBe(false);
		expect(getStructured<{ tools?: Array<{ name: string }> }>(searchResult)?.tools).toEqual([
			{ name: "test__tool.with.dot" },
		]);

		// search now auto-promotes its top match; clear the log to isolate the
		// manage_tools call below (intent: manage_tools accepts the searched name).
		expect(calls).toEqual(["add:test__tool.with.dot"]);
		calls.length = 0;

		const result = await systemTools.execute("manage_tools", {
			add: ["test__tool.with.dot"],
		});
		expect(result.isError).toBe(false);
		expect(calls).toEqual(["add:test__tool.with.dot"]);
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
			name: "skills__create",
			input: { scope: "workspace", name: "test-skill" },
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
			name: "skills__create",
			input: { scope: "workspace", name: "test-skill" },
		};
		const result = await hook(call);
		expect(result).toEqual(call);
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

	async function makeStatusSource(
		skills: { context: Skill[]; matchable: Skill[] },
		lifecycleMock?: { getInstance: (name: string, wsId: string) => unknown },
		layer3?: Array<{ skill: Skill; loadedBy: "always" | "tool_affinity"; reason: string }>,
	) {
		const registry = await makeRegistry();
		const getSkills = () => skills;
		// Status reads workspace/user-tier skills through `describeRequestSkills`
		// (the same per-request path `chat` composes with); `context` carries the
		// boot context skills, `layer3` the per-request selection.
		const runtimeMock = {
			requireWorkspaceId: () => "ws_test",
			describeRequestSkills: async () => ({ context: skills.context, layer3: layer3 ?? [] }),
		} as unknown as import("../../src/runtime/runtime.ts").Runtime;
		return await createSystemTools(
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
		const source = await makeStatusSource({ context: [coreSkill], matchable: [] });
		const result = await source.execute("status", { scope: "skills" });
		expect(result.isError).toBe(false);
		expect(extractText(result.content)).toContain("Core Skills");
		expect(extractText(result.content)).toContain("soul");
		expect(extractText(result.content)).toContain("immutable");
	});

	it("shows user context skills with priority", async () => {
		const source = await makeStatusSource({ context: [coreSkill, userContextSkill], matchable: [] });
		const result = await source.execute("status", { scope: "skills" });
		expect(result.isError).toBe(false);
		expect(extractText(result.content)).toContain("User Context");
		expect(extractText(result.content)).toContain("spanish");
		expect(extractText(result.content)).toContain("priority 20");
	});

	it("shows per-request Layer-3 workspace/user skills (regression: status read a boot cache)", async () => {
		const workspaceSkill: Skill = {
			manifest: {
				name: "team-voice",
				description: "Team voice rules",
				version: "1.0.0",
				type: "context",
				priority: 30,
				scope: "workspace",
			},
			body: "Match the team voice.",
			sourcePath: "/home/.nimblebrain/workspaces/ws_test/skills/team-voice.md",
		};
		const source = await makeStatusSource({ context: [coreSkill], matchable: [] }, undefined, [
			{ skill: workspaceSkill, loadedBy: "always", reason: "loading_strategy: always" },
		]);
		const result = await source.execute("status", { scope: "skills" });
		expect(result.isError).toBe(false);
		const text = extractText(result.content);
		expect(text).toContain("Workspace & User Skills (always loaded)");
		expect(text).toContain("team-voice");
		expect(text).toContain("workspace");
	});

	it("lists a skill present in both boot context and the Layer-3 set exactly once", async () => {
		// A boot-context skill (non-core) whose name also surfaces in the
		// per-request Layer-3 set must render once — under the Layer-3 section,
		// not duplicated in "User Context". Guards the userContext dedup branch.
		const dup: Skill = {
			manifest: {
				name: "dual-listed",
				description: "Appears in both sources",
				version: "1.0.0",
				type: "context",
				priority: 25,
				scope: "workspace",
			},
			body: "Body.",
			sourcePath: "/home/.nimblebrain/workspaces/ws_test/skills/dual-listed.md",
		};
		const source = await makeStatusSource({ context: [coreSkill, dup], matchable: [] }, undefined, [
			{ skill: dup, loadedBy: "always", reason: "loading_strategy: always" },
		]);
		const result = await source.execute("status", { scope: "skills" });
		expect(result.isError).toBe(false);
		const text = extractText(result.content);
		expect(text.split("dual-listed").length - 1).toBe(1);
		expect(text).toContain("Workspace & User Skills (always loaded)");
		expect(text).not.toContain("User Context");
	});

	it("shows a core skill that also enters the Layer-3 set once, under Core", async () => {
		// If a core skill ever carries a Layer-3 loading strategy it can appear in
		// both the boot context (Core) and the per-request Layer-3 set. Core is
		// authoritative: it must render once, under "Core Skills", never also in
		// the Layer-3 sections. Guards the name-based coreNames dedup.
		const source = await makeStatusSource({ context: [coreSkill], matchable: [] }, undefined, [
			{ skill: coreSkill, loadedBy: "always", reason: "loading_strategy: always" },
		]);
		const result = await source.execute("status", { scope: "skills" });
		expect(result.isError).toBe(false);
		const text = extractText(result.content);
		expect(text.split("soul").length - 1).toBe(1);
		expect(text).toContain("Core Skills");
		expect(text).not.toContain("Workspace & User Skills");
	});

	it("shows matchable skills with triggers", async () => {
		const source = await makeStatusSource({ context: [], matchable: [matchableSkill] });
		const result = await source.execute("status", { scope: "skills" });
		expect(result.isError).toBe(false);
		expect(extractText(result.content)).toContain("Matchable");
		expect(extractText(result.content)).toContain("compliance");
		expect(extractText(result.content)).toContain("check compliance");
	});

	it("returns detailed info for specific skill", async () => {
		const source = await makeStatusSource({ context: [coreSkill], matchable: [matchableSkill] });
		const result = await source.execute("status", { scope: "skills", name: "compliance" });
		expect(result.isError).toBe(false);
		expect(extractText(result.content)).toContain("compliance");
		expect(extractText(result.content)).toContain("Check policy docs first");
	});

	it("returns error for non-existent skill", async () => {
		const source = await makeStatusSource({ context: [coreSkill], matchable: [] });
		const result = await source.execute("status", { scope: "skills", name: "nonexistent" });
		expect(result.isError).toBe(true);
	});

	it("shows dependency as installed when bundle exists", async () => {
		const lifecycle = { getInstance: (name: string, _wsId: string) => name === "policy-search" ? { status: "running" } : null };
		const source = await makeStatusSource({ context: [], matchable: [matchableSkill] }, lifecycle);
		const result = await source.execute("status", { scope: "skills" });
		expect(extractText(result.content)).toContain("@acme/policy-search (installed)");
	});

	it("shows dependency as missing when bundle not installed", async () => {
		const lifecycle = { getInstance: () => null };
		const source = await makeStatusSource({ context: [], matchable: [matchableSkill] }, lifecycle);
		const result = await source.execute("status", { scope: "skills" });
		expect(extractText(result.content)).toContain("@acme/policy-search (missing)");
	});
});

// ---------------------------------------------------------------------------
// search — feature flag runtime gating
// ---------------------------------------------------------------------------

describe("search — feature flag gating", () => {
	it("scope=tools returns error when toolDiscovery is disabled", async () => {
		const registry = await makeRegistry();
		const features = {
			bundleManagement: true, skillManagement: true, delegation: true,
			toolDiscovery: false, bundleDiscovery: true,
			fileContext: true, userManagement: true, workspaceManagement: true,
		};
		const systemTools = await createSystemTools(
			() => registry,
			undefined, undefined, undefined, undefined, undefined, undefined,
			undefined, undefined, features,
		);
		const result = await systemTools.execute("search", { scope: "tools", query: "test" });
		expect(result.isError).toBe(true);
		expect(extractText(result.content)).toContain("disabled");
	});

	it("scope=registry returns error when bundleDiscovery is disabled", async () => {
		const registry = await makeRegistry();
		const features = {
			bundleManagement: true, skillManagement: true, delegation: true,
			toolDiscovery: true, bundleDiscovery: false,
			fileContext: true, userManagement: true, workspaceManagement: true,
		};
		const systemTools = await createSystemTools(
			() => registry,
			undefined, undefined, undefined, undefined, undefined, undefined,
			undefined, undefined, features,
		);
		const result = await systemTools.execute("search", { scope: "registry", query: "test" });
		expect(result.isError).toBe(true);
		expect(extractText(result.content)).toContain("disabled");
	});

	it("scope=tools works when toolDiscovery is enabled", async () => {
		const registry = await makeRegistry();
		const features = {
			bundleManagement: true, skillManagement: true, delegation: true,
			toolDiscovery: true, bundleDiscovery: false,
			fileContext: true, userManagement: true, workspaceManagement: true,
		};
		const systemTools = await createSystemTools(
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
		const registry = await makeRegistry();
		const getSkills: GetSkillsFn = () => ({
			context: [{
				manifest: { name: "soul", description: "Identity", version: "1.0.0", type: "context", priority: 0 },
				body: "You are helpful.",
				sourcePath: "/src/skills/core/soul.md",
			}],
			matchable: [],
		});
		const systemTools = await createSystemTools(
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
		const registry = await makeRegistry();
		const systemTools = await createSystemTools(() => registry);
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
	it("search with missing query defaults gracefully", async () => {
		const registry = await makeRegistry();
		const systemTools = await createSystemTools(() => registry);
		// Omit query entirely but provide scope
		const result = await systemTools.execute("search", { scope: "tools" });
		expect(result.isError).toBe(false);
		// Should return all tools (empty query matches everything)
		expect(extractText(result.content)).toContain("test");
	});
});

// ---------------------------------------------------------------------------
// nb__read_resource (#3)
// ---------------------------------------------------------------------------

describe("nb__read_resource system tool", () => {
	/**
	 * Build a real in-process MCP source publishing the given URI→resource map.
	 * Replaces the pre-#90 mock that returned ad-hoc shapes — every reader is now
	 * a real `McpSource` so the test exercises the same code path production does.
	 */
	async function buildSource(
		name: string,
		resources: Record<string, string | { text?: string; blob?: Uint8Array; mimeType?: string }>,
	): Promise<import("../../src/tools/mcp-source.ts").McpSource> {
		const map = new Map<string, string | { text?: string; blob?: Uint8Array; mimeType?: string }>(
			Object.entries(resources),
		);
		const { defineInProcessApp } = await import("../../src/tools/in-process-app.ts");
		const source = defineInProcessApp(
			{ name, version: "1.0.0", tools: [], resources: map },
			noopSink,
		);
		await source.start();
		return source;
	}

	it("returns the resource text from the first source that resolves the URI", async () => {
		const registry = new ToolRegistry();
		registry.addSource(
			await buildSource("app-one", {
				"skill://app-one/usage": "Step 1: call the thing. Step 2: win.",
			}),
		);
		registry.addSource(
			await buildSource("app-two", { "skill://app-two/usage": "other content" }),
		);

		const systemTools = await createSystemTools(() => registry);
		const result = await systemTools.execute("read_resource", {
			uri: "skill://app-one/usage",
		});

		expect(result.isError).toBe(false);
		expect(extractText(result.content)).toContain("Step 1: call the thing");
	});

	it("falls through to a later source when earlier sources do not have the URI", async () => {
		const registry = new ToolRegistry();
		registry.addSource(
			await buildSource("first", { "skill://other/thing": "unrelated" }),
		);
		registry.addSource(
			await buildSource("second", { "skill://target/usage": "found in second source" }),
		);

		const systemTools = await createSystemTools(() => registry);
		const result = await systemTools.execute("read_resource", {
			uri: "skill://target/usage",
		});

		expect(result.isError).toBe(false);
		expect(extractText(result.content)).toContain("found in second source");
	});

	it("returns a binary marker when a source resolves the URI as a blob", async () => {
		const registry = new ToolRegistry();
		registry.addSource(
			await buildSource("bin", {
				"ui://bin/icon": { blob: new Uint8Array([1, 2, 3, 4]), mimeType: "image/png" },
			}),
		);

		const systemTools = await createSystemTools(() => registry);
		const result = await systemTools.execute("read_resource", {
			uri: "ui://bin/icon",
		});

		expect(result.isError).toBe(false);
		const text = extractText(result.content);
		expect(text).toContain("[binary resource");
		expect(text).toContain("4 bytes");
		expect(text).toContain("image/png");
	});

	it("returns isError when the URI is not found in any source", async () => {
		const registry = new ToolRegistry();
		registry.addSource(
			await buildSource("app-one", { "skill://app-one/usage": "content" }),
		);
		const systemTools = await createSystemTools(() => registry);

		const result = await systemTools.execute("read_resource", {
			uri: "skill://nowhere/missing",
		});

		expect(result.isError).toBe(true);
		expect(extractText(result.content)).toContain("not found");
	});

	it("returns isError when uri is missing or empty", async () => {
		const registry = new ToolRegistry();
		const systemTools = await createSystemTools(() => registry);

		const missing = await systemTools.execute("read_resource", {});
		expect(missing.isError).toBe(true);

		// Whitespace-only passes schema validation but is rejected by the handler.
		const empty = await systemTools.execute("read_resource", { uri: "   " });
		expect(empty.isError).toBe(true);
		expect(extractText(empty.content)).toContain("uri is required");
	});

	it("truncates resource content larger than the budget", async () => {
		const registry = new ToolRegistry();
		const huge = "x".repeat(20_000);
		registry.addSource(await buildSource("big", { "skill://big/huge": { text: huge } }));

		const systemTools = await createSystemTools(() => registry);
		const result = await systemTools.execute("read_resource", {
			uri: "skill://big/huge",
		});

		expect(result.isError).toBe(false);
		const text = extractText(result.content);
		expect(text).toContain("[truncated");
		expect(text.length).toBeLessThan(huge.length);
	});

	// Regression: issue #90. Pre-fix, `nb__read_resource` could not resolve
	// `ui://` URIs published by an InlineSource because the structural type
	// guard accepted both `string` and `ResourceData` shapes and the read
	// loop assumed the latter. After unification on in-process MCP, every
	// source publishes via the protocol and `data.text` is reliable.
	it("resolves ui:// resources published by an in-process platform-style source (#90)", async () => {
		const registry = new ToolRegistry();
		registry.addSource(
			await buildSource("settings", { "ui://settings/panel": "<html>panel</html>" }),
		);

		const systemTools = await createSystemTools(() => registry);
		const result = await systemTools.execute("read_resource", {
			uri: "ui://settings/panel",
		});

		expect(result.isError).toBe(false);
		expect(extractText(result.content)).toContain("<html>panel</html>");
	});

	// Description signals the supported URI schemes so the agent can discover
	// the platform-published `instructions://` resources and bundle-published
	// `<bundle>://...` resources without having to be told about each one.
	it("description references instructions:// and bundle-scheme URIs alongside skill:// / ui://", async () => {
		const registry = new ToolRegistry();
		const systemTools = await createSystemTools(() => registry);
		const tools = await systemTools.tools();
		const readResource = tools.find((t) => t.name === "nb__read_resource");
		expect(readResource).toBeDefined();
		expect(readResource?.description).toContain("instructions://");
		expect(readResource?.description).toContain("skill://");
		expect(readResource?.description).toContain("ui://");
	});
});
