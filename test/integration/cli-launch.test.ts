import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LAUNCH_WAIT_MS, realDeps } from "../../packages/cli/src/deps.ts";

// The CLI's real launcher (`packages/cli`), against harmless `sh` children:
// no browser, Docker, port or network.
describe("realDeps().launch", () => {
  const { launch } = realDeps();

  test("a program that exits 0 is launched", async () => {
    expect(await launch("sh", ["-c", "exit 0"])).toBe(true);
  });

  test("a program that exits non-zero is not", async () => {
    expect(await launch("sh", ["-c", "exit 3"])).toBe(false);
  });

  test("a missing program is not, and nothing throws", async () => {
    expect(await launch("nimblebrain-no-such-program", [])).toBe(false);
  });

  test("a program still running after the wait is launched", async () => {
    const start = Date.now();
    expect(await launch("sh", ["-c", "sleep 5"])).toBe(true);
    const waited = Date.now() - start;
    expect(waited).toBeGreaterThanOrEqual(LAUNCH_WAIT_MS - 50);
    expect(waited).toBeLessThan(LAUNCH_WAIT_MS + 2_000);
  });

  test("the caller exits while the launched program keeps running", () => {
    const dir = mkdtempSync(join(tmpdir(), "nb-launch-"));
    const pidFile = join(dir, "pid");
    const deps = resolve(import.meta.dir, "../../packages/cli/src/deps.ts");
    const script = `
      import { realDeps } from ${JSON.stringify(deps)};
      const ok = await realDeps().launch("sh", ["-c", 'echo $$ > "$0"; exec sleep 30', ${JSON.stringify(pidFile)}]);
      console.log(ok);
    `;
    let pid: number | undefined;
    try {
      const parent = spawnSync(process.execPath, ["--no-env-file", "-e", script], {
        encoding: "utf8",
        timeout: LAUNCH_WAIT_MS + 8_000,
      });
      expect(parent.error).toBeUndefined();
      expect(parent.status).toBe(0);
      expect(parent.stdout.trim()).toBe("true");
      pid = Number(readFileSync(pidFile, "utf8").trim());
      // Signal 0 checks the program is alive without touching it.
      expect(() => process.kill(pid as number, 0)).not.toThrow();
    } finally {
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
