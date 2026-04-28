import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { extractText } from "../../src/engine/content-helpers.ts";
import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BundleLifecycleManager } from "../../src/bundles/lifecycle.ts";
import { createSystemTools } from "../../src/tools/system-tools.ts";
import type {
	GetSkillsFn,
	ManageBundleContext,
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
import { getWorkspaceCredentials } from "../../src/config/workspace-credentials.ts";
import { readSkill } from "../../src/skills/writer.ts";
import { WorkspaceStore } from "../../src/workspace/workspace-store.ts";

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
	});

	it("search with scope=tools and empty query returns all tools grouped", async () => {
		const registry = await makeRegistry();
		const systemTools = await createSystemTools(() => registry);
		const result = await systemTools.execute("search", { scope: "tools", query: "" });
		expect(result.isError).toBe(false);
		expect(extractText(result.content)).toContain("test");
		expect(extractText(result.content)).toContain("2 tools");
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
	});

	it("search with scope=registry searches mpak registry", async () => {
		const registry = await makeRegistry();
		const systemTools = await createSystemTools(() => registry);
		const result = await systemTools.execute("search", {
			scope: "registry",
			query: "ipinfo",
		});
		expect(result.isError).toBe(false);
		// Should contain actual search results (mpak must be installed)
		expect(extractText(result.content)).toContain("ipinfo");
	}, 15_000);

	it("manage_app install requires lifecycle context", async () => {
		const registry = await makeRegistry();
		const systemTools = await createSystemTools(() => registry);
		const result = await systemTools.execute("manage_app", {
			action: "install",
			name: "@test/nonexistent-bundle-xyz",
		});
		expect(result.isError).toBe(true);
		expect(extractText(result.content)).toContain("lifecycle context");
	}, 15_000);

	it("manage_app uninstall requires lifecycle context", async () => {
		const registry = await makeRegistry();
		const systemTools = await createSystemTools(() => registry);
		const result = await systemTools.execute("manage_app", {
			action: "uninstall",
			name: "nonexistent",
		});
		expect(result.isError).toBe(true);
		expect(extractText(result.content)).toContain("lifecycle context");
	});

	it("tools() returns prefixed tool names", async () => {
		const registry = await makeRegistry();
		const systemTools = await createSystemTools(() => registry);
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
	) {
		const registry = await makeRegistry();
		const getSkills = () => skills;
		const runtimeMock = { requireWorkspaceId: () => "ws_test" } as unknown as import("../../src/runtime/runtime.ts").Runtime;
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
			mcpServer: true, fileContext: true, userManagement: true, workspaceManagement: true,
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
			mcpServer: true, fileContext: true, userManagement: true, workspaceManagement: true,
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
			mcpServer: true, fileContext: true, userManagement: true, workspaceManagement: true,
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
	it("manage_app with unknown action returns error", async () => {
		const registry = await makeRegistry();
		const systemTools = await createSystemTools(() => registry);
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
		const registry = await makeRegistry();
		const systemTools = await createSystemTools(() => registry);
		const result = await systemTools.execute("manage_app", {
			action: "install",
		});
		expect(result.isError).toBe(true);
		const text = extractText(result.content);
		expect(text.length).toBeGreaterThan(0);
	});

	it("manage_app uninstall without name returns error", async () => {
		const registry = await makeRegistry();
		const systemTools = await createSystemTools(() => registry);
		const result = await systemTools.execute("manage_app", {
			action: "uninstall",
		});
		expect(result.isError).toBe(true);
	});

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
// manage_app configure — credential resolution via workspace store
// ---------------------------------------------------------------------------

describe("manage_app configure — workspace-scoped credentials", () => {
	let workDir: string;
	let mpakHome: string;
	// WORKSPACE_ID_RE requires ws_ prefix + [a-z0-9_] chars. Hyphens are invalid
	// per the regex enforced by WorkspaceStore and now also by the credential
	// store's input validation (PR #40 QA fixup).
	const wsId = "ws_configure_test";
	const bundleName = "@testscope/configurable";

	/**
	 * Write a fake manifest for `bundleName` into `{mpakHome}/cache/{slug}/`
	 * so `getMpak().bundleCache.getBundleManifest(name)` returns it without
	 * hitting the network. The cache dir layout is:
	 *   `<cacheHome>/<scope>-<name>/manifest.json`
	 * matching `MpakBundleCache.getBundleCacheDirName()`.
	 */
	function writeFakeBundle(opts: {
		userConfig?: Record<string, unknown>;
	}): void {
		const safeName = bundleName.replace("@", "").replace("/", "-");
		const cacheDir = join(mpakHome, "cache", safeName);
		mkdirSync(cacheDir, { recursive: true });

		const manifest: Record<string, unknown> = {
			manifest_version: "0.4",
			name: bundleName,
			version: "1.0.0",
			description: "Configurable test bundle",
			author: { name: "Test" },
			server: {
				type: "node",
				entry_point: "server.js",
				mcp_config: {
					command: "node",
					args: ["${__dirname}/server.js"],
				},
			},
		};
		if (opts.userConfig) manifest.user_config = opts.userConfig;
		writeFileSync(join(cacheDir, "manifest.json"), JSON.stringify(manifest, null, 2));
	}

	/** Create a bundle ctx + system tools wired for `manage_app configure`. */
	async function buildTools(gate: ConfirmationGate | undefined) {
		const registry = new ToolRegistry();
		const sink = new NoopEventSink();
		const lifecycle = new BundleLifecycleManager(sink, undefined, false, mpakHome);
		const store = new WorkspaceStore(workDir);
		const ctx: ManageBundleContext = {
			getWorkspaceId: () => wsId,
			workspaceStore: store,
			workDir,
			configDir: undefined,
			eventSink: sink,
		};
		const tools = await createSystemTools(
			() => registry,
			undefined,
			gate,
			lifecycle,
			undefined,
			undefined,
			undefined,
			undefined,
			sink,
			undefined,
			undefined,
			mpakHome,
			undefined,
			undefined,
			undefined,
			undefined,
			ctx,
		);
		return { tools, registry, sink };
	}

	beforeEach(() => {
		workDir = mkdtempSync(join(tmpdir(), "nb-configure-test-"));
		mpakHome = mkdtempSync(join(tmpdir(), "nb-configure-mpak-"));
	});

	afterEach(() => {
		rmSync(workDir, { recursive: true, force: true });
		rmSync(mpakHome, { recursive: true, force: true });
	});

	it("non-interactive gate with user_config returns error suggesting `nb config set ... -w <wsId>`", async () => {
		writeFakeBundle({
			userConfig: {
				api_key: { type: "string", title: "API Key", required: true, sensitive: true },
			},
		});

		const gate: ConfirmationGate = {
			supportsInteraction: false,
			confirm: async () => true,
			promptConfigValue: async () => null,
		};
		const { tools } = await buildTools(gate);

		const result = await tools.execute("manage_app", {
			action: "configure",
			name: bundleName,
		});

		expect(result.isError).toBe(true);
		const text = extractText(result.content);
		expect(text).toContain("Cannot configure interactively in server mode");
		expect(text).toContain(`nb config set ${bundleName} api_key=<value> -w ${wsId}`);
	});

	it("bundle with no user_config reports nothing to configure (interactive)", async () => {
		writeFakeBundle({});

		const gate: ConfirmationGate = {
			supportsInteraction: true,
			confirm: async () => true,
			promptConfigValue: async () => null,
		};
		const { tools } = await buildTools(gate);

		const result = await tools.execute("manage_app", {
			action: "configure",
			name: bundleName,
		});

		expect(result.isError).toBe(false);
		expect(extractText(result.content)).toContain("has no configurable credentials");
	});

	it("bundle with no user_config reports nothing to configure (non-interactive)", async () => {
		writeFakeBundle({});

		const gate: ConfirmationGate = {
			supportsInteraction: false,
			confirm: async () => true,
			promptConfigValue: async () => null,
		};
		const { tools } = await buildTools(gate);

		const result = await tools.execute("manage_app", {
			action: "configure",
			name: bundleName,
		});

		expect(result.isError).toBe(false);
		expect(extractText(result.content)).toContain("has no configurable credentials");
	});

	it("interactive gate: prompted values are saved to the workspace credential store", async () => {
		writeFakeBundle({
			userConfig: {
				api_key: { type: "string", title: "API Key", required: true, sensitive: true },
			},
		});

		const promptCalls: string[] = [];
		const gate: ConfirmationGate = {
			supportsInteraction: true,
			confirm: async () => true,
			promptConfigValue: async (field) => {
				promptCalls.push(field.key);
				return "sk-prompted-value";
			},
		};
		const { tools } = await buildTools(gate);

		// The restart via startBundleSource will fail (no real bundle zip), but
		// credentials are persisted BEFORE restart — that's the behavior we're
		// asserting. The tool result ends up isError=true for that reason, but
		// the workspace credential store must contain the prompted value.
		await tools.execute("manage_app", {
			action: "configure",
			name: bundleName,
		});

		expect(promptCalls).toEqual(["api_key"]);

		const creds = await getWorkspaceCredentials(wsId, bundleName, workDir);
		expect(creds).not.toBeNull();
		expect(creds?.api_key).toBe("sk-prompted-value");
	});

	it("forcePrompt: re-prompts even when a value already exists in the workspace store", async () => {
		writeFakeBundle({
			userConfig: {
				api_key: { type: "string", title: "API Key", required: true, sensitive: true },
			},
		});

		// Seed an existing credential via the workspace store writer.
		const { saveWorkspaceCredential } = await import(
			"../../src/config/workspace-credentials.ts"
		);
		await saveWorkspaceCredential(wsId, bundleName, "api_key", "sk-old-value", workDir);

		const promptCalls: string[] = [];
		const gate: ConfirmationGate = {
			supportsInteraction: true,
			confirm: async () => true,
			promptConfigValue: async (field) => {
				promptCalls.push(field.key);
				return "sk-new-value";
			},
		};
		const { tools } = await buildTools(gate);

		await tools.execute("manage_app", {
			action: "configure",
			name: bundleName,
		});

		// forcePrompt means the gate is called even though a stored value
		// already exists — that's the whole point of `configure`.
		expect(promptCalls).toEqual(["api_key"]);

		const creds = await getWorkspaceCredentials(wsId, bundleName, workDir);
		expect(creds?.api_key).toBe("sk-new-value");
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
