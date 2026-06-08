import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Allocate an isolated, ephemeral workDir for an integration test.
 *
 * Why this exists: `Runtime.start({})` defaults `workDir` to `~/.nimblebrain`.
 * A test that forgets to pass `workDir` writes echo-model conversations,
 * test workspaces, and bundle data straight into the developer's real dev
 * workdir, where they then show up in the conversations tab and lifecycle
 * tools. `Runtime.start` throws under `NODE_ENV=test` if `workDir` is
 * missing — this helper is the canonical way to satisfy that guard.
 *
 * Returns the path and a cleanup function. Call cleanup in `afterEach` /
 * `afterAll` after `runtime.shutdown()`.
 *
 * @example
 *   const { workDir, cleanup } = makeTestWorkDir("chat-stream-concurrent");
 *   afterEach(async () => { await runtime.shutdown(); cleanup(); });
 *   const runtime = await Runtime.start({ workDir, ... });
 */
export function makeTestWorkDir(label = "test"): { workDir: string; cleanup: () => void } {
  const workDir = join(
    tmpdir(),
    `nb-${label}-${Date.now()}-${Math.floor(Math.random() * 1e9).toString(36)}`,
  );
  mkdirSync(workDir, { recursive: true });
  return {
    workDir,
    cleanup: () => rmSync(workDir, { recursive: true, force: true }),
  };
}
