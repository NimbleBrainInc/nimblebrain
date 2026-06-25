import { spawnSync } from "bun";
import { describe, expect, it } from "bun:test";

// The runtime binary's one job is to serve. It accepts (and ignores) a leading
// `serve` token for deploy-command stability and rejects other positionals
// before booting anything.
const CLI = "src/cli/index.ts";

describe("serve entry", () => {
  it("rejects an unrecognized positional argument", () => {
    const result = spawnSync(["bun", "run", CLI, "fakecmd"], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).not.toBe(0);
  });
});
