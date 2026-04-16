import { describe, expect, it, afterAll } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { createCoreToolDefs } from "../../src/tools/core-source.ts";
import { InlineSource } from "../../src/tools/inline-source.ts";
import { extractText } from "../../src/engine/content-helpers.ts";

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

describe("get_config tool", () => {
	it("returns all expected fields", async () => {
		const runtime = await makeRuntime();
		try {
			const source = new InlineSource("nb", createCoreToolDefs(runtime));
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
			expect(typeof config.maxOutputTokens).toBe("number");
			expect((config.maxOutputTokens as number)).toBeGreaterThan(0);
		} finally {
			await runtime.shutdown();
		}
	});

	it("returns correct default model from config", async () => {
		const runtime = await makeRuntime({ defaultModel: "anthropic:claude-sonnet-4-6" });
		try {
			const source = new InlineSource("nb", createCoreToolDefs(runtime));
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
			const source = new InlineSource("nb", createCoreToolDefs(runtime));
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
			const source = new InlineSource("nb", createCoreToolDefs(runtime));
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
			const source = new InlineSource("nb", createCoreToolDefs(runtime));

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
			const source = new InlineSource("nb", createCoreToolDefs(runtime));
			const result = await source.execute("set_model_config", { defaultModel: "openai:gpt-4o" });
			expect(result.isError).toBe(true);
			expect(extractText(result.content)).toContain("Invalid model");
		} finally {
			await runtime.shutdown();
		}
	});
});
