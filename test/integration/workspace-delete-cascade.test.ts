/**
 * Deleting a workspace runs the same teardown as removing each connector it
 * holds.
 *
 * Before this seam existed the ten steps of `handleUninstall` were inlined in
 * the tool and reachable from nowhere else, so a workspace delete archived the
 * subtree and left everything the connectors owned behind: the grants live at
 * the vendor, the sources registered, the hooks holding their key ids.
 *
 * Three things are pinned here, and each is the reason the cascade lives on the
 * runtime rather than in `WorkspaceStore`:
 *
 *   1. Every connector the workspace holds is torn down, through the one
 *      teardown the `uninstall` action uses.
 *   2. `on_removing` is delivered while the subtree is still at its live path.
 *      After the rename the bundle and its credentials both address a tree that
 *      has moved, so the order is the contract, not a preference.
 *   3. A connector that throws mid-teardown is reported and the workspace is
 *      still deleted. One unreachable vendor must not strand a workspace
 *      half-deleted.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Runtime } from "../../src/runtime/runtime.ts";
import { stopAllToolSurfaceWatches } from "../../src/tools/connector-surface.ts";
import type { Tool, ToolResult, ToolSource } from "../../src/tools/types.ts";
import { createEchoModel } from "../helpers/echo-model.ts";

const ADMIN = { id: "usr_admin", email: "admin@example.test" };
const WS_ID = "ws_helix";

/** `slugifyServerName` of each catalog id — what a ref's `serverName` records. */
const ALPHA = "com-example-alpha";
const BETA = "com-example-beta";
const REMOVING = "workspace_removing";

/** One trace entry per lifecycle call, with the fact the order exists to protect. */
interface Delivered {
  connector: string;
  /** Whether the workspace subtree was still at its live path when the call landed. */
  subtreeStillLive: boolean;
}

let workDir: string;
let catalogDir: string;
let previousCatalogDir: string | undefined;
let runtime: Runtime;
let delivered: Delivered[];

/**
 * Two catalog entries declaring `on_removing`. Read through the real projection
 * (`NB_CURATED_CATALOG_DIR`), so the declaration reaches the teardown the same
 * way an operator-published one does.
 */
function writeCatalog(dir: string): void {
  writeFileSync(
    join(dir, "curated.yaml"),
    `servers:
${[
  ["com.example/alpha", "Alpha", "https://alpha.example.test/mcp"],
  ["com.example/beta", "Beta", "https://beta.example.test/mcp"],
]
  .map(
    ([id, title, url]) => `  - name: ${id}
    title: ${title}
    description: Reference connector
    version: "1.0.0"
    remotes:
      - type: streamable-http
        url: ${url}
    _meta:
      ai.nimblebrain/connector:
        auth: dcr
      ai.nimblebrain/host:
        host_version: "1.4"
        lifecycle:
          on_removing: ${REMOVING}
`,
  )
  .join("")}`,
  );
}

/**
 * A source standing in for a running connector: it answers the lifecycle
 * handler and records whether the workspace subtree was still live when the
 * call arrived.
 *
 * `stop` is the failure injection point — `ToolRegistry.removeSource` awaits
 * it, so a throwing `stop` is a teardown that fails at the step the tool's own
 * try/catch wraps.
 */
function fakeSource(name: string, opts: { failStop?: boolean } = {}): ToolSource {
  // One-shot: `removeSource` throws before it drops the source, so the entry
  // survives the teardown and `runtime.shutdown()` stops it again in cleanup.
  let stopWillFail = opts.failStop === true;
  return {
    name,
    start: async () => {},
    stop: async () => {
      if (!stopWillFail) return;
      stopWillFail = false;
      throw new Error(`${name} would not stop`);
    },
    tools: async (): Promise<Tool[]> => [
      { name: REMOVING, description: "Lifecycle handler", inputSchema: {}, source: name },
    ],
    execute: async (): Promise<ToolResult> => {
      delivered.push({
        connector: name,
        subtreeStillLive: existsSync(join(workDir, "workspaces", WS_ID)),
      });
      return { content: [{ type: "text", text: "ok" }], isError: false };
    },
  };
}

/** Seat both connectors on the workspace record and in its registry. */
async function seedConnectors(opts: { failStopOn?: string } = {}): Promise<void> {
  await runtime.getWorkspaceStore().update(WS_ID, {
    connectors: [
      { url: "https://alpha.example.test/mcp", serverName: ALPHA },
      { url: "https://beta.example.test/mcp", serverName: BETA },
    ],
  });
  const registry = await runtime.ensureWorkspaceRegistry(WS_ID);
  for (const name of [ALPHA, BETA]) {
    registry.addSource(fakeSource(name, { failStop: opts.failStopOn === name }));
  }
}

beforeEach(async () => {
  delivered = [];
  workDir = mkdtempSync(join(tmpdir(), "nb-ws-delete-"));
  catalogDir = mkdtempSync(join(tmpdir(), "nb-ws-delete-catalog-"));
  mkdirSync(catalogDir, { recursive: true });
  writeCatalog(catalogDir);
  previousCatalogDir = process.env.NB_CURATED_CATALOG_DIR;
  process.env.NB_CURATED_CATALOG_DIR = catalogDir;

  runtime = await Runtime.start({
    model: { provider: "custom", adapter: createEchoModel() },
    logging: { disabled: true },
    workDir,
  });
  await runtime.getWorkspaceStore().create("Helix", "helix");
  await runtime.getWorkspaceStore().addMember(WS_ID, ADMIN.id, "admin");
});

afterEach(async () => {
  await runtime.shutdown();
  stopAllToolSurfaceWatches();
  if (previousCatalogDir === undefined) delete process.env.NB_CURATED_CATALOG_DIR;
  else process.env.NB_CURATED_CATALOG_DIR = previousCatalogDir;
  rmSync(workDir, { recursive: true, force: true });
  rmSync(catalogDir, { recursive: true, force: true });
});

test("tears down every connector the workspace holds, before the subtree is renamed", async () => {
  await seedConnectors();

  const result = await runtime.deleteWorkspace(WS_ID);

  expect(result.deleted).toBe(true);
  expect(result.connectors.map((c) => c.serverName)).toEqual([ALPHA, BETA]);
  expect(result.connectors.every((c) => c.ok)).toBe(true);

  // Both bundles were told, and both were told while they could still reach
  // their own credential directory. This is the assertion the ordering rule
  // exists for: after the rename, `on_removing` and the credential cleanup
  // inside `lifecycle.uninstall` both address a tree that has moved.
  expect(delivered).toEqual([
    { connector: ALPHA, subtreeStillLive: true },
    { connector: BETA, subtreeStillLive: true },
  ]);

  // And the sources are gone from the registry, not merely orphaned by the
  // record being archived.
  const registry = await runtime.ensureWorkspaceRegistry(WS_ID);
  expect(registry.hasSource(ALPHA)).toBe(false);
  expect(registry.hasSource(BETA)).toBe(false);

  expect(existsSync(join(workDir, "workspaces", WS_ID))).toBe(false);
  expect(existsSync(join(workDir, "archived", WS_ID))).toBe(true);
});

test("a connector that throws mid-teardown is reported, and the workspace still deletes", async () => {
  await seedConnectors({ failStopOn: ALPHA });

  const result = await runtime.deleteWorkspace(WS_ID);

  // Best-effort per connector: the failure is data, not an exception, so the
  // caller can name the connector whose grant may still be live at a vendor.
  const alpha = result.connectors.find((c) => c.serverName === ALPHA);
  expect(alpha?.ok).toBe(false);
  expect(alpha?.error).toContain("would not stop");

  // The one that follows it still ran — a throw stops its own connector's
  // teardown and nothing else.
  expect(result.connectors.find((c) => c.serverName === BETA)?.ok).toBe(true);
  expect(delivered.map((d) => d.connector)).toEqual([ALPHA, BETA]);

  expect(result.deleted).toBe(true);
  expect(existsSync(join(workDir, "workspaces", WS_ID))).toBe(false);
});

test("a workspace that does not exist reports not-deleted and tears down nothing", async () => {
  const result = await runtime.deleteWorkspace("ws_absent");

  expect(result.deleted).toBe(false);
  expect(result.connectors).toEqual([]);
  expect(delivered).toEqual([]);
});
