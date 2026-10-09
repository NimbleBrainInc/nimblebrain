import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/cli/config.ts";
import { deriveOverridePath, OVERRIDE_WRITABLE_KEYS } from "../../src/config/overrides.ts";
import { extractText } from "../../src/engine/content-helpers.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { DEFAULT_MAX_ITERATIONS } from "../../src/limits.ts";
import { log } from "../../src/observability/log.ts";
import { runWithRequestContext } from "../../src/runtime/request-context.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createCoreToolDefs } from "../../src/tools/core-source.ts";
import type { McpSource } from "../../src/tools/mcp-source.ts";
import {
  EFFORT_DEFAULT,
  type ModelConfigField,
  type ModelConfigValues,
  modelConfigPatch,
  THINKING_DEFAULT,
} from "../../web/src/pages/settings/model-config-patch.ts";
import { asDevUser, devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { facetEntry, startFacetsSource } from "../helpers/facets-server.ts";
import { makeInProcessSource } from "../helpers/in-process-source.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

/**
 * Install a running app in the test workspace whose server advertises the
 * facets extension and lists one facet, served over a real MCP connection.
 */
async function seedFacetApp(runtime: Runtime): Promise<McpSource> {
  const serverName = "facet_app";
  const url = `https://${serverName}.example.com/mcp`;
  await runtime.getLifecycle().seedInstance(
    serverName,
    url,
    // A static credential seeds the connection `running`; a bare URL would
    // seed `not_authenticated`, and the collector skips it.
    {
      url,
      serverName,
      transport: { type: "streamable-http", auth: { type: "bearer", token: "t" } },
    },
    {
      version: "1.0.0",
      ui: {
        placements: [
          { slot: "sidebar.apps", resourceUri: "ui://facet_app/main", route: "@acme/facet-app" },
        ],
      },
    },
    TEST_WORKSPACE_ID,
  );
  const { source } = await startFacetsSource(serverName, {
    resources: () => [facetEntry("overdue", "Follow-ups overdue")],
    read: () => '{"count": 3}',
  });
  runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID).addSource(source);
  return source;
}

const testDir = join(tmpdir(), `nimblebrain-core-source-${Date.now()}`);

afterAll(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

async function makeRuntime(): Promise<Runtime> {
  const workDir = join(testDir, `work-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });
  return Runtime.start({
    identityProvider: devProvider,
    languageModel: createEchoModel(),
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
        "nb__list_artifacts",
        "nb__open_app",
        "nb__read_artifact",
        "nb__set_model_config",
        "nb__set_preferences",
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
        expect((tool.inputSchema as Record<string, unknown>).type).toBe("object");
      }
    } finally {
      await runtime.shutdown();
    }
  });

  it("nb__workspace_info returns the platform version", async () => {
    const runtime = await makeRuntime();
    try {
      await provisionTestWorkspace(runtime);
      const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));
      const result = await runWithRequestContext(
        { identity: DEV_IDENTITY, workspaceId: TEST_WORKSPACE_ID },
        () => source.execute("workspace_info", {}),
      );
      expect(result.isError).toBe(false);
      const data = result.structuredContent as Record<string, unknown>;
      expect(typeof data.version).toBe("string");
    } finally {
      await runtime.shutdown();
    }
  });

  it("execute returns error for unknown tool name", async () => {
    const runtime = await makeRuntime();
    try {
      const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));
      const result = await asDevUser(() => source.execute("nonexistent_tool", {}));
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
      identityProvider: devProvider,
      languageModel: createEchoModel(),
      workDir,
      configPath,
      logging: { disabled: true },
    });
    try {
      const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));
      const result = await asDevUser(() =>
        source.execute("set_model_config", {
          models: { default: "claude-haiku-4-5-20251001" },
        }),
      );
      expect(result.isError).toBe(false);
      const data = result.structuredContent as Record<string, unknown>;
      expect(data.success).toBe(true);

      // Verify the override file (NOT the seed) was written.
      const raw = JSON.parse(
        require("node:fs").readFileSync(deriveOverridePath(configPath), "utf-8"),
      );
      expect(raw.models).toEqual({ default: "claude-haiku-4-5-20251001" });
    } finally {
      await runtime.shutdown();
    }
  });

  it("nb__set_model_config with no identity is refused, and nothing is written", async () => {
    const workDir = join(testDir, `work-noidentity-${Date.now()}`);
    mkdirSync(workDir, { recursive: true });
    const configPath = join(workDir, "nimblebrain.json");
    writeFileSync(configPath, JSON.stringify({ version: "1" }));

    const runtime = await Runtime.start({
      identityProvider: devProvider,
      languageModel: createEchoModel(),
      workDir,
      configPath,
      logging: { disabled: true },
    });
    try {
      const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));
      const result = await source.execute("set_model_config", {
        models: { default: "claude-haiku-4-5-20251001" },
      });
      expect(result.isError).toBe(true);
      expect(extractText(result.content)).toContain("requires an authenticated identity");
      expect(existsSync(deriveOverridePath(configPath))).toBe(false);
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
      identityProvider: devProvider,
      languageModel: createEchoModel(),
      workDir,
      configPath,
      logging: { disabled: true },
    });
    try {
      const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));
      const result = await asDevUser(() =>
        source.execute("set_model_config", {
          models: { default: "unconfigured-provider:some-model" },
        }),
      );
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
      identityProvider: devProvider,
      languageModel: createEchoModel(),
      workDir,
      configPath,
      logging: { disabled: true },
    });
    try {
      const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));
      const result = await asDevUser(() =>
        source.execute("set_model_config", {
          maxIterations: 60,
        }),
      );
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
      identityProvider: devProvider,
      languageModel: createEchoModel(),
      workDir,
      configPath,
      logging: { disabled: true },
    });
    try {
      const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));
      await asDevUser(() =>
        source.execute("set_model_config", {
          maxOutputTokens: 8192,
        }),
      );

      // Override file must be valid JSON with only the field we wrote.
      // The seed file is NOT touched — it stays Helm-managed.
      const overrideRaw = JSON.parse(
        require("node:fs").readFileSync(deriveOverridePath(configPath), "utf-8"),
      );
      expect(overrideRaw.maxOutputTokens).toBe(8192);
      const seedRaw = JSON.parse(require("node:fs").readFileSync(configPath, "utf-8"));
      expect(seedRaw.version).toBe("1");
      expect(seedRaw.maxIterations).toBe(5);
      expect(seedRaw.maxOutputTokens).toBeUndefined();
    } finally {
      await runtime.shutdown();
    }
  });

  it("nb__set_model_config accepts thinking='enabled' without a budget", async () => {
    // A budget is not mandatory: `enabled` with nothing to size it
    // resolves to the default effort tier rather than the SDK's 1,024-token
    // floor, and that tier is well-defined on every provider —
    // so requiring a token count would be demanding a number the operator
    // has no reason to have.
    const workDir = join(testDir, `work-thinking-nobudget-${Date.now()}`);
    mkdirSync(workDir, { recursive: true });
    const configPath = join(workDir, "nimblebrain.json");
    writeFileSync(configPath, JSON.stringify({ version: "1" }));

    const runtime = await Runtime.start({
      identityProvider: devProvider,
      languageModel: createEchoModel(),
      workDir,
      configPath,
      logging: { disabled: true },
    });
    try {
      const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));
      const result = await asDevUser(() =>
        source.execute("set_model_config", {
          thinking: "enabled",
        }),
      );
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
      identityProvider: devProvider,
      languageModel: createEchoModel(),
      workDir,
      configPath,
      logging: { disabled: true },
    });
    try {
      const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));
      expect(
        (await asDevUser(() => source.execute("set_model_config", { thinkingEffort: "xhigh" })))
          .isError,
      ).toBe(false);
      expect(runtime.getOperatorConfig().thinkingEffort).toBe("xhigh");
      const raw = JSON.parse(
        require("node:fs").readFileSync(deriveOverridePath(configPath), "utf-8"),
      );
      expect(raw.thinkingEffort).toBe("xhigh");

      // Clearing has to land on both disk and the live process. Reaching
      // only one leaves them disagreeing until restart.
      expect(
        (await asDevUser(() => source.execute("set_model_config", { thinkingEffort: null })))
          .isError,
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
    // in that gap. The panel saves one field at a time, so each step sends one
    // field's patch and checks that field changed and the others did not.
    const workDir = join(testDir, `work-ui-payloads-${Date.now()}`);
    mkdirSync(workDir, { recursive: true });
    const configPath = join(workDir, "nimblebrain.json");
    writeFileSync(configPath, JSON.stringify({ version: "1" }));

    const runtime = await Runtime.start({
      identityProvider: devProvider,
      languageModel: createEchoModel(),
      workDir,
      configPath,
      logging: { disabled: true },
    });
    try {
      const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));
      // Expectations are spelled out rather than derived from the same
      // predicates the panel uses — otherwise the assertion moves with the
      // bug and proves only that the code agrees with itself.
      const steps: Array<{
        field: ModelConfigField;
        value: string;
        want: Partial<Record<string, unknown>>;
      }> = [
        { field: "maxIterations", value: "12", want: { maxIterations: 12 } },
        { field: "thinking", value: "enabled", want: { thinking: "enabled" } },
        { field: "thinkingEffort", value: "high", want: { thinkingEffort: "high" } },
        { field: "thinkingBudgetTokens", value: "8192", want: { thinkingBudgetTokens: 8192 } },
        // Changing the mode leaves the depth and budget stored.
        {
          field: "thinking",
          value: "adaptive",
          want: { thinking: "adaptive", thinkingEffort: "high", thinkingBudgetTokens: 8192 },
        },
        { field: "thinking", value: THINKING_DEFAULT, want: { thinking: undefined } },
        { field: "thinkingEffort", value: EFFORT_DEFAULT, want: { thinkingEffort: undefined } },
        { field: "thinkingBudgetTokens", value: "", want: { thinkingBudgetTokens: undefined } },
        { field: "fastModel", value: "", want: { models: undefined } },
        { field: "maxIterations", value: "", want: { maxIterations: undefined } },
      ];

      for (const step of steps) {
        const before = { ...runtime.getOperatorConfig() } as Record<string, unknown>;
        const patch = modelConfigPatch(
          step.field,
          step.value as ModelConfigValues[typeof step.field],
        );
        const result = await asDevUser(() => source.execute("set_model_config", patch));
        const label = `${step.field}=${JSON.stringify(step.value)}`;
        expect(`${label}: ${result.isError}`).toBe(`${label}: false`);

        const after = runtime.getOperatorConfig() as Record<string, unknown>;
        for (const [key, want] of Object.entries(step.want)) {
          expect(`${label} → ${key}: ${JSON.stringify(after[key])}`).toBe(
            `${label} → ${key}: ${JSON.stringify(want)}`,
          );
        }
        // Nothing beyond the step's own fields moved.
        for (const key of ["maxIterations", "thinking", "thinkingEffort", "thinkingBudgetTokens"]) {
          if (key in step.want) continue;
          expect(`${label} → ${key}: ${JSON.stringify(after[key])}`).toBe(
            `${label} → ${key}: ${JSON.stringify(before[key])}`,
          );
        }
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
      identityProvider: devProvider,
      languageModel: createEchoModel(),
      workDir,
      configPath,
      logging: { disabled: true },
    });
    try {
      const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));
      const result = await asDevUser(() =>
        source.execute("set_model_config", { thinkingEffort: "extreme" }),
      );
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
      identityProvider: devProvider,
      languageModel: createEchoModel(),
      workDir,
      configPath,
      logging: { disabled: true },
    });
    try {
      const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));
      const result = await asDevUser(() =>
        source.execute("set_model_config", {
          thinking: "enabled",
          thinkingBudgetTokens: 8192,
        }),
      );
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
    // Clearing the budget leaves enabled with nothing to size it, so it
    // falls back to the default effort tier rather than the SDK's silent
    // 1,024-token floor. That is the honest way to say "reason, at a normal
    // depth" — so dropping a token cap is a legitimate operation rather
    // than a trap.
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
      identityProvider: devProvider,
      languageModel: createEchoModel(),
      workDir,
      configPath,
      logging: { disabled: true },
    });
    try {
      const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));
      const result = await asDevUser(() =>
        source.execute("set_model_config", {
          thinking: "enabled",
          thinkingBudgetTokens: null,
        }),
      );
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

  it("nb__set_model_config thinking=null clears the mode and keeps the budget", async () => {
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
      identityProvider: devProvider,
      languageModel: createEchoModel(),
      workDir,
      configPath,
      logging: { disabled: true },
    });
    try {
      const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));
      const result = await asDevUser(() =>
        source.execute("set_model_config", {
          thinking: null,
        }),
      );
      expect(result.isError).toBe(false);
      const raw = JSON.parse(require("node:fs").readFileSync(overridePath, "utf-8"));
      expect(raw.thinking).toBeUndefined();
      // The budget survives on purpose. The resolver's no-mode path honors a
      // bare budget, so cascading the delete would
      // silently discard a setting that is still in force. Clearing it is a
      // separate instruction (`thinkingBudgetTokens: null`).
      expect(raw.thinkingBudgetTokens).toBe(8192);
    } finally {
      await runtime.shutdown();
    }
  });

  it("nb__set_model_config thinkingBudgetTokens=null clears just the budget", async () => {
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
      identityProvider: devProvider,
      languageModel: createEchoModel(),
      workDir,
      configPath,
      logging: { disabled: true },
    });
    try {
      const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));
      const result = await asDevUser(() =>
        source.execute("set_model_config", {
          thinkingBudgetTokens: null,
        }),
      );
      expect(result.isError).toBe(false);
      const raw = JSON.parse(require("node:fs").readFileSync(overridePath, "utf-8"));
      expect(raw.thinking).toBe("adaptive");
      expect(raw.thinkingBudgetTokens).toBeUndefined();
    } finally {
      await runtime.shutdown();
    }
  });

  it("nb__set_model_config accepts thinking=null alongside a budget", async () => {
    const workDir = join(testDir, `work-clear-orphan-${Date.now()}`);
    mkdirSync(workDir, { recursive: true });
    const configPath = join(workDir, "nimblebrain.json");
    const overridePath = deriveOverridePath(configPath);
    writeFileSync(configPath, JSON.stringify({ version: "1" }));

    const runtime = await Runtime.start({
      identityProvider: devProvider,
      languageModel: createEchoModel(),
      workDir,
      configPath,
      logging: { disabled: true },
    });
    try {
      const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));
      // With no mode set the resolver reads the budget and resolves to
      // `enabled` at it, so this is a coherent request — drop the mode
      // override, keep metering thinking at 4096.
      const result = await asDevUser(() =>
        source.execute("set_model_config", {
          thinking: null,
          thinkingBudgetTokens: 4096,
        }),
      );
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

  it("nb__set_model_config rejects a field it does not write", async () => {
    const workDir = join(testDir, `work-unwritable-field-${Date.now()}`);
    mkdirSync(workDir, { recursive: true });
    const configPath = join(workDir, "nimblebrain.json");
    writeFileSync(configPath, JSON.stringify({}));

    const runtime = await Runtime.start({
      identityProvider: devProvider,
      languageModel: createEchoModel(),
      workDir,
      configPath,
      logging: { disabled: true },
    });
    try {
      const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));
      const result = await asDevUser(() => source.execute("set_model_config", { notAField: true }));
      expect(result.isError).toBe(true);
      expect(extractText(result.content)).toContain("`notAField` is not a field this tool writes");
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
        identityProvider: devProvider,
        languageModel: createEchoModel(),
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

    it("drops a stale override key and says so, rather than reporting it applied", async () => {
      // Both halves matter: the seed reclaims the field, and the startup line
      // names it as ignored. That line is what someone reads when a setting
      // is not taking effect, so reporting it as applied sends them the wrong
      // way.
      const workDir = join(testDir, `work-stale-override-${Date.now()}`);
      mkdirSync(workDir, { recursive: true });
      const configPath = join(workDir, "nimblebrain.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          version: "1",
          modelPolicy: { allowed: ["anthropic:claude-sonnet-5"] },
          maxIterations: 10,
        }),
      );
      // A policy written while the tool could still write one.
      writeFileSync(
        deriveOverridePath(configPath),
        JSON.stringify({
          modelPolicy: { allowed: ["anthropic:claude-opus-5"] },
          maxIterations: 25,
        }),
      );

      // Captured per level: an applied override is a normal-boot notice, a
      // dropped key is a warning, and neither is an error.
      const lines: Record<"info" | "warn" | "error", string[]> = { info: [], warn: [], error: [] };
      const original = { info: log.info, warn: log.warn, error: log.error };
      const sink = log as Record<"info" | "warn" | "error", (msg: string) => void>;
      for (const level of ["info", "warn", "error"] as const) {
        sink[level] = (msg: string) => {
          lines[level].push(msg);
        };
      }
      let loaded: ReturnType<typeof loadConfig>;
      try {
        loaded = loadConfig({ config: configPath });
      } finally {
        Object.assign(log, original);
      }

      // The seed reclaims the key with no writer; the writable one still wins.
      expect(loaded.modelPolicy?.allowed).toEqual(["anthropic:claude-sonnet-5"]);
      expect(loaded.maxIterations).toBe(25);

      expect(
        lines.warn.some((l) => l.includes("Ignored 1 override key") && l.includes("modelPolicy")),
      ).toBe(true);
      expect(
        lines.info.some(
          (l) => l.includes("Applied 1 runtime override") && l.includes("maxIterations"),
        ),
      ).toBe(true);
      expect(lines.error).toEqual([]);
    });

    it("writes no override key the loader would drop", async () => {
      // The drift this guards: a field added to the tool but not to the
      // loader's writable set is written, then silently dropped on the next
      // boot. Asserted against what the writer actually puts on disk — a
      // list compared to a copy of itself cannot detect drift from the tool.
      const { runtime, source } = await startWithPolicy("no-dropped-keys");
      try {
        const res = await asDevUser(() =>
          source.execute("set_model_config", {
            models: { default: "anthropic:claude-sonnet-5", fast: "anthropic:claude-sonnet-5" },
            maxIterations: 12,
            maxInputTokens: 400000,
            maxOutputTokens: 8192,
            thinking: "enabled",
            thinkingEffort: "high",
            thinkingBudgetTokens: 4096,
          }),
        );
        expect(res.isError).toBe(false);

        const written = JSON.parse(
          require("node:fs").readFileSync(runtime.getConfigOverridePath() as string, "utf-8"),
        ) as Record<string, unknown>;
        const droppable = Object.keys(written).filter(
          (k) => !(OVERRIDE_WRITABLE_KEYS as readonly string[]).includes(k),
        );
        expect(`dropped-on-next-boot: ${droppable.join(", ")}`).toBe("dropped-on-next-boot: ");
      } finally {
        await runtime.shutdown();
      }
    });

    it("refuses to pretend it set a policy it does not write", async () => {
      // The summary line is built from the caller's keys, so an unwritten
      // field was reported as applied: an admin narrowing the allowlist was
      // told it worked while nothing changed.
      const { runtime, source } = await startWithPolicy("unwritable");
      try {
        const res = await asDevUser(() =>
          source.execute("set_model_config", {
            modelPolicy: { allowed: ["anthropic:claude-sonnet-5"] },
          }),
        );
        expect(res.isError).toBe(true);
        expect(extractText(res.content)).toContain("nimblebrain.json");
      } finally {
        await runtime.shutdown();
      }
    });

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
      const { runtime, source } = await startWithPolicy("menu", ["anthropic:claude-sonnet-5"]);
      try {
        const cfg = (await asDevUser(() => source.execute("get_config", {})))
          .structuredContent as Record<string, unknown>;
        const models = cfg.availableModels as Record<string, { id: string }[]>;
        expect(models.anthropic.map((m) => m.id)).toEqual(["claude-sonnet-5"]);
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
        identityProvider: devProvider,
        ...loaded,
        languageModel: createEchoModel(),
        workDir,
        logging: { disabled: true },
      });
      try {
        expect(runtime.isModelPermitted("anthropic:claude-opus-5")).toBe(false);
      } finally {
        await runtime.shutdown();
      }
    });

    it("judges a cleared slot by the configured default, not the admin's own", async () => {
      // The admin's own preference must not decide whether a policy strands
      // everyone else: tinted, an admin who prefers the one allowed model
      // passes a guard every other member fails.
      const { runtime, source } = await startWithPolicy("tinted-admin", [
        "anthropic:claude-haiku-4-5-20251001",
      ]);
      try {
        // The configured default is sonnet-5, which the policy forbids, so
        // clearing the fast slot has to be judged against that — not against
        // the haiku this admin happens to prefer.
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
          () => source.execute("set_model_config", { models: { fast: null } }),
        );
        expect(res.isError).toBe(true);
        expect(extractText(res.content)).toContain("which the default slot uses");
      } finally {
        await runtime.shutdown();
      }
    });

    it("refuses a slot pointed at a model outside the list", async () => {
      const { runtime, source } = await startWithPolicy("fast-slot", ["anthropic:claude-sonnet-5"]);
      try {
        const res = await asDevUser(() =>
          source.execute("set_model_config", {
            models: { fast: "anthropic:claude-opus-5" },
          }),
        );
        expect(res.isError).toBe(true);
        expect(extractText(res.content)).toContain("not in this organization's allowed models");
      } finally {
        await runtime.shutdown();
      }
    });

    it("refuses a defaultModel input as a field it does not write", async () => {
      // `models.default` is the one way to move the default slot. Any other
      // key is refused by name, so nothing reports as applied while the slot
      // stays put.
      const { runtime, source } = await startWithPolicy("default-model-input", [
        "anthropic:claude-sonnet-5",
      ]);
      try {
        const res = await asDevUser(() =>
          source.execute("set_model_config", {
            defaultModel: "anthropic:claude-opus-5",
          }),
        );
        expect(res.isError).toBe(true);
        expect(extractText(res.content)).toContain(
          "`defaultModel` is not a field this tool writes",
        );
        expect(runtime.configuredModelSlots().default).toBe("anthropic:claude-sonnet-5");
      } finally {
        await runtime.shutdown();
      }
    });

    it("accepts repointing the default and narrowing to it in one call", async () => {
      // The mirror of the above: the guard must judge the post-write state,
      // not the prior one, or its own advice — "point that slot at an
      // allowed model in this call" — is impossible to follow.
      const { runtime, source } = await startWithPolicy("repoint-and-narrow", [
        "anthropic:claude-haiku-4-5-20251001",
      ]);
      try {
        const res = await asDevUser(() =>
          source.execute("set_model_config", {
            models: {
              default: "anthropic:claude-haiku-4-5-20251001",
              fast: "anthropic:claude-haiku-4-5-20251001",
            },
          }),
        );
        expect(`isError: ${res.isError} — ${extractText(res.content)}`).toContain("isError: false");
      } finally {
        await runtime.shutdown();
      }
    });

    it("clears a slot with null under a policy", async () => {
      // A cleared slot falls back to the built-in default model, not to
      // `models.default`, so the list names both.
      const { runtime, source } = await startWithPolicy("clear-sentinel", [
        "anthropic:claude-sonnet-5",
        "anthropic:claude-sonnet-4-6",
      ]);
      try {
        const res = await asDevUser(() =>
          source.execute("set_model_config", { models: { fast: null } }),
        );
        expect(`isError: ${res.isError} — ${extractText(res.content)}`).toContain("isError: false");
        // Cleared, so it falls back to the built-in default — which policy allows.
        expect(runtime.configuredModelSlots().fast).toBe("anthropic:claude-sonnet-4-6");
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
        const res = await asDevUser(() =>
          source.execute("set_model_config", { models: { fast: null } }),
        );
        expect(res.isError).toBe(true);
        expect(extractText(res.content)).toContain("which the fast slot uses");
      } finally {
        await runtime.shutdown();
      }
    });

    /**
     * Boot and collect the stranded-slot errors, so the report and its
     * silence are assertable the same way.
     */
    async function strandedErrorsFrom(
      tag: string,
      allowed: string[],
      models: Record<string, string>,
    ) {
      const errors: { msg: string; data?: unknown }[] = [];
      const original = log.error;
      (log as { error: typeof log.error }).error = (msg: string, data?: unknown) => {
        errors.push({ msg, data });
      };
      const { runtime } = await (async () => {
        try {
          return await startWithPolicy(tag, allowed, { models });
        } finally {
          (log as { error: typeof log.error }).error = original;
        }
      })();
      try {
        return errors.filter((e) => e.msg.includes("outside this org's model policy"));
      } finally {
        await runtime.shutdown();
      }
    }

    it("reports a config file whose policy strands its own slot", async () => {
      // The hand-written door. `set_model_config` rejects this; a config file
      // has nothing validating it against its own policy, so it booted
      // silently and every turn then resolved outside the published menu.
      const stranded = await strandedErrorsFrom("file-strands", ["anthropic:claude-sonnet-5"], {
        default: "anthropic:claude-opus-5",
        fast: "anthropic:claude-opus-5",
      });
      expect(stranded.length).toBeGreaterThan(0);
      expect(JSON.stringify(stranded[0]?.data)).toContain("anthropic:claude-opus-5");
    });

    it("says nothing when every configured slot is in policy", async () => {
      // Pins the silence. A report that fired regardless of the slots would
      // satisfy the case above while logging an error on every compliant
      // deployment, and nothing else in the suite reads this channel.
      const stranded = await strandedErrorsFrom("file-ok", ["anthropic:claude-sonnet-5"], {
        default: "anthropic:claude-sonnet-5",
        fast: "anthropic:claude-sonnet-5",
      });
      expect(stranded).toEqual([]);
    });

    it("accepts a bare model id that policy allows in qualified form", async () => {
      // Bare ids are legal input; the policy check is an exact match, so it
      // has to compare resolved forms.
      const { runtime, source } = await startWithPolicy("bare-id", [
        "anthropic:claude-sonnet-5",
        "anthropic:claude-haiku-4-5-20251001",
      ]);
      try {
        const res = await asDevUser(() =>
          source.execute("set_model_config", {
            models: { fast: "claude-haiku-4-5-20251001" },
          }),
        );
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
        identityProvider: devProvider,
        languageModel: createEchoModel(),
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
        const cfg = (await asDevUser(() => source.execute("get_config", {})))
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
        expect((resolved.models as Record<string, string>).default).toBe(runtime.getDefaultModel());
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
      //
      // The writable subset is derived from the writer's own key list
      // rather than by subtracting the display-only fields by name: that
      // subtraction goes stale every time the payload gains a field to
      // render, and a stale one silently stops posting anything at all.
      const { runtime, source, overridePath } = await startBare("noop-save");
      try {
        const cfg = (await asDevUser(() => source.execute("get_config", {})))
          .structuredContent as Record<string, unknown>;
        const writable = (OVERRIDE_WRITABLE_KEYS as readonly string[]).filter((k) => k in cfg);

        // The guarantee is structural, which is why the round-trip is
        // safe: a setting nobody chose is absent from the payload, so
        // there is nothing for a naive client to hand back.
        expect(writable).toEqual([]);

        const result = await asDevUser(() =>
          source.execute("set_model_config", Object.fromEntries(writable.map((k) => [k, cfg[k]]))),
        );
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
        const setResult = await asDevUser(() =>
          source.execute("set_model_config", { maxIterations: 12 }),
        );
        expect(setResult.isError).toBe(false);
        expect(readOverride(overridePath).maxIterations).toBe(12);
        expect(runtime.getMaxIterations()).toBe(12);

        const clearResult = await asDevUser(() =>
          source.execute("set_model_config", {
            maxIterations: null,
          }),
        );
        expect(clearResult.isError).toBe(false);

        // Absent on disk, absent from the live process, and back to the
        // platform default for readers. A stored `null` would satisfy
        // none of these.
        expect("maxIterations" in readOverride(overridePath)).toBe(false);
        expect(runtime.getOperatorConfig().maxIterations).toBeUndefined();
        expect(runtime.getMaxIterations()).toBe(DEFAULT_MAX_ITERATIONS);

        const cfg = (await asDevUser(() => source.execute("get_config", {})))
          .structuredContent as Record<string, unknown>;
        expect("maxIterations" in cfg).toBe(false);
        expect((cfg.resolved as Record<string, unknown>).maxIterations).toBe(
          DEFAULT_MAX_ITERATIONS,
        );
      } finally {
        await runtime.shutdown();
      }
    });

    it("an empty model slot is refused with the clear spelled out", async () => {
      const { runtime, source, overridePath } = await startBare("empty-slot");
      try {
        const result = await asDevUser(() =>
          source.execute("set_model_config", { models: { default: "" } }),
        );
        expect(result.isError).toBe(true);
        expect(extractText(result.content)).toContain("Pass null to clear it");
        expect(readOverride(overridePath).models).toBeUndefined();
      } finally {
        await runtime.shutdown();
      }
    });

    it("null clears a model slot", async () => {
      const { runtime, source, overridePath } = await startBare("clear-slot");
      try {
        const beforeAnySet = runtime.getDefaultModel();
        await asDevUser(() =>
          source.execute("set_model_config", {
            models: { default: "anthropic:claude-haiku-4-5-20251001" },
          }),
        );
        expect(runtime.getDefaultModel()).toBe("anthropic:claude-haiku-4-5-20251001");

        const clearResult = await asDevUser(() =>
          source.execute("set_model_config", {
            models: { default: null },
          }),
        );
        expect(clearResult.isError).toBe(false);

        // Deleted, not stored: a cleared slot reads back the same as one
        // never set.
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
    // set_model_config to pin the default model and thinking, then the pod
    // restarts. The init container overwrites the seed (simulated by us
    // keeping the seed file unchanged) but the override file on the PVC
    // survives, and the runtime should boot with the user's last values.
    const workDir = join(testDir, `work-layered-restart-${Date.now()}`);
    mkdirSync(workDir, { recursive: true });
    const configPath = join(workDir, "nimblebrain.json");
    const overridePath = deriveOverridePath(configPath);
    writeFileSync(
      configPath,
      JSON.stringify({
        version: "1",
        models: { default: "claude-opus-4-7" },
        maxIterations: 10,
      }),
    );

    // First runtime: simulate the operator changing config.
    const r1 = await Runtime.start({
      identityProvider: devProvider,
      languageModel: createEchoModel(),
      workDir,
      configPath,
      logging: { disabled: true },
    });
    try {
      const source = await makeInProcessSource("nb", createCoreToolDefs(r1));
      const result = await asDevUser(() =>
        source.execute("set_model_config", {
          models: { default: "claude-haiku-4-5-20251001" },
          thinking: "off",
        }),
      );
      expect(result.isError).toBe(false);
    } finally {
      await r1.shutdown();
    }

    // Override file written, seed file untouched.
    const overrideAfterWrite = JSON.parse(require("node:fs").readFileSync(overridePath, "utf-8"));
    expect(overrideAfterWrite.models).toEqual({ default: "claude-haiku-4-5-20251001" });
    expect(overrideAfterWrite.thinking).toBe("off");
    const seedAfterWrite = JSON.parse(require("node:fs").readFileSync(configPath, "utf-8"));
    expect(seedAfterWrite.models).toEqual({ default: "claude-opus-4-7" }); // unchanged
    expect(seedAfterWrite.thinking).toBeUndefined();

    // Second runtime: load via loadConfig (the production path that
    // reads seed + override). Effective config should reflect the
    // override, not the seed — that's the whole point.
    const loaded = loadConfig({ config: configPath });
    const r2 = await Runtime.start({
      identityProvider: devProvider,
      ...loaded,
      languageModel: createEchoModel(),
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

  it("nb__set_model_config schema declares nullable fields as anyOf with a null branch (Gemini-compatible)", async () => {
    // Regression guard: Gemini rejects an `enum` on anything but a string
    // type, and that rejection fails every tool call on a Google-only tenant —
    // including the one that would fix it. `type: ["string", "null"]` with
    // `null` in the enum did exactly that. A nullable field is written as
    // `anyOf` with the enum on the string branch and a separate null branch.
    // test/unit/platform/schema-shape.test.ts holds every tool to this.
    const runtime = await makeRuntime();
    try {
      const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));
      const tools = await source.tools();
      const setModelConfig = tools.find((t) => t.name === "nb__set_model_config");
      if (!setModelConfig) throw new Error("nb__set_model_config is not registered");
      const props = (setModelConfig.inputSchema as { properties: Record<string, unknown> })
        .properties;
      expect(props.thinking).toMatchObject({
        anyOf: [{ type: "string", enum: ["off", "adaptive", "enabled"] }, { type: "null" }],
      });
      expect(props.thinkingBudgetTokens).toMatchObject({
        anyOf: [{ type: "number" }, { type: "null" }],
      });
    } finally {
      await runtime.shutdown();
    }
  });

  it("nb__set_model_config without configPath returns error", async () => {
    const runtime = await makeRuntime();
    try {
      const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));
      const result = await asDevUser(() =>
        source.execute("set_model_config", {
          maxIterations: 5,
        }),
      );
      expect(result.isError).toBe(true);
      expect(extractText(result.content)).toContain("No config override path");
    } finally {
      await runtime.shutdown();
    }
  });

  // The briefing is read over the workspace's connection, which carries no
  // member, so every member of the workspace is served the same items.
  it("nb__briefing serves byte-identical items to every workspace member", async () => {
    const runtime = await makeRuntime();
    let facetSource: McpSource | undefined;
    try {
      await provisionTestWorkspace(runtime);
      facetSource = await seedFacetApp(runtime);
      const source = await makeInProcessSource("nb", createCoreToolDefs(runtime));
      const ctxFor = (id: string, displayName: string) => ({
        identity: { id, email: `${id}@example.com`, displayName } as never,
        workspaceId: TEST_WORKSPACE_ID,
      });

      const a = await runWithRequestContext(ctxFor("user_a", "Alice"), () =>
        source.execute("briefing", {}),
      );
      const b = await runWithRequestContext(ctxFor("user_b", "Bob"), () =>
        source.execute("briefing", { force_refresh: true }),
      );

      expect(a.isError).toBe(false);
      expect(b.isError).toBe(false);
      const itemsA = JSON.stringify(a.structuredContent?.items);
      expect(itemsA).toBe(JSON.stringify(b.structuredContent?.items));
      expect(a.structuredContent?.items).toEqual([
        {
          app: "facet_app",
          facet: "overdue",
          label: "Follow-ups overdue",
          count: 3,
          level: "warning",
          route: "@acme/facet-app",
          state: "ok",
        },
      ]);
      expect(extractText(a.content)).toBe("3 Follow-ups overdue (facet_app)");
      expect(JSON.stringify(b)).not.toContain("Alice");
    } finally {
      await facetSource?.stop();
      await runtime.shutdown();
    }
  });
});
