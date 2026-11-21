/**
 * A process that starts a runtime and shuts it down exits on its own.
 *
 * Identity sources (tasks, files, conversations) sit in no workspace registry,
 * so shutdown stops them separately; the tasks scheduler's timer would
 * otherwise outlive the runtime and hold the process open. Run in a child so a
 * leaked timer shows up as a process that never exits, not a test that passes.
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

const SCRIPT = `
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from ${JSON.stringify(join(ROOT, "src/runtime/runtime.ts"))};
import { devProvider, devWorkspace } from ${JSON.stringify(join(ROOT, "test/helpers/dev-provider.ts"))};
const runtime = await Runtime.start({
  identityProvider: devProvider,
  providers: { local: { baseURL: "http://127.0.0.1:1/v1", models: ["m"], contextWindow: 32768 } },
  models: { default: "local:m", fast: "local:m" },
  workDir: mkdtempSync(join(tmpdir(), "nb-shutdown-")),
  telemetry: { enabled: false },
  logging: { disabled: true },
});
await devWorkspace(runtime);
await runtime.shutdown();
`;

describe("Runtime.shutdown", () => {
  it("leaves nothing holding the process open", () => {
    const child = spawnSync("bun", ["--no-env-file", "-e", SCRIPT], {
      cwd: ROOT,
      timeout: 30_000,
      encoding: "utf8",
    });
    // A leaked timer keeps the child alive until the timeout kills it.
    expect(child.signal).toBeNull();
    expect(child.status).toBe(0);
  }, 40_000);
});
