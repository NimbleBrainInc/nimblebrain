import { describe, expect, it } from "bun:test";
import { spawnSync } from "bun";

// The CLI is a thin argv dispatcher over two commands (serve, dev). These tests
// exercise the dispatch/usage edges without booting a server.
const CLI = "src/cli/index.ts";

describe("nb dispatcher", () => {
  it("no command prints usage and exits 0", () => {
    const result = spawnSync(["bun", "run", CLI], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toContain("Usage:");
  });

  it("unknown command exits 2 with an error", () => {
    const result = spawnSync(["bun", "run", CLI, "fakecmd"], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("Unknown command");
  });
});
