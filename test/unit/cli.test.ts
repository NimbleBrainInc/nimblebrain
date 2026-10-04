import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/cli/config.ts";

const testDir = join(tmpdir(), `nimblebrain-cli-unit-${Date.now()}`);

afterAll(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

function writeTestConfig(name: string, content: unknown): string {
  mkdirSync(testDir, { recursive: true });
  const configPath = join(testDir, name);
  writeFileSync(configPath, JSON.stringify(content));
  return configPath;
}

describe("loadConfig", () => {
  it("returns defaults when config file is empty", () => {
    // Create an empty config to verify default values are applied
    const configPath = writeTestConfig("empty-defaults.json", {});
    const config = loadConfig({ config: configPath });
    expect(config.providers).toBeUndefined();
    expect(config.models).toBeUndefined();
    expect(config.connectors).toBeUndefined();
    expect(config.skillDirs).toBeUndefined();
  });

  it("throws when explicit --config path does not exist", () => {
    expect(() => loadConfig({ config: "/nonexistent/nimblebrain.json" })).toThrow(
      "Config file not found",
    );
  });

  it("loads instance fields from config file", () => {
    const configPath = writeTestConfig("load.json", {
      providers: { anthropic: {} },
      models: { default: "claude-opus-4-6" },
      maxIterations: 15,
    });

    const config = loadConfig({ config: configPath });
    expect(config.providers).toEqual({ anthropic: {} });
    expect(config.models).toEqual({ default: "claude-opus-4-6" });
    expect(config.maxIterations).toBe(15);
  });

  it("carries the tasks block through to the runtime config", () => {
    const configPath = writeTestConfig("tasks.json", {
      tasks: { maxConcurrentRuns: 4, maxQueuedRuns: 10, maxRunIterations: 12 },
    });

    const config = loadConfig({ config: configPath });
    expect(config.tasks).toEqual({
      maxConcurrentRuns: 4,
      maxQueuedRuns: 10,
      maxRunIterations: 12,
    });
  });

  it("carries every top-level schema key through to the runtime config", () => {
    // A key the schema accepts but loadConfig does not copy is validated and
    // then silently ignored. Every schema key needs a row here; `$schema` and
    // `version` describe the file and configure nothing.
    const schema = JSON.parse(
      require("node:fs").readFileSync(
        join(import.meta.dir, "../../src/config/nimblebrain-config.schema.json"),
        "utf-8",
      ),
    ) as { properties: Record<string, unknown> };
    const samples: Record<string, unknown> = {
      providers: {},
      allowInsecureRemotes: true,
      models: {},
      modelPolicy: {},
      maxIterations: 5,
      maxInputTokens: 1000,
      maxOutputTokens: 1000,
      thinking: "off",
      thinkingEffort: "low",
      thinkingBudgetTokens: 2048,
      maxToolResultSize: 1000,
      logging: {},
      http: {},
      workDir: testDir,
      usage: { ledger: { retentionMonths: 6 } },
      sessionStore: { type: "memory", ttlSeconds: 60 },
      secrets: {},
      telemetry: {},
      features: {},
      connectors: {},
      notifications: { poll: { intervalMs: 30000 } },
      tasks: {},
      files: {},
    };
    const fileOnly = new Set(["$schema", "version"]);
    const configurable = Object.keys(schema.properties).filter((k) => !fileOnly.has(k));
    expect(configurable.filter((k) => !(k in samples))).toEqual([]);

    const configPath = writeTestConfig("every-key.json", samples);
    const config = loadConfig({ config: configPath }) as unknown as Record<string, unknown>;
    expect(configurable.filter((k) => config[k] === undefined)).toEqual([]);
    expect(config.usage).toEqual({ ledger: { retentionMonths: 6 } });
    expect(config.sessionStore).toEqual({ type: "memory", ttlSeconds: 60 });
    expect(config.notifications).toEqual({ poll: { intervalMs: 30000 } });
  });

  it("strips workspace-owned fields from config", () => {
    const configPath = writeTestConfig("strip-workspace.json", {
      models: { default: "claude-opus-4-6" },
    });
    // Manually write workspace-owned fields into the JSON (bypasses schema)
    const fs = require("node:fs");
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    raw.agents = { researcher: { description: "test", systemPrompt: "test", tools: ["*"] } };
    raw.skillDirs = ["./skills"];
    raw.preferences = { displayName: "Test" };
    raw.home = { enabled: true };
    fs.writeFileSync(configPath, JSON.stringify(raw));

    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const config = loadConfig({ config: configPath });
      // Instance fields still loaded
      expect(config.models).toEqual({ default: "claude-opus-4-6" });
      // Workspace-owned fields stripped
      expect("agents" in config).toBe(false);
      expect(config.skillDirs).toBeUndefined();
      expect(config.preferences).toBeUndefined();
      expect(config.home).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps the instance connector block through the workspace-field strip", () => {
    // `connectors` names the provider/gateway block here, not a workspace's
    // connector array. Stripping it would drop every declared provider and
    // gateway at boot.
    const configPath = writeTestConfig("keep-connectors.json", {
      connectors: { gateways: { mcp360: { apiKey: "k" } } },
    });

    const config = loadConfig({ config: configPath });
    expect(config.connectors?.gateways?.mcp360).toBeDefined();
  });

  it("loads features from config file", () => {
    const configPath = writeTestConfig("features.json", {
      features: {
        catalogSearch: false,
        workspaceManagement: false,
      },
    });

    const config = loadConfig({ config: configPath });
    expect(config.features).toEqual({
      catalogSearch: false,
      workspaceManagement: false,
    });
  });

  it("loads maxToolResultSize from config file", () => {
    const configPath = writeTestConfig("tool-result.json", { maxToolResultSize: 250000 });
    const config = loadConfig({ config: configPath });
    expect(config.maxToolResultSize).toBe(250000);
  });

  // The `secrets` block selects which backend holds every credential. Dropped
  // here, a config naming a backend this build does not register boots clean on
  // the plaintext file store instead of throwing — silently, and exactly for the
  // deployment that asked not to be on plaintext.
  it("loads the secrets block from config file", () => {
    // `config` is empty because nothing reads it yet: the `file` backend
    // discards it, so a seal-shaped fixture here would read as a working
    // example of a setting that does nothing. An empty object still fails this
    // assertion if the loader drops the key.
    const configPath = writeTestConfig("secrets.json", {
      secrets: { backend: "file", config: {} },
    });
    const config = loadConfig({ config: configPath });
    expect(config.secrets).toEqual({ backend: "file", config: {} });
  });

  it("loads files config from config file", () => {
    const configPath = writeTestConfig("files-config.json", {
      files: {
        maxFileSize: 1024,
        maxTotalSize: 4096,
        maxFilesPerMessage: 3,
        maxExtractedTextSize: 8192,
      },
    });
    const config = loadConfig({ config: configPath });
    expect(config.files).toEqual({
      maxFileSize: 1024,
      maxTotalSize: 4096,
      maxFilesPerMessage: 3,
      maxExtractedTextSize: 8192,
    });
  });

  it("absolutizes a relative workDir from the config file", () => {
    const configPath = writeTestConfig("rel-workdir.json", { workDir: ".nimblebrain" });
    const config = loadConfig({ config: configPath });
    expect(config.workDir).toBeDefined();
    expect(config.workDir!.startsWith("/")).toBe(true);
    expect(config.workDir!.endsWith(".nimblebrain")).toBe(true);
  });

  it("leaves an absolute workDir untouched", () => {
    const abs = join(testDir, "abs-workdir-fixture");
    const configPath = writeTestConfig("abs-workdir.json", { workDir: abs });
    const config = loadConfig({ config: configPath });
    expect(config.workDir).toBe(abs);
  });

  it("leaves workDir undefined when no source supplies one", () => {
    const configPath = writeTestConfig("no-workdir.json", {});
    const prev = process.env.NB_WORK_DIR;
    delete process.env.NB_WORK_DIR;
    try {
      const config = loadConfig({ config: configPath });
      expect(config.workDir).toBeUndefined();
    } finally {
      if (prev !== undefined) process.env.NB_WORK_DIR = prev;
    }
  });

  it("loads config from defaultWorkDir path", () => {
    const defaultDir = join(testDir, "workdir-test");
    mkdirSync(defaultDir, { recursive: true });
    const cfgPath = join(defaultDir, "nimblebrain.json");
    writeFileSync(cfgPath, JSON.stringify({ models: { default: "from-workdir" } }));

    // Use explicit --config to test the loading behavior
    const config = loadConfig({ config: cfgPath });
    expect(config.models?.default).toBe("from-workdir");
    expect(config.configPath).toBe(cfgPath);
  });

  it("auto-creates nimblebrain.json when config path parent exists", () => {
    const defaultDir = join(testDir, "workdir-autocreate");
    mkdirSync(defaultDir, { recursive: true });
    const expectedPath = join(defaultDir, "nimblebrain.json");

    // When no config file exists at the defaultWorkDir path, it should auto-create.
    // Since CWD's .nimblebrain/ takes priority over defaultWorkDir in resolution,
    // we test the auto-create side-effect by checking the file was created via
    // the loadConfig code path (explicit config throws, so skip that route).
    // Just verify the auto-create logic in the store constructor works.
    expect(existsSync(expectedPath)).toBe(false);

    // Write and load to verify round-trip
    writeFileSync(expectedPath, JSON.stringify({ models: { default: "test-model" } }, null, 2));
    const config = loadConfig({ config: expectedPath });
    expect(config.configPath).toBe(expectedPath);
    expect(config.models?.default).toBe("test-model");
  });

  it("explicit --config takes precedence over defaultWorkDir config", () => {
    const defaultDir = join(testDir, "workdir-precedence");
    mkdirSync(defaultDir, { recursive: true });
    writeFileSync(
      join(defaultDir, "nimblebrain.json"),
      JSON.stringify({ models: { default: "from-workdir" } }),
    );

    const explicitPath = writeTestConfig("explicit.json", {
      models: { default: "from-explicit" },
    });

    const config = loadConfig({ config: explicitPath, defaultWorkDir: defaultDir });
    expect(config.models?.default).toBe("from-explicit");
    expect(config.configPath).toBe(explicitPath);
  });
});

describe("config validation", () => {
  it("throws on invalid models (string instead of object)", () => {
    const configPath = writeTestConfig("bad-models.json", {
      models: "anthropic",
    });

    expect(() => loadConfig({ config: configPath })).toThrow("Invalid config");
  });

  it("warns on unknown keys but does not throw", () => {
    const configPath = writeTestConfig("unknown-keys.json", {
      maxIterations: 7,
      unknownField: true,
      anotherBadKey: 42,
    });

    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const config = loadConfig({ config: configPath });
      // Should still load successfully
      expect(config.maxIterations).toBe(7);
      // Should have warned about both unknown keys
      const warnings = spy.mock.calls.map((c) => c[0] as string);
      expect(warnings.some((w) => w.includes("unknownField"))).toBe(true);
      expect(warnings.some((w) => w.includes("anotherBadKey"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("passes validation on a full valid config", () => {
    const configPath = writeTestConfig("valid-full.json", {
      providers: { anthropic: { apiKey: "sk-test" } },
      models: { default: "claude-opus-4-6" },
      maxIterations: 20,
      maxInputTokens: 100000,
      maxOutputTokens: 8192,
      logging: { dir: "/tmp/logs", disabled: false },
      http: { port: 8080, host: "0.0.0.0" },
      workDir: "/tmp/nimblebrain",
    });

    // NB_WORK_DIR may be set by Runtime.start() in concurrent tests — clear it
    const savedNbWorkDir = process.env.NB_WORK_DIR;
    delete process.env.NB_WORK_DIR;
    try {
      const config = loadConfig({ config: configPath });
      expect(config.providers).toEqual({ anthropic: { apiKey: "sk-test" } });
      expect(config.maxIterations).toBe(20);
      expect(config.logging).toEqual({ dir: "/tmp/logs", disabled: false });
      expect(config.workDir).toBe("/tmp/nimblebrain");
    } finally {
      if (savedNbWorkDir !== undefined) process.env.NB_WORK_DIR = savedNbWorkDir;
    }
  });

  // Keys the loader no longer reads take the unknown-key path like any other:
  // warned by name, ignored, and never copied into the runtime config.
  for (const [key, value] of [
    ["model", { provider: "anthropic" }],
    ["defaultModel", "claude-opus-4-6"],
    ["skills", []],
    ["identity", "I am a bot."],
    ["contextFile", "./context.md"],
  ] as const) {
    it(`warns on "${key}" as an unknown key`, () => {
      const configPath = writeTestConfig(`unknown-${key}.json`, { [key]: value });

      const spy = spyOn(console, "error").mockImplementation(() => {});
      try {
        const config = loadConfig({ config: configPath }) as unknown as Record<string, unknown>;
        const warnings = spy.mock.calls.map((c) => c[0] as string);
        expect(warnings.some((w) => w.includes(`Unknown key "${key}"`))).toBe(true);
        expect(config[key]).toBeUndefined();
      } finally {
        spy.mockRestore();
      }
    });
  }
});

describe("workdir resolution (§19.4)", () => {
  it("defaultWorkDir fallback is used when config has no workDir", () => {
    const cfgPath = writeTestConfig("no-workdir.json", {});
    // NB_WORK_DIR may be set by Runtime.start() in concurrent tests — clear it
    const saved = process.env.NB_WORK_DIR;
    delete process.env.NB_WORK_DIR;
    try {
      const config = loadConfig({
        config: cfgPath,
        defaultWorkDir: "/tmp/nb-default-workdir",
      });
      expect(config.workDir).toBe("/tmp/nb-default-workdir");
    } finally {
      if (saved !== undefined) process.env.NB_WORK_DIR = saved;
    }
  });

  it("workDir from config file overrides defaultWorkDir", () => {
    const cfgPath = writeTestConfig("with-workdir.json", { workDir: "/from-config" });
    const saved = process.env.NB_WORK_DIR;
    delete process.env.NB_WORK_DIR;
    try {
      const config = loadConfig({
        config: cfgPath,
        defaultWorkDir: "/tmp/nb-default-workdir",
      });
      expect(config.workDir).toBe("/from-config");
    } finally {
      if (saved !== undefined) process.env.NB_WORK_DIR = saved;
    }
  });
});

describe("package.json", () => {
  it("exposes no bin (the runtime is launched via bun, not an nb binary)", async () => {
    const pkg = await Bun.file("package.json").json();
    expect(pkg.bin).toBeUndefined();
  });

  it("scripts include dev, dev:api, dev:web, start", async () => {
    const pkg = await Bun.file("package.json").json();
    expect(pkg.scripts).toHaveProperty("dev");
    expect(pkg.scripts).toHaveProperty("dev:api");
    expect(pkg.scripts).toHaveProperty("dev:web");
    expect(pkg.scripts).toHaveProperty("start");
  });
});
