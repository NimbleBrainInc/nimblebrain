import { beforeEach, describe, expect, test } from "bun:test";
import { BundleLifecycleManager } from "../../src/bundles/lifecycle.ts";
import type { BundleRef } from "../../src/bundles/types.ts";
import type { EngineEvent, EventSink } from "../../src/engine/types.ts";

/**
 * A remote bundle whose endpoint is unreachable during the boot loop — a fleet
 * service that was mid-rollout when the runtime came up — used to be dropped for
 * the whole process lifetime: no lifecycle instance, no placements, no recovery.
 * The app vanished from the shell and the route it owned rendered blank.
 *
 * It is now seeded like any other installed bundle, carrying `startError`. These
 * tests pin the two halves of that: the Connection must reflect the failure
 * rather than inheriting the auth-derived `running`, and the instance must exist
 * so `tryRecoverSource` has a ref to re-spawn from.
 */

class CapturingSink implements EventSink {
  events: EngineEvent[] = [];
  emit(event: EngineEvent): void {
    this.events.push(event);
  }
}

const WS = "ws_test";
const SERVER = "ai-nimblebrain-memory-mcp";

/**
 * A remote bundle carrying its own credential (`provider` auth) — the fleet
 * shape. Static auth is what makes this interesting: it auto-connects, so the
 * auth-derived branch would call it `running` and only `startError` can say
 * otherwise.
 */
function fleetRef(): BundleRef {
  return {
    url: "http://mcp-memory.mcp-shared.svc.cluster.local/mcp",
    serverName: SERVER,
    transport: {
      type: "streamable-http",
      auth: { type: "provider", provider: "minted", config: { audience: "mcp-fleet" } },
    },
    oauthScope: "workspace",
  } as BundleRef;
}

function connectionOf(lifecycle: BundleLifecycleManager) {
  return lifecycle.getInstance(SERVER, WS)?.connections?.get("_workspace");
}

describe("boot-start failure — seeding an installed-but-not-running URL bundle", () => {
  let sink: CapturingSink;
  let lifecycle: BundleLifecycleManager;

  beforeEach(() => {
    sink = new CapturingSink();
    lifecycle = new BundleLifecycleManager(sink, undefined);
  });

  test("seedInstance_withStartError_recordsDeadNotRunning", () => {
    lifecycle.seedInstance(
      SERVER,
      "http://mcp-memory.mcp-shared.svc.cluster.local/mcp",
      fleetRef(),
      undefined,
      WS,
      undefined,
      'Streamable HTTP error: Error POSTing to endpoint: {"error":"bad_gateway"}',
    );

    const connection = connectionOf(lifecycle);
    expect(connection?.state).toBe("dead");
    expect(connection?.lastError).toContain("bad_gateway");
  });

  test("seedInstance_withoutStartError_stillRecordsRunning", () => {
    // The static-auth bundle auto-connects, so a clean boot must still land on
    // `running` — the failure branch must not swallow the happy path.
    lifecycle.seedInstance(
      SERVER,
      "http://mcp-memory.mcp-shared.svc.cluster.local/mcp",
      fleetRef(),
      undefined,
      WS,
    );

    expect(connectionOf(lifecycle)?.state).toBe("running");
  });

  test("seedInstance_withStartError_keepsInstanceAndRefForRecovery", () => {
    // `tryRecoverSource` resolves the URL ref off the seeded instance and
    // declines when there isn't one. Dropping the entry is what made the old
    // failure permanent, so the instance surviving IS the recovery precondition.
    lifecycle.seedInstance(
      SERVER,
      "http://mcp-memory.mcp-shared.svc.cluster.local/mcp",
      fleetRef(),
      undefined,
      WS,
      undefined,
      "connect ECONNREFUSED",
    );

    const instance = lifecycle.getInstance(SERVER, WS);
    expect(instance).toBeDefined();
    expect(instance?.ref && "url" in instance.ref).toBe(true);
  });

  test("seedInstance_withStartError_emitsStateChangeCarryingTheError", () => {
    lifecycle.seedInstance(
      SERVER,
      "http://mcp-memory.mcp-shared.svc.cluster.local/mcp",
      fleetRef(),
      undefined,
      WS,
      undefined,
      "connect ECONNREFUSED",
    );

    const events = sink.events.filter((e) => e.type === "connection.state_changed");
    expect(events.length).toBe(1);
    expect(events[0]!.data).toMatchObject({
      wsId: WS,
      serverName: SERVER,
      state: "dead",
    });
  });
});
