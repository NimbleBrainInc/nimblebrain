import { describe, expect, it, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { Runtime } from "../../src/runtime/runtime.ts";
import { runWithRequestContext } from "../../src/runtime/request-context.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { createCoreToolDefs } from "../../src/tools/core-source.ts";
import { makeInProcessSource } from "../helpers/in-process-source.ts";
import { extractText } from "../../src/engine/content-helpers.ts";
import { loadConfig } from "../../src/cli/config.ts";
import { log } from "../../src/observability/log.ts";
import { deriveOverridePath } from "../../src/config/overrides.ts";
import { DEFAULT_MAX_ITERATIONS } from "../../src/limits.ts";
import {
	EFFORT_DEFAULT,
	THINKING_DEFAULT,
	thinkingPatchFor,
} from "../../web/src/pages/settings/thinking-patch.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";

/** Model adapter that throws on doGenerate, counting invocations. Used
 * to exercise the briefing tool's cache-on-failure rule: when the LLM
 * call fails, the tool should not cache the error result, so a
 * subsequent call regenerates (and the model is called again). */
function createThrowingModel(err: Error): {
	model: LanguageModelV3;
	getCalls: () => number;
} {
	let calls = 0;
	const model: LanguageModelV3 = {
		specificationVersion: "v3",
		provider: "mock-throwing",
		modelId: "mock-throwing-model",
		supportedUrls: {},
		async doGenerate() {
			calls++;
			throw err;
		},
		async doStream() {
			throw new Error("Not implemented for this test");
		},
	};
	return { model, getCalls: () => calls };
}

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
	it("tools() returns 10 tools with nb__ prefix", async () => {
		const runtime = await makeRuntime();
		try {
			const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));
			const tools = await source.tools();
			expect(tools).toHaveLength(10);
			for (const tool of tools) {
				expect(tool.name).toMatch(/^nb__/);
			}
			const names = tools.map((t) => t.name).sort();
			expect(names).toEqual([
				"nb__briefing",
				"nb__get_config",
				"nb__list_apps",
				"nb__list_artifacts",
				"nb__manage_identity",
				"nb__read_artifact",
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
				{ identity: null, workspaceId: TEST_WORKSPACE_ID },
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

	it("nb__set_model_config accepts thinking='enabled' without a budget", async () => {
		// A budget used to be mandatory here, because `enabled` with nothing to
		// size it fell through to the SDK's 1,024-token floor. It now resolves
		// to the default effort tier, which is well-defined on every provider —
		// so requiring a token count would be demanding a number the operator
		// has no reason to have.
		const workDir = join(testDir, `work-thinking-nobudget-${Date.now()}`);
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
			expect(result.isError).toBe(false);
			expect(runtime.getOperatorConfig().thinking).toBe("enabled");
			expect(runtime.getOperatorConfig().thinkingBudgetTokens).toBeUndefined();
		} finally {
			await runtime.shutdown();
		}
	});

	it("nb__set_model_config round-trips thinkingEffort to disk and the live runtime", async () => {
		const workDir = join(testDir, `work-thinking-effort-${Date.now()}`);
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
			expect(
				(await source.execute("set_model_config", { thinkingEffort: "xhigh" })).isError,
			).toBe(false);
			expect(runtime.getOperatorConfig().thinkingEffort).toBe("xhigh");
			const raw = JSON.parse(
				require("node:fs").readFileSync(deriveOverridePath(configPath), "utf-8"),
			);
			expect(raw.thinkingEffort).toBe("xhigh");

			// Clearing has to land on both disk and the live process. Reaching
			// only one leaves them disagreeing until restart.
			expect(
				(await source.execute("set_model_config", { clearThinkingEffort: true })).isError,
			).toBe(false);
			expect(runtime.getOperatorConfig().thinkingEffort).toBeUndefined();
			const cleared = JSON.parse(
				require("node:fs").readFileSync(deriveOverridePath(configPath), "utf-8"),
			);
			expect(cleared.thinkingEffort).toBeUndefined();

			// And it has to survive a restart. Writing to disk and patching the
			// live process is only two of the three stages — loadConfig maps the
			// file onto RuntimeConfig with an explicit field list, so a field
			// missing there is silently dropped on every boot and the setting
			// reverts. Asserting the first two stages is exactly what hid that.
			require("node:fs").writeFileSync(
				deriveOverridePath(configPath),
				JSON.stringify({ thinking: "enabled", thinkingEffort: "xhigh" }),
			);
			expect(loadConfig({ config: configPath }).thinkingEffort).toBe("xhigh");
		} finally {
			await runtime.shutdown();
		}
	});

	it("accepts every payload the Settings → Model panel can produce", async () => {
		// The boundary this crosses is the one that kept breaking: the web tests
		// assert the patch shape, the tool tests assert hand-written inputs, and
		// nothing fed one to the other. A depth control shipped inert three times
		// in that gap — most recently because the panel's own default-mode payload
		// was rejected outright, which failed the whole save including model slots.
		const workDir = join(testDir, `work-ui-payloads-${Date.now()}`);
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
			// Expectations are spelled out rather than derived from the same
			// predicates the panel uses — otherwise the assertion moves with the
			// bug and proves only that the code agrees with itself.
			const cases = [
				{ mode: THINKING_DEFAULT, effort: "high", budget: 8192, wantEffort: "high", wantBudget: 8192 },
				{ mode: THINKING_DEFAULT, effort: EFFORT_DEFAULT, budget: null, wantEffort: undefined, wantBudget: undefined },
				{ mode: "enabled", effort: "high", budget: 8192, wantEffort: "high", wantBudget: 8192 },
				{ mode: "enabled", effort: "max", budget: null, wantEffort: "max", wantBudget: undefined },
				{ mode: "enabled", effort: EFFORT_DEFAULT, budget: 4096, wantEffort: undefined, wantBudget: 4096 },
				{ mode: "off", effort: "high", budget: 8192, wantEffort: undefined, wantBudget: undefined },
				{ mode: "adaptive", effort: "high", budget: 8192, wantEffort: undefined, wantBudget: undefined },
			] as const;

			for (const c of cases) {
				const patch = thinkingPatchFor(c.mode, c.effort, c.budget);
				// Sent alongside the rest of the panel's payload, because a
				// rejection here also drops the model slots and limits.
				const result = await source.execute("set_model_config", {
					...patch,
					maxIterations: 12,
				});
				const label = `${JSON.stringify(c.mode)}/${c.effort}/${c.budget}`;
				expect(`${label}: ${result.isError}`).toBe(`${label}: false`);
				// The save landed in full, not just the thinking half.
				expect(runtime.getOperatorConfig().maxIterations).toBe(12);

				const cfg = runtime.getOperatorConfig();
				expect(`${label}: ${cfg.thinkingEffort}`).toBe(`${label}: ${c.wantEffort}`);
				expect(`${label}: ${cfg.thinkingBudgetTokens}`).toBe(`${label}: ${c.wantBudget}`);
			}
		} finally {
			await runtime.shutdown();
		}
	});

	it("nb__set_model_config rejects an unknown thinkingEffort", async () => {
		const workDir = join(testDir, `work-thinking-effort-bad-${Date.now()}`);
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
			const result = await source.execute("set_model_config", { thinkingEffort: "extreme" });
			expect(result.isError).toBe(true);
			// The schema enum rejects it at the tool boundary, before the
			// hand-written validator runs — same belt-and-braces `thinking` has.
			expect(extractText(result.content)).toContain("thinkingEffort");
			expect(runtime.getOperatorConfig().thinkingEffort).toBeUndefined();
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

	it("nb__set_model_config allows dropping a budget while keeping thinking='enabled'", async () => {
		// This combination used to be rejected: clearing the budget left
		// enabled with nothing to size it, and the SDK silently downgraded to
		// its 1,024-token floor. Now it falls back to the default effort tier,
		// which is the honest way to say "reason, at a normal depth" — so
		// dropping a token cap is a legitimate operation rather than a trap.
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
			expect(result.isError).toBe(false);
			const raw = JSON.parse(require("node:fs").readFileSync(overridePath, "utf-8"));
			expect(raw.thinking).toBe("enabled");
			expect(raw.thinkingBudgetTokens).toBeUndefined();
			// And the live process agrees with disk, not just the file.
			expect(runtime.getOperatorConfig().thinkingBudgetTokens).toBeUndefined();
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
			// The budget survives on purpose. It used to be deleted alongside the
			// mode on the grounds that it meant nothing without one; the resolver's
			// no-mode path now honors a bare budget, so cascading the delete would
			// silently discard a setting that is still in force. Clearing it is a
			// separate instruction (`clearThinkingBudget`).
			expect(raw.thinkingBudgetTokens).toBe(8192);
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

	it("nb__set_model_config accepts clearThinking=true alongside a budget", async () => {
		// Without this guard, the disk-side merge:
		//   - L430: input.thinking === null → delete existing.thinking + budget
		//   - L441: input.thinkingBudgetTokens !== undefined/null → re-set budget
		// produced { thinkingBudgetTokens: 4096 } with no thinking — an orphan
		// budget on disk. Live runtime stayed clean (handler passes both as
		// null to updateConfig when input.thinking === null), so the divergence
		// surfaces only on next restart. Reject the combination at the input
		// boundary instead.
		const workDir = join(testDir, `work-clear-orphan-${Date.now()}`);
		mkdirSync(workDir, { recursive: true });
		const configPath = join(workDir, "nimblebrain.json");
		const overridePath = deriveOverridePath(configPath);
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
			// Previously rejected as orphaning the budget. It no longer orphans
			// anything: with no mode set the resolver reads the budget and resolves
			// to `enabled` at it, so this is a coherent request — drop the mode
			// override, keep metering thinking at 4096.
			const result = await source.execute("set_model_config", {
				clearThinking: true,
				thinkingBudgetTokens: 4096,
			});
			expect(result.isError).toBe(false);
			expect(runtime.getOperatorConfig().thinkingBudgetTokens).toBe(4096);
			expect(extractText(result.content)).not.toContain(
				"Cannot set `thinkingBudgetTokens` while clearing `thinking`",
			);
			// And it landed on disk in that shape: budget present, mode absent.
			const raw = JSON.parse(require("node:fs").readFileSync(overridePath, "utf-8"));
			expect(raw.thinkingBudgetTokens).toBe(4096);
			expect(raw.thinking).toBeUndefined();
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

	describe("org model policy", () => {
		async function startWithPolicy(
			tag: string,
			allowed?: string[],
			extra?: Record<string, unknown>,
		) {
			const workDir = join(testDir, `work-${tag}-${Date.now()}`);
			mkdirSync(workDir, { recursive: true });
			// `configPath` is only where `set_model_config` writes its override
			// file; `Runtime.start` does not parse it — the CLI's `loadConfig`
			// does that and hands the result in. So the seed config goes here.
			const configPath = join(workDir, "nimblebrain.json");
			writeFileSync(configPath, JSON.stringify({ version: "1" }));
			const runtime = await Runtime.start({
				model: { provider: "custom", adapter: createEchoModel() },
				noDefaultBundles: true,
				workDir,
				configPath,
				logging: { disabled: true },
				models: { default: "anthropic:claude-sonnet-5", fast: "anthropic:claude-sonnet-5" },
				...(allowed ? { modelPolicy: { allowed } } : {}),
				...extra,
			});
			const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));
			return { runtime, source };
		}

		it("refuses a request for a model outside the list", async () => {
			const { runtime } = await startWithPolicy("gate", ["anthropic:claude-sonnet-5"]);
			try {
				expect(runtime.isModelPermitted("anthropic:claude-sonnet-5")).toBe(true);
				expect(runtime.isModelPermitted("anthropic:claude-opus-5")).toBe(false);
			} finally {
				await runtime.shutdown();
			}
		});

		it("publishes only the allowed models to the picker", async () => {
			const { runtime, source } = await startWithPolicy("menu", [
				"anthropic:claude-sonnet-5",
			]);
			try {
				const cfg = (await source.execute("get_config", {}))
					.structuredContent as Record<string, unknown>;
				const models = cfg.availableModels as Record<string, { id: string }[]>;
				expect(models.anthropic.map((m) => m.id)).toEqual(["claude-sonnet-5"]);
			} finally {
				await runtime.shutdown();
			}
		});

		it("rejects a list naming a model the deployment cannot offer", async () => {
			const { runtime, source } = await startWithPolicy("bad-entry");
			try {
				const res = await source.execute("set_model_config", {
					modelPolicy: { allowed: ["anthropic:claude-sonnet-5", "openai:text-embedding-3-large"] },
				});
				expect(res.isError).toBe(true);
				expect(extractText(res.content)).toContain("not a model this deployment can offer");
			} finally {
				await runtime.shutdown();
			}
		});

		it("rejects a list that excludes the default model", async () => {
			// Otherwise every new conversation resolves to something the org has
			// just forbidden, and nothing says so until a turn fails.
			const { runtime, source } = await startWithPolicy("strands-default");
			try {
				const res = await source.execute("set_model_config", {
					modelPolicy: { allowed: ["anthropic:claude-haiku-4-5-20251001"] },
				});
				expect(res.isError).toBe(true);
				expect(extractText(res.content)).toContain("which the default slot uses");
			} finally {
				await runtime.shutdown();
			}
		});

		it("survives a restart — the loader carries it", async () => {
			// The gap the suite missed: `set_model_config` enforced until the
			// process restarted, then failed open silently, because `loadConfig`
			// builds its config by an explicit field map.
			const workDir = join(testDir, `work-policy-restart-${Date.now()}`);
			mkdirSync(workDir, { recursive: true });
			const configPath = join(workDir, "nimblebrain.json");
			writeFileSync(
				configPath,
				JSON.stringify({
					version: "1",
					models: { default: "anthropic:claude-sonnet-5" },
					modelPolicy: { allowed: ["anthropic:claude-sonnet-5"] },
				}),
			);

			const loaded = loadConfig({ config: configPath });
			expect(loaded.modelPolicy?.allowed).toEqual(["anthropic:claude-sonnet-5"]);

			const runtime = await Runtime.start({
				...loaded,
				model: { provider: "custom", adapter: createEchoModel() },
				noDefaultBundles: true,
				workDir,
				logging: { disabled: true },
			});
			try {
				expect(runtime.isModelPermitted("anthropic:claude-opus-5")).toBe(false);
			} finally {
				await runtime.shutdown();
			}
		});

		it("judges the default slot as configured, not as the admin sees it", async () => {
			// The admin's own preference must not decide whether a policy strands
			// everyone else: tinted, an admin who prefers the one allowed model
			// passes a guard every other member fails.
			const { runtime, source } = await startWithPolicy("tinted-admin");
			try {
				const res = await runWithRequestContext(
					{
						identity: {
							id: "usr_admin",
							email: "a@example.com",
							displayName: "A",
							orgRole: "admin",
							preferences: { models: { default: "anthropic:claude-haiku-4-5-20251001" } },
						},
					},
					() =>
						source.execute("set_model_config", {
							modelPolicy: { allowed: ["anthropic:claude-haiku-4-5-20251001"] },
						}),
				);
				expect(res.isError).toBe(true);
				expect(extractText(res.content)).toContain("which the default slot uses");
			} finally {
				await runtime.shutdown();
			}
		});

		it("checks the fast slot too", async () => {
			const { runtime, source } = await startWithPolicy("fast-slot");
			try {
				const res = await source.execute("set_model_config", {
					models: { default: "anthropic:claude-sonnet-5", fast: "anthropic:claude-opus-5" },
					modelPolicy: { allowed: ["anthropic:claude-sonnet-5"] },
				});
				expect(res.isError).toBe(true);
				expect(extractText(res.content)).toContain("which the fast slot uses");
			} finally {
				await runtime.shutdown();
			}
		});

		it("catches a slot stranded through the deprecated defaultModel input", async () => {
			// `models` is not the only field that moves a slot. Judged on
			// `input.models` alone, this call was accepted and every member
			// without a preference then ran on a model the org had just forbidden.
			const { runtime, source } = await startWithPolicy("strand-via-default");
			try {
				const res = await source.execute("set_model_config", {
					defaultModel: "anthropic:claude-opus-5",
					modelPolicy: { allowed: ["anthropic:claude-sonnet-5"] },
				});
				expect(res.isError).toBe(true);
				expect(runtime.isModelPermitted(runtime.configuredModelSlots().default)).toBe(true);
			} finally {
				await runtime.shutdown();
			}
		});

		it("accepts repointing the default and narrowing to it in one call", async () => {
			// The mirror of the above: the guard must judge the post-write state,
			// not the prior one, or its own advice — "point that slot at an
			// allowed model in this call" — is impossible to follow.
			const { runtime, source } = await startWithPolicy("repoint-and-narrow");
			try {
				const res = await source.execute("set_model_config", {
					models: {
						default: "anthropic:claude-haiku-4-5-20251001",
						fast: "anthropic:claude-haiku-4-5-20251001",
					},
					modelPolicy: { allowed: ["anthropic:claude-haiku-4-5-20251001"] },
				});
				expect(`isError: ${res.isError} — ${extractText(res.content)}`).toContain(
					"isError: false",
				);
			} finally {
				await runtime.shutdown();
			}
		});

		it("reads the empty-string clear as a clear, not as a model", async () => {
			// `""` is the documented way to clear a slot; read as a model name it
			// resolved to a bare provider prefix and rejected itself.
			const { runtime, source } = await startWithPolicy(
				"clear-sentinel",
				["anthropic:claude-sonnet-5"],
				// A cleared slot falls back to `defaultModel`, not to `models.default`.
				{ defaultModel: "anthropic:claude-sonnet-5" },
			);
			try {
				const res = await source.execute("set_model_config", { models: { fast: "" } });
				expect(`isError: ${res.isError} — ${extractText(res.content)}`).toContain(
					"isError: false",
				);
				// Cleared, so it falls back to the default — which policy allows.
				expect(runtime.configuredModelSlots().fast).toBe("anthropic:claude-sonnet-5");
			} finally {
				await runtime.shutdown();
			}
		});

		it("catches a clear that strands a slot under a policy already in force", async () => {
			// The check runs on every write, not only one that sets a policy: with
			// a list already in place, clearing a slot drops it to a fallback that
			// the list may not contain.
			const { runtime, source } = await startWithPolicy("clear-strands", [
				"anthropic:claude-sonnet-5",
			]);
			try {
				const res = await source.execute("set_model_config", { models: { fast: "" } });
				expect(res.isError).toBe(true);
				expect(extractText(res.content)).toContain("which the fast slot uses");
			} finally {
				await runtime.shutdown();
			}
		});

		it("reports a config file whose policy strands its own slot", async () => {
			// The hand-written door. `set_model_config` rejects this; a config file
			// has nothing validating it against its own policy, so it booted
			// silently and every turn then resolved outside the published menu.
			const errors: { msg: string; data?: unknown }[] = [];
			const original = log.error;
			(log as { error: typeof log.error }).error = (msg: string, data?: unknown) => {
				errors.push({ msg, data });
			};
			try {
				const { runtime } = await startWithPolicy("file-strands", ["anthropic:claude-sonnet-5"], {
					models: { default: "anthropic:claude-opus-5", fast: "anthropic:claude-opus-5" },
				});
				try {
					const stranded = errors.filter((e) => e.msg.includes("outside this org's model policy"));
					expect(stranded.length).toBeGreaterThan(0);
					expect(JSON.stringify(stranded[0]?.data)).toContain("anthropic:claude-opus-5");
				} finally {
					await runtime.shutdown();
				}
			} finally {
				(log as { error: typeof log.error }).error = original;
			}
		});

		it("publishes the policy it filters by", async () => {
			const { runtime, source } = await startWithPolicy("publish", [
				"anthropic:claude-sonnet-5",
			]);
			try {
				const cfg = (await source.execute("get_config", {}))
					.structuredContent as Record<string, unknown>;
				expect(cfg.modelPolicy).toEqual({ allowed: ["anthropic:claude-sonnet-5"] });
			} finally {
				await runtime.shutdown();
			}
		});

		it("accepts a bare model id that policy allows in qualified form", async () => {
			// Bare ids are legal input; the policy check is an exact match, so it
			// has to compare resolved forms.
			const { runtime, source } = await startWithPolicy("bare-id", [
				"anthropic:claude-sonnet-5",
				"anthropic:claude-haiku-4-5-20251001",
			]);
			try {
				const res = await source.execute("set_model_config", {
					models: { fast: "claude-haiku-4-5-20251001" },
				});
				expect(`isError: ${res.isError} — ${extractText(res.content)}`).toBe(
					"isError: false — Configuration updated: models.",
				);
			} finally {
				await runtime.shutdown();
			}
		});

		it("a saved preference outside the list falls back without a migration", async () => {
			// Narrowing policy must not strand a user. `getModelSlots` re-tests the
			// stored choice on read, so it heals itself on the next turn.
			const { runtime } = await startWithPolicy("stale-pref", ["anthropic:claude-sonnet-5"]);
			try {
				const slots = await runWithRequestContext(
					{
						identity: {
							id: "usr_stale",
							email: "s@example.com",
							displayName: "S",
							orgRole: "member",
							preferences: { models: { default: "anthropic:claude-opus-5" } },
						},
					},
					() => runtime.getModelSlots(),
				);
				expect(slots.default).toBe("anthropic:claude-sonnet-5");
			} finally {
				await runtime.shutdown();
			}
		});
	});

	describe("operator-set vs resolved (config round-trip)", () => {
		/** A runtime whose config file sets nothing beyond `version`. */
		async function startBare(tag: string) {
			const workDir = join(testDir, `work-${tag}-${Date.now()}`);
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
			const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));
			return { runtime, source, overridePath: deriveOverridePath(configPath) };
		}

		function readOverride(overridePath: string): Record<string, unknown> {
			if (!existsSync(overridePath)) return {};
			return JSON.parse(require("node:fs").readFileSync(overridePath, "utf-8"));
		}

		it("publishes nothing the operator did not set, and the effective values separately", async () => {
			const { runtime, source, overridePath } = await startBare("bare-publish");
			try {
				const cfg = (await source.execute("get_config", {}))
					.structuredContent as Record<string, unknown>;

				// Nothing is set, so every editable key is absent — that is the
				// only way a client can tell "unset" from "set to the default".
				for (const key of [
					"models",
					"maxIterations",
					"maxInputTokens",
					"maxOutputTokens",
					"thinking",
					"thinkingEffort",
					"thinkingBudgetTokens",
				]) {
					expect(`${key}: ${key in cfg}`).toBe(`${key}: false`);
				}

				// The effective values are still published, for display.
				const resolved = cfg.resolved as Record<string, unknown>;
				expect(resolved.maxIterations).toBe(runtime.getMaxIterations());
				expect(resolved.maxOutputTokens).toBe(runtime.getMaxOutputTokens());
				expect((resolved.models as Record<string, string>).default).toBe(
					runtime.getDefaultModel(),
				);
				expect(readOverride(overridePath)).toEqual({});
			} finally {
				await runtime.shutdown();
			}
		});

		it("a save of exactly what get_config published pins nothing", async () => {
			// The #761 shape: a client renders the config, the operator changes
			// nothing, hits Save. Anything that lands on disk here is a default
			// silently converted into an override that outlives future changes
			// to that default.
			const { runtime, source, overridePath } = await startBare("noop-save");
			try {
				const cfg = (await source.execute("get_config", {}))
					.structuredContent as Record<string, unknown>;
				const { resolved, configuredProviders, availableModels, preferences, ...operatorSet } =
					cfg;

				const result = await source.execute("set_model_config", operatorSet);
				expect(result.isError).toBe(false);

				expect(readOverride(overridePath)).toEqual({});
				expect(runtime.getOperatorConfig()).toEqual({});
			} finally {
				await runtime.shutdown();
			}
		});

		it("a cleared limit leaves disk, process, and the published config agreeing", async () => {
			const { runtime, source, overridePath } = await startBare("clear-limit");
			try {
				const setResult = await source.execute("set_model_config", { maxIterations: 12 });
				expect(setResult.isError).toBe(false);
				expect(readOverride(overridePath).maxIterations).toBe(12);
				expect(runtime.getMaxIterations()).toBe(12);

				const clearResult = await source.execute("set_model_config", {
					clearMaxIterations: true,
				});
				expect(clearResult.isError).toBe(false);

				// Absent on disk, absent from the live process, and back to the
				// platform default for readers. A stored `null` would satisfy
				// none of these.
				expect("maxIterations" in readOverride(overridePath)).toBe(false);
				expect(runtime.getOperatorConfig().maxIterations).toBeUndefined();
				expect(runtime.getMaxIterations()).toBe(DEFAULT_MAX_ITERATIONS);

				const cfg = (await source.execute("get_config", {}))
					.structuredContent as Record<string, unknown>;
				expect("maxIterations" in cfg).toBe(false);
				expect((cfg.resolved as Record<string, unknown>).maxIterations).toBe(
					DEFAULT_MAX_ITERATIONS,
				);
			} finally {
				await runtime.shutdown();
			}
		});

		it("an empty string clears a model slot", async () => {
			const { runtime, source, overridePath } = await startBare("clear-slot");
			try {
				const beforeAnySet = runtime.getDefaultModel();
				await source.execute("set_model_config", {
					models: { default: "anthropic:claude-haiku-4-5-20251001" },
				});
				expect(runtime.getDefaultModel()).toBe("anthropic:claude-haiku-4-5-20251001");

				const clearResult = await source.execute("set_model_config", {
					models: { default: "" },
				});
				expect(clearResult.isError).toBe(false);

				// Not stored as `""`: the slot resolver falls back on nullish
				// only, so an empty string would resolve to a bare provider
				// prefix rather than the default model.
				expect(readOverride(overridePath).models).toBeUndefined();
				expect(runtime.getOperatorConfig().models).toBeUndefined();
				expect(runtime.getDefaultModel()).toBe(beforeAnySet);
			} finally {
				await runtime.shutdown();
			}
		});
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
			// Two readers because they answer two questions. The resolved
			// default qualifies bare ids in the catalog — the override on
			// disk is bare (`claude-haiku-4-5-20251001`) and the runtime
			// returns the catalog-qualified form, so downstream consumers
			// (cost, capabilities, providerOptions shape, log lines) see a
			// consistent shape. `thinking` is read back operator-set, exactly
			// as written.
			expect(r2.getDefaultModel()).toBe("anthropic:claude-haiku-4-5-20251001");
			expect(r2.getOperatorConfig().thinking).toBe("off");
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

	// ----------------------------------------------------------------------
	// Cache-on-failure contract
	// ----------------------------------------------------------------------
	//
	// The central rule this PR enforces: when generator.generate() throws,
	// the tool returns isError AND does not cache the failure. A future
	// refactor that accidentally moves cache.set above the await (or
	// inverts the conditional) would silently reintroduce the original
	// "stuck cached canned string" bug. This test locks that wiring.
	it("nb__briefing does not cache when the LLM call fails", async () => {
		const workDir = join(testDir, `work-briefing-cache-${Date.now()}`);
		mkdirSync(workDir, { recursive: true });
		const { model, getCalls } = createThrowingModel(new Error("LLM down for test"));

		const runtime = await Runtime.start({
			model: { provider: "custom", adapter: model },
			noDefaultBundles: true,
			workDir,
			logging: { disabled: true },
		});
		try {
			await provisionTestWorkspace(runtime);
			const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));

			// Stage 1 single-owner: the briefing now requires an
			// authenticated identity and filters the activity collector
			// to the caller's conversations. Identity in the request
			// context must match the seed's ownerId.
			const ctx = {
				identity: { id: "user_test", email: "test@example.com" } as never,
				workspaceId: TEST_WORKSPACE_ID,
			};

			// Seed a conversation so activity isn't empty — without this the
			// generator short-circuits to a "quiet day" briefing and the
			// model never gets invoked (the cache test would pass vacuously).
			await runWithRequestContext(ctx, async () => {
				// Seed in the focused workspace's owner partition so the briefing's
				// cross-workspace `listConversations({userId: "user_test"})` walk sees it.
				const store = runtime.workspaceConversationStore(TEST_WORKSPACE_ID, "user_test");
				await store.create({ ownerId: "user_test" });
			});

			// First call: model throws, tool returns isError.
			const first = await runWithRequestContext(ctx, () =>
				source.execute("briefing", {}),
			);
			expect(first.isError).toBe(true);
			expect(getCalls()).toBe(1);

			// Second call: if the first call had been cached, the tool would
			// short-circuit before invoking the generator and the model
			// counter would stay at 1. We expect it to climb to 2 — proving
			// the failure path skipped cache.set.
			const second = await runWithRequestContext(ctx, () =>
				source.execute("briefing", {}),
			);
			expect(second.isError).toBe(true);
			expect(getCalls()).toBe(2);
		} finally {
			await runtime.shutdown();
		}
	});

	// ----------------------------------------------------------------------
	// manage_identity authorization (STRICT workspace-scoped write gate)
	// ----------------------------------------------------------------------
	//
	// The gate now delegates to `canWriteWorkspaceScoped`: only a workspace
	// member with role "admin" may write the workspace identity override.
	// `orgRole` (org admin/owner) grants NO bypass — an org admin who is not
	// a workspace admin member is denied. Null identity (dev/unauthenticated
	// mode) is intentionally allowed through, matching prior behavior.
	function identityCtx(identity: unknown) {
		return {
			identity: identity as never,
			workspaceId: TEST_WORKSPACE_ID,
		};
	}

	it("nb__manage_identity denies an org admin/owner who is NOT a workspace member", async () => {
		const runtime = await makeRuntime();
		try {
			await provisionTestWorkspace(runtime);
			const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));

			// Org owner, but not a member of the active workspace.
			const orgOwner = {
				id: "usr_orgowner",
				email: "owner@example.com",
				displayName: "Org Owner",
				orgRole: "owner",
				preferences: {},
			};

			const result = await runWithRequestContext(identityCtx(orgOwner), () =>
				source.execute("manage_identity", { body: "should be denied" }),
			);
			expect(result.isError).toBe(true);
			expect(extractText(result.content)).toContain("Not a member");
		} finally {
			await runtime.shutdown();
		}
	});

	it("nb__manage_identity allows a workspace admin member (no orgRole bypass needed)", async () => {
		const runtime = await makeRuntime();
		try {
			await provisionTestWorkspace(runtime);
			await runtime.getWorkspaceStore().addMember(TEST_WORKSPACE_ID, "usr_wsadmin", "admin");
			const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));

			// Plain org member, but a workspace admin — allowed.
			const wsAdmin = {
				id: "usr_wsadmin",
				email: "wsadmin@example.com",
				displayName: "Workspace Admin",
				orgRole: "member",
				preferences: {},
			};

			const result = await runWithRequestContext(identityCtx(wsAdmin), () =>
				source.execute("manage_identity", { body: "hello identity" }),
			);
			expect(result.isError).toBe(false);
			const data = result.structuredContent as Record<string, unknown>;
			expect(data.success).toBe(true);
			const ws = await runtime.getWorkspaceStore().get(TEST_WORKSPACE_ID);
			expect(ws?.identity).toBe("hello identity");
		} finally {
			await runtime.shutdown();
		}
	});

	it("nb__manage_identity denies a workspace non-admin member even if they are an org owner", async () => {
		const runtime = await makeRuntime();
		try {
			await provisionTestWorkspace(runtime);
			await runtime.getWorkspaceStore().addMember(TEST_WORKSPACE_ID, "usr_wsmember", "member");
			const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));

			// Org owner AND a workspace member, but only "member" role — denied.
			// Proves orgRole grants no bypass for workspace-scoped writes.
			const wsMember = {
				id: "usr_wsmember",
				email: "member@example.com",
				displayName: "Workspace Member",
				orgRole: "owner",
				preferences: {},
			};

			const result = await runWithRequestContext(identityCtx(wsMember), () =>
				source.execute("manage_identity", { body: "should be denied" }),
			);
			expect(result.isError).toBe(true);
			expect(extractText(result.content)).toContain("workspace admin");
		} finally {
			await runtime.shutdown();
		}
	});

	it("nb__manage_identity allows a null identity through (dev/unauthenticated mode preserved)", async () => {
		const runtime = await makeRuntime();
		try {
			await provisionTestWorkspace(runtime);
			const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));

			const result = await runWithRequestContext(identityCtx(null), () =>
				source.execute("manage_identity", { body: "dev write" }),
			);
			expect(result.isError).toBe(false);
			const ws = await runtime.getWorkspaceStore().get(TEST_WORKSPACE_ID);
			expect(ws?.identity).toBe("dev write");
		} finally {
			await runtime.shutdown();
		}
	});
});
