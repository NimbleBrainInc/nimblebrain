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
import { log } from "../../src/observability/log.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { startWorkspaceBundles } from "../../src/runtime/workspace-runtime.ts";
import { WorkspaceStore } from "../../src/workspace/workspace-store.ts";
import { createEchoModel } from "../helpers/echo-model.ts";

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

  test("bootToSeededConnection_recordsDeadEndToEnd", async () => {
    // The two halves — the entry carries `startError`, and `seedInstance(…,
    // startError)` records `dead` — are each pinned in isolation. This pins the
    // JOIN, which is a single argument in `seedWorkspaceBundleInstances`.
    // Dropping it type-checks and leaves every other suite green, and the
    // resulting behavior is not merely unpinned but WRONG: the seeder falls
    // through to the auth-derived branch and a static-auth bundle seeds
    // `running` while dead, which `seedInstance_withoutStartError_
    // stillRecordsRunning` actively certifies as correct.
    const store = new WorkspaceStore(workDir);
    const ws = await store.create("Fleet");
    await store.update(ws.id, { bundles: [unreachableBundle("unreachable")] });

    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
      logging: { disabled: true },
      allowInsecureRemotes: true,
      workDir,
    });
    try {
      const connection = runtime
        .getLifecycle()
        .getInstance("unreachable", ws.id)
        ?.connections?.get("_workspace");
      expect(connection?.state).toBe("dead");
      expect(connection?.lastError).toBeTruthy();
    } finally {
      await runtime.shutdown();
    }
  }, 30_000);

  test("startedCount_excludesTheFailedBundleAndNamesIt", async () => {
    // This line is the only boot-time signal that a dependency was unreachable —
    // it is how the staging incident was found. A surviving entry would inflate
    // it back to "1/1" and hide exactly that. Same log-swap idiom as
    // mcp-server-endpoint.test.ts.
    const store = new WorkspaceStore(workDir);
    const ws = await store.create("Fleet");
    await store.update(ws.id, { bundles: [unreachableBundle("unreachable")] });

    const lines: string[] = [];
    const origInfo = log.info;
    log.info = (msg: string) => lines.push(msg);
    try {
      await startWorkspaceBundles(store, [], null, new NoopEventSink(), undefined, {
        workDir,
        allowInsecureRemotes: true,
      });
    } finally {
      log.info = origInfo;
    }

    const summary = lines.find((l) => l.includes("bundles in"));
    expect(summary).toContain("Started 0/1 bundles");
    expect(summary).toContain("1 failed to start");
    // It must not promise a retry: recovery runs through the app's own doors, so
    // a UI-less bundle has nothing to trigger it and stays down until restart.
    expect(summary).not.toContain("retried");
  }, 30_000);

  test("failedNamedBundle_isDroppedNotKept", async () => {
    // The asymmetry is deliberate. Only a URL ref reaches
    // `seedUrlConnectionState`, and `buildSeededInstance` hardcodes
    // `state: "running"` — so keeping a named bundle's entry would seed a
    // permanently *running* instance for a dead bundle. Pins the invariant
    // against a future edit that "unifies" the two branches.
    const store = new WorkspaceStore(workDir);
    const ws = await store.create("Fleet");
    await store.update(ws.id, {
      bundles: [{ name: "@nimblebrain/does-not-exist" } as unknown as BundleRef],
    });

    const { entries } = await startWorkspaceBundles(
      store,
      [],
      null,
      new NoopEventSink(),
      undefined,
      { workDir, allowInsecureRemotes: true },
    );

    expect(entries.find((e) => e.serverName.includes("does-not-exist"))).toBeUndefined();
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
