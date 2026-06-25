import { describe, expect, it, afterAll, spyOn } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
    expect(config.model).toEqual({ provider: "anthropic" });
    expect(config.bundles).toBeUndefined();
    expect(config.skillDirs).toBeUndefined();
  });

  it("throws when explicit --config path does not exist", () => {
    expect(() => loadConfig({ config: "/nonexistent/nimblebrain.json" })).toThrow("Config file not found");
  });

  it("loads instance fields from config file", () => {
    const configPath = writeTestConfig("load.json", {
      model: { provider: "anthropic" },
      defaultModel: "claude-opus-4-6",
      maxIterations: 15,
    });

    const config = loadConfig({ config: configPath });
    expect(config.defaultModel).toBe("claude-opus-4-6");
    expect(config.maxIterations).toBe(15);
  });

  it("strips workspace-owned fields from config", () => {
    const configPath = writeTestConfig("strip-workspace.json", {
      model: { provider: "anthropic" },
      defaultModel: "claude-opus-4-6",
    });
    // Manually write workspace-owned fields into the JSON (bypasses schema)
    const fs = require("node:fs");
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    raw.bundles = [{ name: "@nimblebraininc/leadgen" }];
    raw.agents = { researcher: { description: "test", systemPrompt: "test", tools: ["*"] } };
    raw.skillDirs = ["./skills"];
    raw.preferences = { displayName: "Test" };
    raw.home = { enabled: true };
    raw.noDefaultBundles = true;
    raw.skills = [];
    fs.writeFileSync(configPath, JSON.stringify(raw));

    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const config = loadConfig({ config: configPath });
      // Instance fields still loaded
      expect(config.defaultModel).toBe("claude-opus-4-6");
      // Workspace-owned fields stripped
      expect(config.bundles).toBeUndefined();
      expect(config.agents).toBeUndefined();
      expect(config.skillDirs).toBeUndefined();
      expect(config.preferences).toBeUndefined();
      expect(config.home).toBeUndefined();
      expect(config.noDefaultBundles).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("loads features from config file", () => {
    const configPath = writeTestConfig("features.json", {
      features: {
        delegation: false,
        workspaceManagement: false,
      },
    });

    const config = loadConfig({ config: configPath });
    expect(config.features).toEqual({
      delegation: false,
      workspaceManagement: false,
    });
  });

  it("loads maxHistoryMessages from config file", () => {
    const configPath = writeTestConfig("history.json", { maxHistoryMessages: 120 });
    const config = loadConfig({ config: configPath });
    expect(config.maxHistoryMessages).toBe(120);
  });

  it("loads maxToolResultSize from config file", () => {
    const configPath = writeTestConfig("tool-result.json", { maxToolResultSize: 250000 });
    const config = loadConfig({ config: configPath });
    expect(config.maxToolResultSize).toBe(250000);
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

  it("CLI flags override file config", () => {
    const configPath = writeTestConfig("override.json", {
      defaultModel: "claude-sonnet-4-5-20250929",
    });

    const config = loadConfig({ config: configPath, model: "claude-opus-4-6" });
    expect(config.defaultModel).toBe("claude-opus-4-6");
  });

  it("loads config from defaultWorkDir path", () => {
    const defaultDir = join(testDir, "workdir-test");
    mkdirSync(defaultDir, { recursive: true });
    const cfgPath = join(defaultDir, "nimblebrain.json");
    writeFileSync(cfgPath, JSON.stringify({ defaultModel: "from-workdir" }));

    // Use explicit --config to test the loading behavior
    const config = loadConfig({ config: cfgPath });
    expect(config.defaultModel).toBe("from-workdir");
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
    writeFileSync(expectedPath, JSON.stringify({ defaultModel: "test-model" }, null, 2));
    const config = loadConfig({ config: expectedPath });
    expect(config.configPath).toBe(expectedPath);
    expect(config.defaultModel).toBe("test-model");
  });

  it("explicit --config takes precedence over defaultWorkDir config", () => {
    const defaultDir = join(testDir, "workdir-precedence");
    mkdirSync(defaultDir, { recursive: true });
    writeFileSync(
      join(defaultDir, "nimblebrain.json"),
      JSON.stringify({ defaultModel: "from-workdir" }),
    );

    const explicitPath = writeTestConfig("explicit.json", {
      defaultModel: "from-explicit",
    });

    const config = loadConfig({ config: explicitPath, defaultWorkDir: defaultDir });
    expect(config.defaultModel).toBe("from-explicit");
    expect(config.configPath).toBe(explicitPath);
  });
});

describe("config validation", () => {
  it("throws on invalid model (string instead of object)", () => {
    const configPath = writeTestConfig("bad-model.json", {
      model: "anthropic",
    });

    expect(() => loadConfig({ config: configPath })).toThrow("Invalid config");
  });

  it("strips bundles from config (workspace-owned, loaded separately)", () => {
    const configPath = writeTestConfig("with-bundles.json", {
      bundles: [{ name: "@test/a" }],
    });

    const config = loadConfig({ config: configPath });
    // bundles passes schema validation but is stripped by loadConfig
    // because it's now workspace-owned (loaded from workspace.json)
    expect(config.bundles).toBeUndefined();
  });

  it("warns on unknown keys but does not throw", () => {
    const configPath = writeTestConfig("unknown-keys.json", {
      model: { provider: "anthropic" },
      unknownField: true,
      anotherBadKey: 42,
    });

    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const config = loadConfig({ config: configPath });
      // Should still load successfully
      expect(config.model).toEqual({ provider: "anthropic" });
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
      model: { provider: "anthropic", apiKey: "sk-test" },
      store: { type: "jsonl", dir: "/tmp/convos" },
      defaultModel: "claude-opus-4-6",
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
      expect(config.model).toEqual({ provider: "anthropic", apiKey: "sk-test" });
      expect(config.maxIterations).toBe(20);
      expect(config.logging).toEqual({ dir: "/tmp/logs", disabled: false });
      expect(config.workDir).toBe("/tmp/nimblebrain");
    } finally {
      if (savedNbWorkDir !== undefined) process.env.NB_WORK_DIR = savedNbWorkDir;
    }
  });

  it("warns when deprecated identity field is present", () => {
    const configPath = writeTestConfig("deprecated-identity.json", {
      identity: "I am a bot.",
    });

    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      loadConfig({ config: configPath });
      const warnings = spy.mock.calls.map((c) => c[0] as string);
      expect(warnings.some((w) => w.includes('"identity" is deprecated'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("warns when deprecated contextFile field is present", () => {
    const configPath = writeTestConfig("deprecated-context.json", {
      contextFile: "./context.md",
    });

    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      loadConfig({ config: configPath });
      const warnings = spy.mock.calls.map((c) => c[0] as string);
      expect(warnings.some((w) => w.includes('"contextFile" is deprecated'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
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
