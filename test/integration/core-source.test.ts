import { describe, expect, it, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Runtime } from "../../src/runtime/runtime.ts";
import { runWithRequestContext } from "../../src/runtime/request-context.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { createCoreToolDefs } from "../../src/tools/core-source.ts";
import { makeInProcessSource } from "../helpers/in-process-source.ts";
import { extractText } from "../../src/engine/content-helpers.ts";
import { loadConfig } from "../../src/cli/config.ts";
import { deriveOverridePath } from "../../src/config/overrides.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";

const testDir = join(tmpdir(), `nimblebrain-core-source-${Date.now()}`);

afterAll(() => {
	if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

async function makeRuntime(): Promise<Runtime> {
	const workDir = join(testDir, `work-${Date.now()}`);
	mkdirSync(workDir, { recursive: true });
	return Runtime.start({
		model: { provider: "custom", adapter: createEchoModel() },
		noDefaultBundles: true,
		workDir,
		logging: { disabled: true },
	});
}

describe("Core Source", () => {
	it("tools() returns 8 tools with nb__ prefix", async () => {
		const runtime = await makeRuntime();
		try {
			const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));
			const tools = await source.tools();
			expect(tools).toHaveLength(8);
			for (const tool of tools) {
				expect(tool.name).toMatch(/^nb__/);
			}
			const names = tools.map((t) => t.name).sort();
			expect(names).toEqual([
				"nb__briefing",
				"nb__get_config",
				"nb__list_apps",
				"nb__manage_identity",
				"nb__set_model_config",
				"nb__set_preferences",
				"nb__version",
				"nb__workspace_info",
			]);
		} finally {
			await runtime.shutdown();
		}
	});

	it("all tools have non-empty descriptions and valid inputSchemas", async () => {
		const runtime = await makeRuntime();
		try {
			const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));
			const tools = await source.tools();
			for (const tool of tools) {
				expect(tool.description.length).toBeGreaterThan(0);
				expect(tool.inputSchema).toBeDefined();
				expect(typeof tool.inputSchema).toBe("object");
				expect((tool.inputSchema as Record<string, unknown>).type).toBe(
					"object",
				);
			}
		} finally {
			await runtime.shutdown();
		}
	});

	it("nb__list_apps returns app list", async () => {
		const runtime = await makeRuntime();
		try {
			await provisionTestWorkspace(runtime);
			const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));
			const result = await runWithRequestContext(
				{ identity: null, workspaceId: TEST_WORKSPACE_ID, workspaceAgents: null, workspaceModelOverride: null },
				() => source.execute("list_apps", {}),
			);
			expect(result.isError).toBe(false);
			const data = result.structuredContent as Record<string, unknown>;
			expect(data.apps).toBeDefined();
			expect(Array.isArray(data.apps)).toBe(true);
		} finally {
			await runtime.shutdown();
		}
	});

	it("execute returns error for unknown tool name", async () => {
		const runtime = await makeRuntime();
		try {
			const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));
			const result = await source.execute("nonexistent_tool", {});
			expect(result.isError).toBe(true);
			expect(extractText(result.content)).toContain("Unknown tool");
		} finally {
			await runtime.shutdown();
		}
	});

	it("nb__set_model_config with valid model updates config file", async () => {
		const workDir = join(testDir, `work-setconfig-${Date.now()}`);
		mkdirSync(workDir, { recursive: true });
		const configPath = join(workDir, "nimblebrain.json");
		writeFileSync(configPath, JSON.stringify({ version: "1" }));

		const runtime = await Runtime.start({
			model: { provider: "custom", adapter: createEchoModel() },
			noDefaultBundles: true,
			workDir,
			configPath,
			logging: { disabled: true },
		});
		try {
			const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));
			const result = await source.execute("set_model_config", {
				defaultModel: "claude-haiku-4-5-20251001",
			});
			expect(result.isError).toBe(false);
			const data = result.structuredContent as Record<string, unknown>;
			expect(data.success).toBe(true);

			// Verify the override file (NOT the seed) was written.
			const raw = JSON.parse(
				require("node:fs").readFileSync(deriveOverridePath(configPath), "utf-8"),
			);
			expect(raw.defaultModel).toBe("claude-haiku-4-5-20251001");
		} finally {
			await runtime.shutdown();
		}
	});

	it("nb__set_model_config with invalid model returns error", async () => {
		const workDir = join(testDir, `work-badmodel-${Date.now()}`);
		mkdirSync(workDir, { recursive: true });
		const configPath = join(workDir, "nimblebrain.json");
		writeFileSync(configPath, JSON.stringify({ version: "1" }));

		const runtime = await Runtime.start({
			model: { provider: "custom", adapter: createEchoModel() },
			noDefaultBundles: true,
			workDir,
			configPath,
			logging: { disabled: true },
		});
		try {
			const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));
			const result = await source.execute("set_model_config", {
				defaultModel: "unconfigured-provider:some-model",
			});
			expect(result.isError).toBe(true);
			expect(extractText(result.content)).toContain("Invalid model");
		} finally {
			await runtime.shutdown();
		}
	});

	it("nb__set_model_config with maxIterations > 50 returns error", async () => {
		const workDir = join(testDir, `work-baditer-${Date.now()}`);
		mkdirSync(workDir, { recursive: true });
		const configPath = join(workDir, "nimblebrain.json");
		writeFileSync(configPath, JSON.stringify({ version: "1" }));

		const runtime = await Runtime.start({
			model: { provider: "custom", adapter: createEchoModel() },
			noDefaultBundles: true,
			workDir,
			configPath,
			logging: { disabled: true },
		});
		try {
			const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));
			const result = await source.execute("set_model_config", {
				maxIterations: 60,
			});
			expect(result.isError).toBe(true);
			expect(extractText(result.content)).toContain("1 and 50");
		} finally {
			await runtime.shutdown();
		}
	});

	it("config file is valid JSON after set_config write", async () => {
		const workDir = join(testDir, `work-jsonvalid-${Date.now()}`);
		mkdirSync(workDir, { recursive: true });
		const configPath = join(workDir, "nimblebrain.json");
		writeFileSync(configPath, JSON.stringify({ version: "1", maxIterations: 5 }));

		const runtime = await Runtime.start({
			model: { provider: "custom", adapter: createEchoModel() },
			noDefaultBundles: true,
			workDir,
			configPath,
			logging: { disabled: true },
		});
		try {
			const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));
			await source.execute("set_model_config", {
				maxOutputTokens: 8192,
			});

			// Override file must be valid JSON with only the field we wrote.
			// The seed file is NOT touched — it stays Helm-managed.
			const overrideRaw = JSON.parse(
				require("node:fs").readFileSync(deriveOverridePath(configPath), "utf-8"),
			);
			expect(overrideRaw.maxOutputTokens).toBe(8192);
			const seedRaw = JSON.parse(
				require("node:fs").readFileSync(configPath, "utf-8"),
			);
			expect(seedRaw.version).toBe("1");
			expect(seedRaw.maxIterations).toBe(5);
			expect(seedRaw.maxOutputTokens).toBeUndefined();
		} finally {
			await runtime.shutdown();
		}
	});

	it("nb__set_model_config rejects thinking='enabled' without a budget", async () => {
		const workDir = join(testDir, `work-thinking-noburget-${Date.now()}`);
		mkdirSync(workDir, { recursive: true });
		const configPath = join(workDir, "nimblebrain.json");
		writeFileSync(configPath, JSON.stringify({ version: "1" }));

		const runtime = await Runtime.start({
			model: { provider: "custom", adapter: createEchoModel() },
			noDefaultBundles: true,
			workDir,
			configPath,
			logging: { disabled: true },
		});
		try {
			const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));
			const result = await source.execute("set_model_config", {
				thinking: "enabled",
			});
			expect(result.isError).toBe(true);
			expect(extractText(result.content)).toContain("requires thinkingBudgetTokens");
		} finally {
			await runtime.shutdown();
		}
	});

	it("nb__set_model_config accepts thinking='enabled' with a valid budget", async () => {
		const workDir = join(testDir, `work-thinking-ok-${Date.now()}`);
		mkdirSync(workDir, { recursive: true });
		const configPath = join(workDir, "nimblebrain.json");
		writeFileSync(configPath, JSON.stringify({ version: "1" }));

		const runtime = await Runtime.start({
			model: { provider: "custom", adapter: createEchoModel() },
			noDefaultBundles: true,
			workDir,
			configPath,
			logging: { disabled: true },
		});
		try {
			const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));
			const result = await source.execute("set_model_config", {
				thinking: "enabled",
				thinkingBudgetTokens: 8192,
			});
			expect(result.isError).toBe(false);
			const raw = JSON.parse(
				require("node:fs").readFileSync(deriveOverridePath(configPath), "utf-8"),
			);
			expect(raw.thinking).toBe("enabled");
			expect(raw.thinkingBudgetTokens).toBe(8192);
		} finally {
			await runtime.shutdown();
		}
	});

	it("nb__set_model_config rejects thinking='enabled' + clearThinkingBudget=true even with an existing budget", async () => {
		// The existing budget would survive validation if the validator
		// only checked disk state, but the merge then deletes it — leaving
		// thinking=enabled with no budget, the silent-downgrade trap.
		const workDir = join(testDir, `work-thinking-clearbudget-${Date.now()}`);
		mkdirSync(workDir, { recursive: true });
		const configPath = join(workDir, "nimblebrain.json");
		const overridePath = deriveOverridePath(configPath);
		writeFileSync(configPath, JSON.stringify({ version: "1" }));
		// Pre-existing user override (representing prior set_model_config state).
		writeFileSync(
			overridePath,
			JSON.stringify({ thinking: "enabled", thinkingBudgetTokens: 8192 }),
		);

		const runtime = await Runtime.start({
			model: { provider: "custom", adapter: createEchoModel() },
			noDefaultBundles: true,
			workDir,
			configPath,
			logging: { disabled: true },
		});
		try {
			const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));
			const result = await source.execute("set_model_config", {
				thinking: "enabled",
				clearThinkingBudget: true,
			});
			expect(result.isError).toBe(true);
			expect(extractText(result.content)).toContain("requires thinkingBudgetTokens");
			// Override file untouched on validation failure.
			const raw = JSON.parse(require("node:fs").readFileSync(overridePath, "utf-8"));
			expect(raw.thinking).toBe("enabled");
			expect(raw.thinkingBudgetTokens).toBe(8192);
		} finally {
			await runtime.shutdown();
		}
	});

	it("nb__set_model_config clearThinking=true clears the override and the budget", async () => {
		// The schema-clean replacement for the legacy `thinking: null` sentinel.
		// The handler still understands null internally — see the normalize step
		// at the top of the handler — but the public surface is the boolean flag
		// because Gemini rejects enums on non-string types.
		const workDir = join(testDir, `work-clear-thinking-${Date.now()}`);
		mkdirSync(workDir, { recursive: true });
		const configPath = join(workDir, "nimblebrain.json");
		const overridePath = deriveOverridePath(configPath);
		writeFileSync(configPath, JSON.stringify({ version: "1" }));
		writeFileSync(
			overridePath,
			JSON.stringify({ thinking: "enabled", thinkingBudgetTokens: 8192 }),
		);

		const runtime = await Runtime.start({
			model: { provider: "custom", adapter: createEchoModel() },
			noDefaultBundles: true,
			workDir,
			configPath,
			logging: { disabled: true },
		});
		try {
			const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));
			const result = await source.execute("set_model_config", {
				clearThinking: true,
			});
			expect(result.isError).toBe(false);
			const raw = JSON.parse(require("node:fs").readFileSync(overridePath, "utf-8"));
			expect(raw.thinking).toBeUndefined();
			// Budget is cleared together — a budget without a mode is meaningless.
			expect(raw.thinkingBudgetTokens).toBeUndefined();
		} finally {
			await runtime.shutdown();
		}
	});

	it("nb__set_model_config clearThinkingBudget=true clears just the budget", async () => {
		const workDir = join(testDir, `work-clear-budget-${Date.now()}`);
		mkdirSync(workDir, { recursive: true });
		const configPath = join(workDir, "nimblebrain.json");
		const overridePath = deriveOverridePath(configPath);
		writeFileSync(configPath, JSON.stringify({ version: "1" }));
		// Start in adaptive with an inherited budget that should disappear.
		writeFileSync(
			overridePath,
			JSON.stringify({ thinking: "adaptive", thinkingBudgetTokens: 8192 }),
		);

		const runtime = await Runtime.start({
			model: { provider: "custom", adapter: createEchoModel() },
			noDefaultBundles: true,
			workDir,
			configPath,
			logging: { disabled: true },
		});
		try {
			const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));
			const result = await source.execute("set_model_config", {
				clearThinkingBudget: true,
			});
			expect(result.isError).toBe(false);
			const raw = JSON.parse(require("node:fs").readFileSync(overridePath, "utf-8"));
			expect(raw.thinking).toBe("adaptive");
			expect(raw.thinkingBudgetTokens).toBeUndefined();
		} finally {
			await runtime.shutdown();
		}
	});

	it("nb__set_model_config rejects ambiguous thinking + clearThinking together", async () => {
		const workDir = join(testDir, `work-clear-ambiguous-${Date.now()}`);
		mkdirSync(workDir, { recursive: true });
		const configPath = join(workDir, "nimblebrain.json");
		writeFileSync(configPath, JSON.stringify({}));

		const runtime = await Runtime.start({
			model: { provider: "custom", adapter: createEchoModel() },
			noDefaultBundles: true,
			workDir,
			configPath,
			logging: { disabled: true },
		});
		try {
			const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));
			const result = await source.execute("set_model_config", {
				thinking: "off",
				clearThinking: true,
			});
			expect(result.isError).toBe(true);
			expect(extractText(result.content)).toContain("Cannot set both");
		} finally {
			await runtime.shutdown();
		}
	});

	it("set_model_config writes survive a runtime restart (layered seed + override)", async () => {
		// Regression guard for the deploy-replay scenario: an operator runs
		// set_model_config to pin defaultModel and thinking, then the pod
		// restarts. The init container overwrites the seed (simulated by us
		// keeping the seed file unchanged) but the override file on the PVC
		// survives, and the runtime should boot with the user's last values.
		const workDir = join(testDir, `work-layered-restart-${Date.now()}`);
		mkdirSync(workDir, { recursive: true });
		const configPath = join(workDir, "nimblebrain.json");
		const overridePath = deriveOverridePath(configPath);
		writeFileSync(
			configPath,
			JSON.stringify({ version: "1", defaultModel: "claude-opus-4-7", maxIterations: 10 }),
		);

		// First runtime: simulate the operator changing config.
		const r1 = await Runtime.start({
			model: { provider: "custom", adapter: createEchoModel() },
			noDefaultBundles: true,
			workDir,
			configPath,
			logging: { disabled: true },
		});
		try {
			const source = await makeInProcessSource("nb", createCoreToolDefs(r1));
			const result = await source.execute("set_model_config", {
				defaultModel: "claude-haiku-4-5-20251001",
				thinking: "off",
			});
			expect(result.isError).toBe(false);
		} finally {
			await r1.shutdown();
		}

		// Override file written, seed file untouched.
		const overrideAfterWrite = JSON.parse(
			require("node:fs").readFileSync(overridePath, "utf-8"),
		);
		expect(overrideAfterWrite.defaultModel).toBe("claude-haiku-4-5-20251001");
		expect(overrideAfterWrite.thinking).toBe("off");
		const seedAfterWrite = JSON.parse(require("node:fs").readFileSync(configPath, "utf-8"));
		expect(seedAfterWrite.defaultModel).toBe("claude-opus-4-7"); // unchanged
		expect(seedAfterWrite.thinking).toBeUndefined();

		// Second runtime: load via loadConfig (the production path that
		// reads seed + override). Effective config should reflect the
		// override, not the seed — that's the whole point.
		const loaded = loadConfig({ config: configPath });
		const r2 = await Runtime.start({
			...loaded,
			model: { provider: "custom", adapter: createEchoModel() },
			noDefaultBundles: true,
			workDir,
			logging: { disabled: true },
		});
		try {
			const cfg = r2.getRuntimeConfig();
			expect(cfg.defaultModel).toBe("claude-haiku-4-5-20251001");
			expect(cfg.thinking).toBe("off");
		} finally {
			await r2.shutdown();
		}
	});

	it("nb__set_model_config schema declares thinking as plain string + boolean clear flags (Gemini-compatible)", async () => {
		// Regression guard: any future schema change that puts `enum` on a
		// non-string type, or uses union types, will break Google-only tenants
		// because Gemini rejects the entire request. Lock the LCD shape.
		const runtime = await makeRuntime();
		try {
			const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));
			const tools = await source.tools();
			const setModelConfig = tools.find((t) => t.name === "nb__set_model_config");
			expect(setModelConfig).toBeDefined();
			const props = (setModelConfig?.inputSchema as { properties: Record<string, unknown> })
				.properties;
			const thinking = props.thinking as { type: unknown; enum: unknown };
			expect(thinking.type).toBe("string");
			expect(thinking.enum).toEqual(["off", "adaptive", "enabled"]);
			const budget = props.thinkingBudgetTokens as { type: unknown };
			expect(budget.type).toBe("number");
			expect((props.clearThinking as { type: unknown }).type).toBe("boolean");
			expect((props.clearThinkingBudget as { type: unknown }).type).toBe("boolean");
		} finally {
			await runtime.shutdown();
		}
	});

	it("nb__set_model_config without configPath returns error", async () => {
		const runtime = await makeRuntime();
		try {
			const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));
			const result = await source.execute("set_model_config", {
				maxIterations: 5,
			});
			expect(result.isError).toBe(true);
			expect(extractText(result.content)).toContain("No config override path");
		} finally {
			await runtime.shutdown();
		}
	});
});
