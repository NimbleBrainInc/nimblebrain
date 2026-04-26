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

			// Verify file was written
			const raw = JSON.parse(
				require("node:fs").readFileSync(configPath, "utf-8"),
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

			// File must be valid JSON and preserve existing fields
			const raw = JSON.parse(
				require("node:fs").readFileSync(configPath, "utf-8"),
			);
			expect(raw.version).toBe("1");
			expect(raw.maxIterations).toBe(5);
			expect(raw.maxOutputTokens).toBe(8192);
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
			expect(extractText(result.content)).toContain("No config file path");
		} finally {
			await runtime.shutdown();
		}
	});
});
