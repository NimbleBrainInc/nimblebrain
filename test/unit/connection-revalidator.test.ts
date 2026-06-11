import { describe, expect, it } from "bun:test";
import type {
  ConnectionHealthProbe,
  ConnectionLiveness,
  ProbeTarget,
} from "../../src/bundles/connection-probe.ts";
import { ConnectionRevalidator } from "../../src/bundles/connection-revalidator.ts";
import type { BundleLifecycleManager } from "../../src/bundles/lifecycle.ts";
import type { ConnectionState } from "../../src/bundles/connection.ts";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeConn {
  principalId: string;
  state: ConnectionState;
}
interface FakeInstance {
  serverName: string;
  wsId: string;
  state: ConnectionState;
  ref: unknown;
  connections: Map<string, FakeConn>;
}

interface Flip {
  serverName: string;
  wsId: string;
  principalId: string;
  newState: ConnectionState;
}

function composioInstance(serverName: string, wsId = "ws_1"): FakeInstance {
  return {
    serverName,
    wsId,
    state: "running",
    ref: { url: "https://backend.composio.dev/x/mcp", composio: { connectorId: "com.x" } },
    connections: new Map([[`_workspace`, { principalId: "_workspace", state: "running" }]]),
  };
}

function fakeLifecycle(instances: FakeInstance[]) {
  const flips: Flip[] = [];
  const lifecycle = {
    getInstances: () => instances,
    getInstance: (serverName: string, wsId: string) =>
      instances.find((i) => i.serverName === serverName && i.wsId === wsId),
    recordConnectionStateChange: (
      serverName: string,
      wsId: string,
      principalId: string,
      newState: ConnectionState,
    ) => {
      flips.push({ serverName, wsId, principalId, newState });
      // Reflect the flip so the connection is no longer "running".
      const inst = instances.find((i) => i.serverName === serverName && i.wsId === wsId);
      const conn = inst?.connections.get(principalId);
      if (conn) conn.state = newState;
      if (inst) inst.state = newState;
    },
  } as unknown as BundleLifecycleManager;
  return { lifecycle, flips };
}

/** Probe whose verdict for every target is whatever `current` holds — flip
 *  between sweeps to script a sequence. */
class ScriptedProbe implements ConnectionHealthProbe {
  readonly providerId = "composio";
  current: ConnectionLiveness = "live";
  calls: ProbeTarget[] = [];
  async probe(target: ProbeTarget): Promise<ConnectionLiveness> {
    this.calls.push(target);
    return this.current;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConnectionRevalidator — anti-flap streak", () => {
  it("flips to reauth_required only after 2 consecutive credential_lost", async () => {
    const { lifecycle, flips } = fakeLifecycle([composioInstance("teams")]);
    const probe = new ScriptedProbe();
    const rv = new ConnectionRevalidator(lifecycle, [probe]);

    probe.current = "credential_lost";
    await rv.sweep();
    expect(flips).toHaveLength(0); // streak 1

    await rv.sweep();
    expect(flips).toHaveLength(1); // streak 2 → flip
    expect(flips[0]).toMatchObject({ serverName: "teams", newState: "reauth_required" });
  });

  it("a `live` verdict resets the streak", async () => {
    const { lifecycle, flips } = fakeLifecycle([composioInstance("teams")]);
    const probe = new ScriptedProbe();
    const rv = new ConnectionRevalidator(lifecycle, [probe]);

    probe.current = "credential_lost";
    await rv.sweep(); // streak 1
    probe.current = "live";
    await rv.sweep(); // reset
    probe.current = "credential_lost";
    await rv.sweep(); // streak 1 again

    expect(flips).toHaveLength(0);
  });

  it("`indeterminate` preserves the streak (no-op, not a reset)", async () => {
    const { lifecycle, flips } = fakeLifecycle([composioInstance("teams")]);
    const probe = new ScriptedProbe();
    const rv = new ConnectionRevalidator(lifecycle, [probe]);

    probe.current = "credential_lost";
    await rv.sweep(); // streak 1
    probe.current = "indeterminate";
    await rv.sweep(); // streak stays 1
    probe.current = "credential_lost";
    await rv.sweep(); // streak 2 → flip

    expect(flips).toHaveLength(1);
  });
});

describe("ConnectionRevalidator — circuit breaker", () => {
  it("aborts the sweep and flips nothing when too many would flip at once", async () => {
    const instances = Array.from({ length: 10 }, (_, i) => composioInstance(`c${i}`));
    const { lifecycle, flips } = fakeLifecycle(instances);
    const probe = new ScriptedProbe();
    const rv = new ConnectionRevalidator(lifecycle, [probe]);

    probe.current = "credential_lost";
    await rv.sweep(); // all streak 1, no candidates
    await rv.sweep(); // all streak 2 → 10 candidates > breaker(5) → abort

    expect(flips).toHaveLength(0);
  });
});

describe("ConnectionRevalidator — dispatch & filtering", () => {
  it("never probes a non-running connection", async () => {
    const inst = composioInstance("teams");
    inst.state = "reauth_required";
    inst.connections.get("_workspace")!.state = "reauth_required";
    const { lifecycle, flips } = fakeLifecycle([inst]);
    const probe = new ScriptedProbe();
    const rv = new ConnectionRevalidator(lifecycle, [probe]);

    probe.current = "credential_lost";
    await rv.sweep();

    expect(probe.calls).toHaveLength(0);
    expect(flips).toHaveLength(0);
  });

  it("never probes a connection with no matching provider probe", async () => {
    const inst = composioInstance("plain");
    inst.ref = { url: "https://example.com/mcp" }; // no composio field
    const { lifecycle, flips } = fakeLifecycle([inst]);
    const probe = new ScriptedProbe();
    const rv = new ConnectionRevalidator(lifecycle, [probe]);

    probe.current = "credential_lost";
    await rv.sweep();
    await rv.sweep();

    expect(probe.calls).toHaveLength(0);
    expect(flips).toHaveLength(0);
  });

  it("start() is a no-op when no probes are registered", () => {
    const { lifecycle } = fakeLifecycle([composioInstance("teams")]);
    const rv = new ConnectionRevalidator(lifecycle, []);
    expect(() => {
      rv.start();
      rv.stop();
    }).not.toThrow();
  });
});
