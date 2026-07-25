/**
 * The boot loop must not discard an installed URL bundle whose endpoint happens
 * to be unreachable when it runs.
 *
 * A fleet service rolling at the same moment as the runtime loses this race
 * routinely: the runtime POSTs to it seconds before its pod is ready, the start
 * throws, and the bundle used to be dropped from the inventory entirely — which
 * cost it its lifecycle instance and its placements, so the app disappeared from
 * the shell and stayed gone until the pod restarted.
 *
 * `startWorkspaceBundles` reaches the network, so this is integration-tier.
 * Port 1 is reserved and closed, giving a fast, deterministic connection
 * refusal without standing up a server to then not answer.
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import type { BundleRef } from "../../src/bundles/types.ts";
import { startWorkspaceBundles } from "../../src/runtime/workspace-runtime.ts";
import { WorkspaceStore } from "../../src/workspace/workspace-store.ts";

const UNREACHABLE = "http://127.0.0.1:1/mcp";

let workDir: string;

/**
 * Bearer auth makes this a static-auth bundle, so the boot loop actually
 * attempts it. Without static auth it would take the "no tokens yet" skip and
 * never exercise the failure path at all.
 */
function unreachableBundle(serverName: string): BundleRef {
  return {
    url: UNREACHABLE,
    serverName,
    transport: { type: "streamable-http", auth: { type: "bearer", token: "test-token" } },
    oauthScope: "workspace",
    ui: {
      name: "Unreachable",
      placements: [{ slot: "sidebar.apps", resourceUri: "ui://unreachable/main", route: "u" }],
    },
  } as unknown as BundleRef;
}

beforeEach(() => {
  workDir = join(tmpdir(), `nb-boot-start-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(workDir, { recursive: true });
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("startWorkspaceBundles — unreachable URL bundle at boot", () => {
  test("failedUrlBundle_keepsInventoryEntryCarryingStartError", async () => {
    const store = new WorkspaceStore(workDir);
    const ws = await store.create("Fleet");
    await store.update(ws.id, { bundles: [unreachableBundle("unreachable")] });

    const { entries } = await startWorkspaceBundles(
      store,
      [],
      null,
      new NoopEventSink(),
      undefined,
      { workDir, allowInsecureRemotes: true },
    );

    const entry = entries.find((e) => e.serverName === "unreachable");
    expect(entry).toBeDefined();
    expect(entry?.startError).toBeTruthy();
    // The placements ride along on the surviving entry — this is what keeps the
    // app in the sidebar (and its route registered) while the source is down.
    expect(entry?.meta?.ui?.placements?.[0]?.resourceUri).toBe("ui://unreachable/main");
  }, 30_000);

  test("failedUrlBundle_isNotRegisteredAsASource", async () => {
    // Surviving the inventory is not the same as being usable: the source must
    // still be absent from the registry so callers get a clean "unavailable"
    // (and the self-heal a chance to run) rather than a half-started source.
    const store = new WorkspaceStore(workDir);
    const ws = await store.create("Fleet");
    await store.update(ws.id, { bundles: [unreachableBundle("unreachable")] });

    const { registries } = await startWorkspaceBundles(
      store,
      [],
      null,
      new NoopEventSink(),
      undefined,
      { workDir, allowInsecureRemotes: true },
    );

    expect(registries.get(ws.id)?.hasSource("unreachable")).toBe(false);
  }, 30_000);
});
