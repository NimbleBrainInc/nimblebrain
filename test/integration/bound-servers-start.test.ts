/**
 * Starting the bound servers at boot (`startBoundServers`).
 *
 * - The servers are separate processes, so they start together: boot waits for
 *   the slowest, not the sum. Every default plugin is one more server, and every
 *   `Runtime.start` (each integration test's) pays for the boot. The test holds
 *   each server until every one has been spawned, so it passes only when they
 *   are spawned together, whatever the machine's speed.
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
/** How long a held server waits for the others to be spawned before it gives up, in seconds. */
const BARRIER_S = 10;

let workDir = "";
afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  workDir = "";
});

/** The default plugins, each stdio server started through `wrap(count)(command, args)`, where `count` is how many there are. */
function defaultsWith(
  wrap: (count: number) => (command: string, args: string[]) => [string, string[]],
) {
  workDir = mkdtempSync(join(tmpdir(), "nb-bound-start-"));
  const resolved = checkConfiguredPlugins(undefined, { workDir }) as ResolvedPlugins;
  const servers = resolved.plugins
    .flatMap((plugin) => Object.values(plugin.servers))
    .filter((server) => server.spec?.type === "stdio");
  const each = wrap(servers.length);
  for (const server of servers) {
    const spec = server.spec;
    if (spec?.type !== "stdio") continue;
    const [command, args] = each(spec.command, spec.args ?? []);
    server.spec = { ...spec, command, args };
  }
  return resolved;
}

/**
 * `command args`, once `count` servers have been spawned: each marks `dir` when it
 * is spawned and waits for the others' marks. Started one after another, the
 * first never sees the rest and gives up after `BARRIER_S`, so its start fails.
 */
const barrier =
  (dir: string) =>
  (count: number) =>
  (command: string, args: string[]): [string, string[]] => [
    "sh",
    [
      "-c",
      `touch "${dir}/$$"; i=0; while [ "$(ls "${dir}" | wc -l)" -lt ${count} ]; do i=$((i+1)); [ $i -gt ${BARRIER_S * 20} ] && exit 1; sleep 0.05; done; exec "$0" "$@"`,
      command,
      ...args,
    ],
  ];

describe("startBoundServers", () => {
  it("starts the servers together, so boot waits for the slowest, not the sum", async () => {
    const marks = mkdtempSync(join(tmpdir(), "nb-bound-marks-"));
    try {
      const resolved = defaultsWith(barrier(marks));
      expect(resolved.bindings.length).toBeGreaterThan(1);
      const bound = await startBoundServers(resolved, sink, new Map(), sign);
      try {
        expect([...bound.keys()]).toEqual(resolved.bindings.map((b) => b.contract));
      } finally {
        await stopBoundServers(bound);
      }
    } finally {
      rmSync(marks, { recursive: true, force: true });
    }
  }, 30_000);

  it("refuses the boot naming a server that does not start, and stops the ones that did", async () => {
    const files = resolve(import.meta.dir, "../../packages/files/bin/nb-files");
    const resolved = defaultsWith(
      () => (command, args) =>
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
