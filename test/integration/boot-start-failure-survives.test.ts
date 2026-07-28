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
import { startBundleSource } from "../../src/bundles/startup.ts";
import type { ToolRegistry } from "../../src/tools/registry.ts";
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

/**
 * `hasLiveSource` is private — reached deliberately to document the contrast that
 * justifies `hasEstablishedSource`. `tsconfig` does not cover `test/`, so a bare
 * call would compile by omission rather than by intent.
 */
function liveness(registry: ToolRegistry, name: string): boolean {
  return (registry as unknown as { hasLiveSource: (n: string) => boolean }).hasLiveSource(name);
}

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
    // The ref rides along on the surviving entry, carrying the placements that
    // keep the app in the shell. `bootToSeededConnection_recordsDeadEndToEnd`
    // asserts they actually reach the placement registry; this only pins that
    // the entry still holds the ref they come from.
    expect(entry?.bundle && "ui" in entry.bundle && entry.bundle.ui?.placements?.[0]).toBeTruthy();
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

      // The headline user-visible effect: the app stays in the shell. The
      // placement registry is what the sidebar and the route table read, so it
      // is the outcome — asserting the entry's `meta.ui` instead would measure a
      // mirror that `buildSeededInstance` never consults (it reads `ref.ui`).
      const placements = runtime.getPlacementRegistry().forWorkspace(ws.id);
      expect(placements.map((p) => p.resourceUri)).toContain("ui://unreachable/main");
    } finally {
      await runtime.shutdown();
    }
  }, 30_000);

  test("noTokenBundle_seedsNotAuthenticatedAndIsNotCountedAsAFailure", async () => {
    // `unstartedUrlBundleEntry` serves two callers — the skip (no tokens yet)
    // and the failure — and only the failure passes `startError`. Passing one
    // here instead type-checks and leaves every suite green, but a freshly
    // installed connector would seed `dead`: the Connectors page would offer
    // Reconnect where it should offer Connect, and boot would report a failure
    // for a bundle it never attempted. The skip path needs its own pin.
    const store = new WorkspaceStore(workDir);
    const ws = await store.create("Fleet");
    // No transport auth and no persisted tokens, so boot skips it entirely.
    await store.update(ws.id, {
      bundles: [
        {
          url: UNREACHABLE,
          serverName: "no-tokens",
          transport: { type: "streamable-http" },
          oauthScope: "workspace",
        } as unknown as BundleRef,
      ],
    });

    const lines: string[] = [];
    const origInfo = log.info;
    log.info = (msg: string) => lines.push(msg);
    let runtime: Runtime;
    try {
      runtime = await Runtime.start({
        model: { provider: "custom", adapter: createEchoModel() },
        noDefaultBundles: true,
        logging: { disabled: true },
        allowInsecureRemotes: true,
        workDir,
      });
    } finally {
      log.info = origInfo;
    }

    try {
      const connection = runtime
        .getLifecycle()
        .getInstance("no-tokens", ws.id)
        ?.connections?.get("_workspace");
      expect(connection?.state).toBe("not_authenticated");
      expect(connection?.lastError).toBeFalsy();

      const summary = lines.find((l) => l.includes("bundles in"));
      expect(summary).not.toContain("failed to start");
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
    // The line reports the count and the tally, and promises nothing about
    // recovery — which is a different subsystem's business.
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

  test("failedUrlBundle_isRegisteredButNotLive", async () => {
    // The boot loop keeps the source REGISTERED so the bundle stays visible to
    // every registry-enumerating surface and HealthMonitor can heal it. What
    // used to make that unsafe was the self-heal gating on membership; those
    // gates now test whether a source was ever ESTABLISHED, so a retained-but-down source
    // still reads "unavailable" to callers and still gets recovered.
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

    const registry = registries.get(ws.id);
    // Present — that is the whole point of the change.
    expect(registry?.hasSource("unreachable")).toBe(true);
    // But not live, and never established, so nothing treats it as usable and
    // no self-heal is skipped.
    expect(liveness(registry as ToolRegistry, "unreachable")).toBe(false);
    expect(registry?.hasEstablishedSource("unreachable")).toBe(false);
  }, 30_000);

  test("failedRecoveryAttempt_leavesTheRetainedSourceIntact", async () => {
    // A recovery attempt made while the endpoint is STILL down must be a no-op,
    // not a downgrade. Evicting first would `stop()` the retained source — the
    // durable marker HealthMonitor reads as terminal — so one app-open during an
    // outage would have undone the retention permanently and put the bundle back
    // in the pre-change trap with no path out.
    const store = new WorkspaceStore(workDir);
    const ws = await store.create("Fleet");
    await store.update(ws.id, { bundles: [unreachableBundle("still-down")] });

    const { registries } = await startWorkspaceBundles(
      store,
      [],
      null,
      new NoopEventSink(),
      undefined,
      { workDir, allowInsecureRemotes: true },
    );
    const registry = registries.get(ws.id);
    const retained = registry?.getSource("still-down");
    expect(retained).toBeDefined();

    // What recovery does: re-run the start against the same registry, with the
    // retention flag set. The endpoint is still unreachable, so it fails.
    await Promise.allSettled([
      startBundleSource(
        { url: "http://127.0.0.1:1/mcp", serverName: "still-down" },
        registry as ToolRegistry,
        new NoopEventSink(),
        undefined,
        { allowInsecureRemotes: true, wsId: ws.id, workDir, keepRegisteredOnStartFailure: true },
      ),
    ]);

    // Same object, still registered, still not deliberately stopped.
    expect(registry?.getSource("still-down")).toBe(retained);
    expect(registry?.hasSource("still-down")).toBe(true);
    expect((retained as unknown as { isStopped: () => boolean }).isStopped()).toBe(false);
  }, 30_000);
});
