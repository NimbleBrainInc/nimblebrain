import { describe, expect, it, afterAll } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { createCoreToolDefs } from "../../src/tools/core-source.ts";
import { makeInProcessSource } from "../helpers/in-process-source.ts";
import { extractText } from "../../src/engine/content-helpers.ts";
import { validateToolInput } from "../../src/tools/validate-input.ts";

const testDir = join(tmpdir(), `nimblebrain-get-config-${Date.now()}`);

afterAll(() => {
	if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

async function makeRuntime(overrides?: Record<string, unknown>): Promise<Runtime> {
	const workDir = join(testDir, `work-${Date.now()}`);
	mkdirSync(workDir, { recursive: true });
	return Runtime.start({
		model: { provider: "custom", adapter: createEchoModel() },
		noDefaultBundles: true,
		workDir,
		logging: { disabled: true },
		...overrides,
	});
}

describe("set_model_config maxOutputTokens override", () => {
	// The settings UI sends this payload on every save. Validating it against the
	// tool's own declared schema is the part that matters: a previous revision
	// cleared the override by sending `maxOutputTokens: null`, which the schema
	// types as `number` — so every save on an unconfigured install 400'd at the
	// REST boundary before reaching any of the logic below.
	function toolSchema(runtime: Runtime): Record<string, unknown> {
		// Read the declared schema straight off the tool def — this is the
		// contract the REST boundary compiles with Ajv before the handler runs.
		const def = createCoreToolDefs(runtime).find((t) => t.name === "set_model_config");
		if (!def) throw new Error("set_model_config not found");
		return def.inputSchema as Record<string, unknown>;
	}

	it("accepts the payloads the settings UI actually sends", async () => {
		const runtime = await makeRuntime();
		try {
			const schema = toolSchema(runtime);
			// unconfigured install: the field renders empty, so the save clears
			expect(validateToolInput({ clearMaxOutputTokens: true }, schema).valid).toBe(true);
			// operator typed a ceiling
			expect(validateToolInput({ maxOutputTokens: 8000 }, schema).valid).toBe(true);
			// a bare null is NOT the wire contract — this is the shape that broke
			// every save on an unconfigured install
			expect(validateToolInput({ maxOutputTokens: null }, schema).valid).toBe(false);
		} finally {
			await runtime.shutdown();
		}
	});

	it("round-trips set then clear through the tool", async () => {
		const overrideDir = join(testDir, `override-${Date.now()}`);
		mkdirSync(overrideDir, { recursive: true });
		const runtime = await makeRuntime({
			configOverridePath: join(overrideDir, "nimblebrain.overrides.json"),
		});
		try {
			const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));

			const set = await source.execute("set_model_config", { maxOutputTokens: 8000 });
			expect(set.isError).toBe(false);
			expect(runtime.getConfiguredMaxOutputTokens()).toBe(8000);
			const afterSet = await source.execute("get_config", {});
			expect((afterSet.structuredContent as Record<string, unknown>).maxOutputTokens).toBe(8000);

			const cleared = await source.execute("set_model_config", { clearMaxOutputTokens: true });
			expect(cleared.isError).toBe(false);

			// The DISK side matters independently: the live runtime and the
			// override file are written by separate code paths, and only the file
			// survives a restart. A clear that lands in memory but not on disk
			// reloads the override on the next boot and re-arms the derived
			// effort tier permanently — the exact failure this mechanism exists
			// to prevent.
			const onDisk = JSON.parse(
				readFileSync(join(overrideDir, "nimblebrain.overrides.json"), "utf8"),
			) as Record<string, unknown>;
			expect("maxOutputTokens" in onDisk).toBe(false);
			// gone from the live runtime, so resolveThinking stops deriving an
			// effort tier from it
			expect(runtime.getConfiguredMaxOutputTokens()).toBeUndefined();
			const afterClear = await source.execute("get_config", {});
			const cfg = afterClear.structuredContent as Record<string, unknown>;
			expect(cfg.maxOutputTokens).toBeUndefined();
			expect(typeof cfg.resolvedMaxOutputTokens).toBe("number");
		} finally {
			await runtime.shutdown();
		}
	});

	it("rejects setting and clearing at once", async () => {
		const overrideDir = join(testDir, `override-x-${Date.now()}`);
		mkdirSync(overrideDir, { recursive: true });
		const runtime = await makeRuntime({
			configOverridePath: join(overrideDir, "nimblebrain.overrides.json"),
		});
		try {
			const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));
			const res = await source.execute("set_model_config", {
				maxOutputTokens: 8000,
				clearMaxOutputTokens: true,
			});
			expect(res.isError).toBe(true);
		} finally {
			await runtime.shutdown();
		}
	});
});

describe("get_config tool", () => {
	it("returns all expected fields", async () => {
		const runtime = await makeRuntime();
		try {
			const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));
			const result = await source.execute("get_config", {});
			expect(result.isError).toBe(false);
			const config = result.structuredContent as Record<string, unknown>;
			expect(typeof config.defaultModel).toBe("string");
			expect((config.defaultModel as string).length).toBeGreaterThan(0);
			expect(Array.isArray(config.configuredProviders)).toBe(true);
			expect((config.configuredProviders as string[]).length).toBeGreaterThan(0);
			expect(typeof config.maxIterations).toBe("number");
			expect(config.maxIterations).toBeGreaterThan(0);
			expect(typeof config.maxInputTokens).toBe("number");
			expect((config.maxInputTokens as number)).toBeGreaterThan(0);
			// The resolved ceiling is reported for display, but `maxOutputTokens`
			// itself is absent unless the operator set one. Reporting it would let
			// the settings UI echo it back on save, which flips the field from
			// unset to set and makes `resolveThinking` derive a thinking budget —
			// `effort: "max"` on every call for an adaptive-only model.
			expect(typeof config.resolvedMaxOutputTokens).toBe("number");
			expect((config.resolvedMaxOutputTokens as number)).toBeGreaterThan(0);
			expect(config.maxOutputTokens).toBeUndefined();
		} finally {
			await runtime.shutdown();
		}
	});

	it("returns correct default model from config", async () => {
		const runtime = await makeRuntime({ defaultModel: "anthropic:claude-sonnet-4-6" });
		try {
			const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));
			const result = await source.execute("get_config", {});
			const config = result.structuredContent as Record<string, unknown>;
			expect(config.defaultModel).toBe("anthropic:claude-sonnet-4-6");
		} finally {
			await runtime.shutdown();
		}
	});

	it("configuredProviders reflects providers from config", async () => {
		const runtime = await makeRuntime({
			providers: { anthropic: {}, openai: {} },
		});
		try {
			const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));
			const result = await source.execute("get_config", {});
			const config = result.structuredContent as Record<string, unknown>;
			expect(config.configuredProviders).toContain("anthropic");
			expect(config.configuredProviders).toContain("openai");
			expect(config.configuredProviders).not.toContain("google");
		} finally {
			await runtime.shutdown();
		}
	});

	it("defaults to anthropic when no providers configured", async () => {
		const runtime = await makeRuntime();
		try {
			const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));
			const result = await source.execute("get_config", {});
			const config = result.structuredContent as Record<string, unknown>;
			expect(config.configuredProviders).toContain("anthropic");
		} finally {
			await runtime.shutdown();
		}
	});

	it("set_config then get_config reflects the change", async () => {
		const workDir = join(testDir, `work-setget-${Date.now()}`);
		mkdirSync(workDir, { recursive: true });
		const configPath = join(workDir, "nimblebrain.json");
		const { writeFileSync } = await import("node:fs");
		writeFileSync(configPath, JSON.stringify({
			version: "1",
			defaultModel: "anthropic:claude-sonnet-4-6",
			providers: { anthropic: {}, openai: {} },
		}));

		const runtime = await makeRuntime({
			defaultModel: "anthropic:claude-sonnet-4-6",
			providers: { anthropic: {}, openai: {} },
			workDir,
			configPath,
		});
		try {
			const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));

			const setResult = await source.execute("set_model_config", { defaultModel: "openai:gpt-4o" });
			expect(setResult.isError).toBe(false);

			const getResult = await source.execute("get_config", {});
			const config = getResult.structuredContent as Record<string, unknown>;
			expect(config.defaultModel).toBe("openai:gpt-4o");
		} finally {
			await runtime.shutdown();
		}
	});

	it("set_config rejects model from unconfigured provider", async () => {
		const workDir = join(testDir, `work-reject-${Date.now()}`);
		mkdirSync(workDir, { recursive: true });
		const configPath = join(workDir, "nimblebrain.json");
		const { writeFileSync } = await import("node:fs");
		writeFileSync(configPath, JSON.stringify({
			version: "1",
			providers: { anthropic: {} },
		}));

		const runtime = await makeRuntime({
			providers: { anthropic: {} },
			workDir,
			configPath,
		});
		try {
			const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));
			const result = await source.execute("set_model_config", { defaultModel: "openai:gpt-4o" });
			expect(result.isError).toBe(true);
			expect(extractText(result.content)).toContain("Invalid model");
		} finally {
			await runtime.shutdown();
		}
	});
});
