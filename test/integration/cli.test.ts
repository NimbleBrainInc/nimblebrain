import { describe, expect, it, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "bun";

const CLI = "src/cli/index.ts";

const testDir = join(tmpdir(), `nimblebrain-cli-integ-${Date.now()}`);

afterAll(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

function writeTestConfig(name: string, content: unknown): string {
  mkdirSync(testDir, { recursive: true });
  const configPath = join(testDir, name);
  writeFileSync(configPath, JSON.stringify(content));
  return configPath;
}

// --- CLI subprocess tests (§19) ---

describe("help text", () => {
	it("root help lists all commands", () => {
		const result = spawnSync(["bun", "run", CLI, "--help"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = result.stdout.toString();
		expect(stdout).toContain("serve");
		expect(stdout).toContain("dev");
		expect(stdout).toContain("bundle");
		expect(stdout).toContain("skill");
		expect(stdout).toContain("config");
		expect(stdout).toContain("status");
		expect(stdout).toContain("reload");
	});

	for (const cmd of ["serve", "dev", "bundle", "skill", "config", "status", "reload", "telemetry"]) {
		it(`${cmd} --help prints help text`, () => {
			const result = spawnSync(["bun", "run", CLI, cmd, "--help"], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const output = result.stdout.toString() + result.stderr.toString();
			expect(output.length).toBeGreaterThan(20);
		});
	}

	it("nb --help exits 0 and prints to stdout", () => {
		const result = spawnSync(["bun", "run", CLI, "--help"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).toBe(0);
		const stdout = result.stdout.toString();
		expect(stdout).toContain("NimbleBrain CLI");
		expect(stdout).toContain("serve");
	});

	it("nb serve --help prints serve-specific help", () => {
		const result = spawnSync(["bun", "run", CLI, "serve", "--help"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).toBe(0);
		const output = result.stdout.toString() + result.stderr.toString();
		expect(output).toContain("Start HTTP API server");
	});

	it("nb dev --help prints dev-specific help", () => {
		const result = spawnSync(["bun", "run", CLI, "dev", "--help"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).toBe(0);
		const output = result.stdout.toString() + result.stderr.toString();
		expect(output).toContain("Start dev mode");
		expect(output).toContain("--no-web");
	});
});

describe("exit codes", () => {
	it("unknown subcommand exits with code 2", () => {
		const result = spawnSync(["bun", "run", CLI, "fakecmd"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).toBe(2);
		expect(result.stderr.toString()).toContain("Unknown command");
	});

	it("missing bundle name exits with code 2", () => {
		const result = spawnSync(["bun", "run", CLI, "bundle", "add"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).toBe(2);
	});

	it("invalid skill subcommand exits with code 2", () => {
		const result = spawnSync(["bun", "run", CLI, "skill"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).toBe(2);
	});

	it("invalid config subcommand exits with code 2", () => {
		const result = spawnSync(["bun", "run", CLI, "config"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).toBe(2);
	});
});

describe("--json output", () => {
	it("nb bundle list --json outputs valid JSON", () => {
		const configPath = writeTestConfig("json-list.json", {
			bundles: [{ name: "@test/a" }],
		});
		const result = spawnSync(
			["bun", "run", CLI, "bundle", "list", "--json", "--config", configPath],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const stdout = result.stdout.toString().trim();
		expect(() => JSON.parse(stdout)).not.toThrow();
		const parsed = JSON.parse(stdout);
		expect(Array.isArray(parsed)).toBe(true);
		expect(parsed).toHaveLength(1);
	});

	it("nb status --json outputs valid JSON", () => {
		const configPath = writeTestConfig("json-status.json", {
			bundles: [{ name: "@test/a" }],
		});
		const result = spawnSync(
			["bun", "run", CLI, "status", "--json", "--config", configPath],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const stdout = result.stdout.toString().trim();
		expect(() => JSON.parse(stdout)).not.toThrow();
		const parsed = JSON.parse(stdout);
		expect(parsed).toHaveProperty("bundles");
		expect(parsed).toHaveProperty("skills");
	});
});
