import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractText } from "../../src/engine/content-helpers.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { runWithRequestContext } from "../../src/runtime/request-context.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createCoreToolDefs } from "../../src/tools/core-source.ts";
import { asDevUser, devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { makeInProcessSource } from "../helpers/in-process-source.ts";

const testDir = join(tmpdir(), `nimblebrain-get-config-${Date.now()}`);

afterAll(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

async function makeRuntime(overrides?: Record<string, unknown>): Promise<Runtime> {
  const workDir = join(testDir, `work-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });
  return Runtime.start({
    identityProvider: devProvider,
    languageModel: createEchoModel(),
    workDir,
    logging: { disabled: true },
    ...overrides,
  });
}

describe("get_config tool", () => {
  it("returns all expected fields", async () => {
    const runtime = await makeRuntime();
    try {
      const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));
      const result = await asDevUser(() => source.execute("get_config", {}));
      expect(result.isError).toBe(false);
      const config = result.structuredContent as Record<string, unknown>;
      expect(Array.isArray(config.configuredProviders)).toBe(true);
      expect((config.configuredProviders as string[]).length).toBeGreaterThan(0);

      // The limits live under `resolved`: this runtime sets none of them,
      // and an effective value published at the top level would read as
      // an operator override the moment a client saved it back.
      const resolved = config.resolved as Record<string, unknown>;
      const models = resolved.models as Record<string, string>;
      expect(typeof models.default).toBe("string");
      expect(models.default.length).toBeGreaterThan(0);
      expect(typeof resolved.maxIterations).toBe("number");
      expect(resolved.maxIterations).toBeGreaterThan(0);
      expect(typeof resolved.maxInputTokens).toBe("number");
      expect(resolved.maxInputTokens as number).toBeGreaterThan(0);
      expect(typeof resolved.maxOutputTokens).toBe("number");
      expect(resolved.maxOutputTokens as number).toBeGreaterThan(0);
    } finally {
      await runtime.shutdown();
    }
  });

  it("reports a theme only when the user has set one", async () => {
    // The shell applies any theme get_config reports. Filling an unset one
    // with "system" overrode the theme the browser held each time a
    // config.changed event made the shell re-read this.
    const runtime = await makeRuntime();
    try {
      const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));
      const prefs = async (identity: typeof DEV_IDENTITY) =>
        (
          (await runWithRequestContext({ identity }, () => source.execute("get_config", {})))
            .structuredContent as { preferences: Record<string, unknown> }
        ).preferences;

      expect("theme" in (await prefs(DEV_IDENTITY))).toBe(false);
      expect((await prefs({ ...DEV_IDENTITY, preferences: { theme: "light" } })).theme).toBe(
        "light",
      );
    } finally {
      await runtime.shutdown();
    }
  });

  it("returns correct default model from config", async () => {
    const runtime = await makeRuntime({ models: { default: "anthropic:claude-sonnet-4-6" } });
    try {
      const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));
      const result = await asDevUser(() => source.execute("get_config", {}));
      const config = result.structuredContent as Record<string, unknown>;
      const resolved = config.resolved as { models: Record<string, string> };
      expect(resolved.models.default).toBe("anthropic:claude-sonnet-4-6");
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
      const result = await asDevUser(() => source.execute("get_config", {}));
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
      const result = await asDevUser(() => source.execute("get_config", {}));
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
    writeFileSync(
      configPath,
      JSON.stringify({
        version: "1",
        models: { default: "anthropic:claude-sonnet-4-6" },
        providers: { anthropic: {}, openai: {} },
      }),
    );

    const runtime = await makeRuntime({
      models: { default: "anthropic:claude-sonnet-4-6" },
      providers: { anthropic: {}, openai: {} },
      workDir,
      configPath,
    });
    try {
      const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));

      const setResult = await asDevUser(() =>
        source.execute("set_model_config", { models: { default: "openai:gpt-4o" } }),
      );
      expect(setResult.isError).toBe(false);

      const getResult = await asDevUser(() => source.execute("get_config", {}));
      const config = getResult.structuredContent as Record<string, unknown>;
      const resolved = config.resolved as { models: Record<string, string> };
      expect(resolved.models.default).toBe("openai:gpt-4o");
    } finally {
      await runtime.shutdown();
    }
  });

  it("set_config rejects model from unconfigured provider", async () => {
    const workDir = join(testDir, `work-reject-${Date.now()}`);
    mkdirSync(workDir, { recursive: true });
    const configPath = join(workDir, "nimblebrain.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      configPath,
      JSON.stringify({
        version: "1",
        providers: { anthropic: {} },
      }),
    );

    const runtime = await makeRuntime({
      providers: { anthropic: {} },
      workDir,
      configPath,
    });
    try {
      const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));
      const result = await asDevUser(() =>
        source.execute("set_model_config", { models: { default: "openai:gpt-4o" } }),
      );
      expect(result.isError).toBe(true);
      expect(extractText(result.content)).toContain("Invalid model");
    } finally {
      await runtime.shutdown();
    }
  });
});
