/**
 * Unit tests for `BundleLifecycleManager.respawnBundle`. Pins:
 *
 *   1. Missing instance → returns `{ ok: false }` with a clear error.
 *   2. Protected bundles refuse to respawn (the contract for platform-
 *      critical apps that must not be torn down mid-call).
 *   3. The per-(serverName, wsId) mutex serializes concurrent respawns —
 *      a second call waits for the first to complete before starting,
 *      eliminating the half-state window between `removeSource` and the
 *      new spawn.
 *   4. Errors from `startBundleSource` land the instance in `dead`
 *      state and bubble back through the structured result.
 *
 * The actual `startBundleSource` integration is covered by
 * `test/integration/configure-credentials.test.ts` — this file focuses
 * on the new mutex + error-path semantics that don't need a live
 * subprocess to exercise.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { BundleLifecycleManager } from "../../src/bundles/lifecycle.ts";
import type { BundleInstance } from "../../src/bundles/types.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import type { Tool, ToolSource } from "../../src/tools/types.ts";

let workDir: string;
let lifecycle: BundleLifecycleManager;
let registry: ToolRegistry;
const wsId = "ws_test";
const serverName = "test-bundle";
const bundleName = "@test/test-bundle";

function makeStubSource(name: string): ToolSource {
  return {
    name,
    async start(): Promise<void> {},
    async stop(): Promise<void> {},
    async tools(): Promise<Tool[]> {
      return [];
    },
    async execute(): Promise<never> {
      throw new Error("not implemented");
    },
  };
}

/**
 * Seed a BundleInstance directly into the lifecycle's instances map
 * via reflection. Avoids invoking `installNamed`, which would require
 * a real mpak cache + manifest. We're testing respawn-time behavior,
 * not install-time wiring.
 */
function seedInstance(opts: { protected?: boolean } = {}): BundleInstance {
  const instance: BundleInstance = {
    serverName,
    bundleName,
    version: "1.0.0",
    state: "running",
    trustScore: null,
    ui: null,
    briefing: null,
    httpProxy: null,
    protected: opts.protected ?? false,
    type: "plain",
    wsId,
  };
  // `instances` is private; reach in for the seed. This mirrors how
  // tests on the existing health-monitor + state-transition code
  // reach in to verify state changes.
  (lifecycle as unknown as { instances: Map<string, BundleInstance> }).instances.set(
    `${serverName}|${wsId}`,
    instance,
  );
  return instance;
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "lifecycle-respawn-"));
  lifecycle = new BundleLifecycleManager(new NoopEventSink(), undefined);
  registry = new ToolRegistry();
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("lifecycle.respawnBundle — guards", () => {
  test("returns error when no instance exists for (serverName, wsId)", async () => {
    const result = await lifecycle.respawnBundle("missing", wsId, registry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/No bundle instance for "missing"/);
    }
  });

  test("refuses to respawn a protected bundle", async () => {
    seedInstance({ protected: true });
    registry.addSource(makeStubSource(serverName));

    const result = await lifecycle.respawnBundle(serverName, wsId, registry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/protected/);
    }
    // Protected bundle's source stays in the registry untouched.
    expect(registry.hasSource(serverName)).toBe(true);
  });
});

describe("lifecycle.respawnBundle — failure path", () => {
  test("startBundleSource failure transitions instance to 'dead' and returns error", async () => {
    const instance = seedInstance();
    registry.addSource(makeStubSource(serverName));

    // No bundle in the mpak cache for "@test/test-bundle" → startBundleSource
    // throws when prepareServer can't find it. We're verifying the error
    // is captured and the instance is marked dead, not the specific
    // error string mpak emits.
    const result = await lifecycle.respawnBundle(serverName, wsId, registry);
    expect(result.ok).toBe(false);
    expect(instance.state).toBe("dead");
  });
});

describe("lifecycle.respawnBundle — concurrency", () => {
  test("max-1-in-flight: concurrent respawns for the same key never overlap inside removeSource", async () => {
    seedInstance();

    // Wrap the registry's removeSource to count in-flight invocations.
    // The mutex's job is to ensure the stop/start critical section of
    // one respawn completes before another can start. If `removeSource`
    // ever sees two simultaneous callers, the mutex is broken.
    let inFlight = 0;
    let maxInFlight = 0;
    const slowSource: ToolSource = {
      name: serverName,
      async start(): Promise<void> {},
      async stop(): Promise<void> {
        // Short delay so a broken mutex would have time to race.
        await new Promise((r) => setTimeout(r, 30));
      },
      async tools(): Promise<Tool[]> {
        return [];
      },
      async execute(): Promise<never> {
        throw new Error("not implemented");
      },
    };
    registry.addSource(slowSource);
    const originalRemove = registry.removeSource.bind(registry);
    registry.removeSource = async (name: string) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        return await originalRemove(name);
      } finally {
        inFlight--;
        // After the first call removes the source, the second call
        // will find no source to remove — but it'll still try, so
        // re-add the stub for the next iteration.
        if (!registry.hasSource(serverName)) {
          registry.addSource({
            ...slowSource,
            name: serverName,
          });
        }
      }
    };

    const [r1, r2] = await Promise.all([
      lifecycle.respawnBundle(serverName, wsId, registry),
      lifecycle.respawnBundle(serverName, wsId, registry),
    ]);

    expect(maxInFlight).toBe(1); // mutex held: never two removeSource simultaneously
    expect(r1.ok).toBe(false); // both fail at startBundleSource (no real bundle)
    expect(r2.ok).toBe(false);
  });

  test("respawn map drops the key after the last queued op resolves", async () => {
    seedInstance();
    await lifecycle.respawnBundle(serverName, wsId, registry);
    const locks = (lifecycle as unknown as { respawnLocks: Map<string, unknown> }).respawnLocks;
    expect(locks.has(`${serverName}|${wsId}`)).toBe(false);
  });
});
