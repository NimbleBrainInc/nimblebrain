import { spawn, spawnSync } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

// The runtime binary's one job is to serve. The deploy command is
// `bun run src/cli/index.ts serve` (Dockerfile CMD; `start` and `dev:api` also
// pass `serve`), and the entry strips that leading token. A parse-only assertion
// can't guard the strip — `serve <garbage>` exits non-zero with or without it.
// The only behavioral difference is whether a *bare* `serve` boots, so the boot
// smoke below is what actually pins the deploy contract.
const CLI = "src/cli/index.ts";

async function waitForHealth(port: number, opts: { timeoutMs: number }): Promise<boolean> {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/v1/health`);
      if (res.ok) return true;
    } catch {
      // Port not listening yet — expected during boot.
    }
    await Bun.sleep(150);
  }
  return false;
}

describe("serve entry", () => {
  it("the deploy command (`serve`) boots and serves /v1/health", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "nb-serve-"));
    const port = 27991;
    const proc = spawn(
      [
        "bun",
        "run",
        CLI,
        "serve",
        "--port",
        String(port),
        "--config",
        ".environments/empty/nimblebrain.json",
      ],
      {
        env: { ...process.env, NB_WORK_DIR: workDir, NB_TELEMETRY_DISABLED: "1" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      expect(await waitForHealth(port, { timeoutMs: 20_000 })).toBe(true);
    } finally {
      proc.kill();
      await proc.exited;
      rmSync(workDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects an unrecognized positional as a usage error (exit 2)", () => {
    const result = spawnSync(["bun", "run", CLI, "fakecmd"], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(2);
  });
});
