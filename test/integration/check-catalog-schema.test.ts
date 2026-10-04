import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "bun";

// The gate's exit code is its contract with CI: a warning is printed and passes,
// anything else fails. `validateCatalog` alone cannot pin that, because the
// split between the two happens in the script.
const SCRIPT = join(import.meta.dir, "../../scripts/check-catalog-schema.ts");

const ENTRY = {
  name: "com.example/mcp",
  description: "A short, valid description.",
  version: "1.0.0",
  remotes: [{ type: "streamable-http", url: "https://mcp.example.com/mcp" }],
  _meta: { "ai.nimblebrain/host": { host_version: "1.4", lifecycle: { on_ready: "ready" } } },
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "check-catalog-schema-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function runGate(servers: unknown[]): { exitCode: number; stderr: string } {
  writeFileSync(join(dir, "catalog.json"), JSON.stringify({ servers }));
  const result = spawnSync(["bun", "run", "--no-env-file", SCRIPT, dir], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: result.exitCode, stderr: result.stderr.toString() };
}

describe("check-catalog-schema", () => {
  test("a catalog lifecycle block is printed as a warning and passes the gate", () => {
    const { exitCode, stderr } = runGate([ENTRY]);
    expect(stderr).toContain("⚠");
    expect(stderr).toContain("deprecated");
    expect(exitCode).toBe(0);
  });

  test("a warning beside a real problem still fails, and is not counted as one", () => {
    const { exitCode, stderr } = runGate([
      ENTRY,
      { ...ENTRY, name: "com.other/mcp", description: "x".repeat(101) },
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("1 problem(s)");
  });
});
