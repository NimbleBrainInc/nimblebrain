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
import { ARCHIVE_MARKER_FILENAME } from "../../src/workspace/workspace-store.ts";
import { stopAllToolSurfaceWatches } from "../../src/tools/connector-surface.ts";
import type { ManagedConnectorProvider } from "../../src/connectors/providers/managed-provider.ts";
import { managedConnectorRegistryOf } from "../../src/connectors/providers/registry.ts";
import { brokeredConnectorDir } from "../../src/connectors/runtime/brokered.ts";
import type { ConnectorRef } from "../../src/connectors/runtime/types.ts";
import type { Tool, ToolResult, ToolSource } from "../../src/tools/types.ts";
import { createEchoModel } from "../helpers/echo-model.ts";

const ADMIN = { id: "usr_admin", email: "admin@example.test" };
const WS_ID = "ws_helix";

/** `slugifyServerName` of each catalog id — what a ref's `serverName` records. */
const ALPHA = "com-example-alpha";
const BETA = "com-example-beta";
const GAMMA = "com-example-gamma";
/** A broker defined entirely in this file — no kernel code names it. */
const BROKER = "example-broker";
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
/** Sources whose `stop` throws right now — the teardown-failure injection. */
let failingStops: Set<string>;

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
function fakeSource(name: string): ToolSource {
  return {
    name,
    start: async () => {},
    stop: async () => {
      // Driven by a live set rather than a one-shot latch: the delete stops a
      // source TWICE (the upstream revoke tears the connection's source down,
      // then `lifecycle.uninstall` removes it from the registry), and a latch
      // spent on the first would leave the second — the step the guarded block
      // actually wraps — succeeding. The test clears the set before shutdown.
      if (failingStops.has(name)) throw new Error(`${name} would not stop`);
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

function refFor(serverName: string, url: string): ConnectorRef {
  return { url, serverName };
}

/**
 * Seat both connectors the way an install leaves them: on the workspace record,
 * in the workspace registry, AND as a lifecycle instance.
 *
 * The instance is not decoration. `uninstallWorkspaceConnector` reads it to
 * decide whether to revoke upstream, and `lifecycle.uninstall` reads it to
 * reach `cleanupConnectorCredentials` → `cleanupBrokeredState`. Without one,
 * both steps are skipped and the teardown still reports `ok` — so a test that
 * omits it asserts the local bookkeeping and silently covers none of the
 * vendor-facing half.
 */
async function seedConnectors(): Promise<void> {
  const refs = [
    refFor(ALPHA, "https://alpha.example.test/mcp"),
    refFor(BETA, "https://beta.example.test/mcp"),
  ];
  await runtime.getWorkspaceStore().update(WS_ID, { connectors: refs });
  const registry = await runtime.ensureWorkspaceRegistry(WS_ID);
  for (const ref of refs) {
    const name = ref.serverName as string;
    registry.addSource(fakeSource(name));
    await runtime.getLifecycle().seedInstance(name, ref.url as string, ref, undefined, WS_ID);
  }
}

beforeEach(async () => {
  delivered = [];
  failingStops = new Set();
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

  // `ok` is the local teardown. `revoked` present is what says the upstream
  // revoke was actually attempted — it is absent when the lifecycle held no
  // instance, which is the shape a test can pass while covering none of the
  // vendor-facing half.
  expect(result.connectors.every((c) => c.revoked !== undefined)).toBe(true);

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
  await seedConnectors();
  failingStops.add(ALPHA);

  const result = await runtime.deleteWorkspace(WS_ID);
  // Cleared before `afterEach` shuts the runtime down — the throw leaves the
  // source in the registry, so shutdown stops it once more.
  failingStops.clear();

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

test("reaches the broker's revoke for a brokered connector, and clears its credential dir", async () => {
  // The one join nothing else covers: the unit suite drives the seam directly,
  // and the cascade resolves a row's name with a DIFFERENT predicate
  // (`serverNameFromRef`) than the seam matches rows with (`matchesServerName`).
  // If those two ever disagree, this is where a brokered grant is left live at
  // the vendor with the record that named it archived.
  const cleanups: Array<{ connectorId: string; wsId: string }> = [];
  const provider: ManagedConnectorProvider = {
    id: BROKER,
    userId: (owner) => (owner.type === "workspace" ? `ws:${owner.wsId}` : `u:${owner.userId}`),
    createSession: async () => ({ url: "https://broker.example.test/mcp" }),
    cleanup: async ({ owner, brokered }) => {
      cleanups.push({
        connectorId: brokered.connectorId,
        wsId: owner.type === "workspace" ? owner.wsId : "",
      });
      return { upstreamDeleted: true, localDeleted: true };
    },
  };
  runtime.getLifecycle().setManagedConnectorRegistry(managedConnectorRegistryOf([provider]));

  const ref: ConnectorRef = {
    url: "https://broker.example.test/mcp",
    serverName: GAMMA,
    brokered: { provider: BROKER, connectorId: "com.example/gamma" },
  };
  await runtime.getWorkspaceStore().update(WS_ID, { connectors: [ref] });
  const registry = await runtime.ensureWorkspaceRegistry(WS_ID);
  registry.addSource(fakeSource(GAMMA));
  await runtime.getLifecycle().seedInstance(GAMMA, ref.url as string, ref, undefined, WS_ID);

  // Provider-owned local state, at the directory rule the kernel owns.
  const dir = brokeredConnectorDir(
    workDir,
    { type: "workspace", wsId: WS_ID },
    BROKER,
    "com.example/gamma",
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "lease.json"), "{}\n");

  const result = await runtime.deleteWorkspace(WS_ID);

  expect(result.deleted).toBe(true);
  expect(cleanups).toEqual([{ connectorId: "com.example/gamma", wsId: WS_ID }]);
  expect(existsSync(dir)).toBe(false);
});

test("an archive that cannot be written reports the teardown it already ran", async () => {
  await seedConnectors();
  // `archived/` occupied by a regular file: the rename throws AFTER every
  // connector is torn down. Before this cascade existed a failed delete was a
  // true no-op, so an exception carrying none of this would tell an operator
  // nothing happened while the workspace sits on disk with its grants revoked.
  writeFileSync(join(workDir, "archived"), "not a directory\n");

  const result = await runtime.deleteWorkspace(WS_ID);

  expect(result.deleted).toBe(false);
  expect(result.deleteError).toBeDefined();
  // The teardown is in the result, not lost with the throw.
  expect(result.connectors.map((c) => c.serverName)).toEqual([ALPHA, BETA]);
  expect(result.connectors.every((c) => c.ok)).toBe(true);
  // And it really did run — the workspace survives, gutted.
  expect(existsSync(join(workDir, "workspaces", WS_ID))).toBe(true);
  expect((await runtime.getWorkspaceStore().get(WS_ID))?.connectors ?? []).toHaveLength(0);
});

test("a failure on the FAR side of the rename reports the teardown too", async () => {
  await seedConnectors();
  // The store throws on both sides of its rename, and the two leave the
  // workspace in opposite places. The test above is the near side (the
  // destination cannot be resolved, nothing moved); this is the far side — the
  // subtree moves, then the archive marker cannot be written because a
  // directory squats its path. The result must carry the teardown either way,
  // which is why `handleDelete` names the teardown and not where the record
  // landed.
  mkdirSync(join(workDir, "workspaces", WS_ID, ARCHIVE_MARKER_FILENAME), { recursive: true });

  const result = await runtime.deleteWorkspace(WS_ID);

  expect(result.deleted).toBe(false);
  expect(result.deleteError).toBeDefined();
  expect(result.connectors.map((c) => c.serverName)).toEqual([ALPHA, BETA]);
  expect(result.connectors.every((c) => c.ok)).toBe(true);
  // Unlike the near side, the subtree really did move — an operator told the
  // record survived would go looking for a workspace that is already archived.
  expect(existsSync(join(workDir, "workspaces", WS_ID))).toBe(false);
  expect(existsSync(join(workDir, "archived", WS_ID))).toBe(true);
  expect(await runtime.getWorkspaceStore().get(WS_ID)).toBeNull();
});

test("a workspace that does not exist reports not-deleted and tears down nothing", async () => {
  const result = await runtime.deleteWorkspace("ws_absent");

  expect(result.deleted).toBe(false);
  expect(result.connectors).toEqual([]);
  expect(delivered).toEqual([]);
});
