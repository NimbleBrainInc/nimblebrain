/**
 * Starting the bound servers at boot (`startBoundServers`).
 *
 * - The servers are separate processes, so they start together: boot waits for
 *   the slowest, not the sum. Every default plugin is one more server, and every
 *   `Runtime.start` (each integration test's) pays for the boot.
 * - One that does not start refuses the boot, naming it, and the ones that did
 *   start are stopped.
 * - The files server loads no document parser to start: they are most of its
 *   start time, and a boot extracts nothing.
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { EventSink } from "../../src/engine/types.ts";
import { startBoundServers, stopBoundServers } from "../../src/plugins/bound-servers.ts";
import { checkConfiguredPlugins, type ResolvedPlugins } from "../../src/plugins/index.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";

const sink: EventSink = { emit() {} };
const sign = () => "grant";
/** How long each server is held before it starts, in seconds. */
const HOLD_S = 1;

let workDir = "";
afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  workDir = "";
});

/** The default plugins, each server started through `wrap(command, args)` instead. */
function defaultsWith(wrap: (command: string, args: string[]) => [string, string[]]) {
  workDir = mkdtempSync(join(tmpdir(), "nb-bound-start-"));
  const resolved = checkConfiguredPlugins(undefined, { workDir }) as ResolvedPlugins;
  for (const plugin of resolved.plugins) {
    for (const server of Object.values(plugin.servers)) {
      const spec = server.spec;
      if (spec?.type !== "stdio") continue;
      const [command, args] = wrap(spec.command, spec.args ?? []);
      server.spec = { ...spec, command, args };
    }
  }
  return resolved;
}

/** `command args`, after `seconds` of sleep. */
const held =
  (seconds: number) =>
  (command: string, args: string[]): [string, string[]] => [
    "sh",
    ["-c", `sleep ${seconds}; exec "$0" "$@"`, command, ...args],
  ];

describe("startBoundServers", () => {
  it("starts the servers together, so boot waits for the slowest, not the sum", async () => {
    const resolved = defaultsWith(held(HOLD_S));
    expect(resolved.bindings.length).toBeGreaterThan(1);
    const started = performance.now();
    const bound = await startBoundServers(resolved, sink, new Map(), sign);
    const elapsed = performance.now() - started;
    try {
      expect([...bound.keys()]).toEqual(resolved.bindings.map((b) => b.contract));
      // In sequence, the holds alone would take bindings × HOLD_S.
      expect(elapsed).toBeLessThan((resolved.bindings.length - 0.5) * HOLD_S * 1000);
    } finally {
      await stopBoundServers(bound);
    }
  }, 20_000);

  it("refuses the boot naming a server that does not start, and stops the ones that did", async () => {
    const files = resolve(import.meta.dir, "../../packages/files/bin/nb-files");
    const resolved = defaultsWith((command, args) =>
      command === files ? ["/nonexistent/nb-files", args] : [command, args],
    );
    const stop = spyOn(McpSource.prototype, "stop");
    try {
      await expect(startBoundServers(resolved, sink, new Map(), sign)).rejects.toThrow(
        /ai\.nimblebrain\.files: the files plugin's server "files" did not start/,
      );
      expect(stop).toHaveBeenCalledTimes(resolved.bindings.length - 1);
    } finally {
      stop.mockRestore();
    }
  }, 20_000);
});

describe("the files server", () => {
  it("loads no document parser to start", () => {
    const server = resolve(import.meta.dir, "../../packages/files/src/server.ts");
    const probe = `await import(${JSON.stringify(server)});
console.log(Object.keys(require.cache).filter((k) => /unpdf|mammoth|xlsx/.test(k)).join("\\n"));`;
    const run = Bun.spawnSync(["bun", "--no-env-file", "-e", probe]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString().trim()).toBe("");
  });
});
