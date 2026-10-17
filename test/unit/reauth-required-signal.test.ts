/**
 * A connection whose credential was rejected reads the same before and after a
 * restart: `reauth_required` in the lifecycle, counted by
 * `nb_connector_reauth_required`, left alone by `HealthMonitor` and by
 * `tryRecoverSource`, and absent from `nb_connector_unhealthy`, which is a
 * transport outage only.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import {
  connectorReauthRequired,
  connectorUnhealthy,
  registerConnectorHealthGauge,
  registerConnectorReauthGauge,
} from "../../src/api/metrics.ts";
import type { ManagedConnectorProvider } from "../../src/connectors/providers/managed-provider.ts";
import { managedConnectorRegistryOf } from "../../src/connectors/providers/registry.ts";
import { ConnectorLifecycleManager } from "../../src/connectors/runtime/lifecycle.ts";
import type { ConnectorRef } from "../../src/connectors/runtime/types.ts";
import { HealthMonitor } from "../../src/tools/health-monitor.ts";
import { hasMcpOAuthAuthLost, McpOAuthRecords } from "../../src/tools/mcp-oauth-records.ts";
import type { McpSource } from "../../src/tools/mcp-source.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import type { WorkspaceOAuthProvider } from "../../src/tools/workspace-oauth-provider.ts";
import {
  installTestCredentialStore,
  resetTestCredentialStore,
} from "../helpers/credential-store.ts";
import { stub } from "../helpers/stub.ts";
import { seedWorkspaceRoot } from "../helpers/test-workspace.ts";

const WS = "ws_0b7c1e5a9d3f4e21";
const SERVER = "remote-thing";
const OWNER = { type: "workspace", wsId: WS } as const;

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "nb-reauth-signal-"));
  seedWorkspaceRoot(workDir, WS);
  installTestCredentialStore(workDir);
});

afterEach(() => {
  resetTestCredentialStore();
  rmSync(workDir, { recursive: true, force: true });
});

// Leave both gauges inert for other files sharing the process-global registry.
afterAll(() => {
  registerConnectorHealthGauge(() => []);
  registerConnectorReauthGauge(() => []);
});

function oauthRef(): ConnectorRef {
  return { url: "https://example.invalid/mcp", serverName: SERVER };
}

function records(): McpOAuthRecords {
  return new McpOAuthRecords({ owner: OWNER, serverName: SERVER });
}

/** A lifecycle as a fresh process builds it: nothing in memory. */
function freshLifecycle(): ConnectorLifecycleManager {
  const lifecycle = new ConnectorLifecycleManager(new NoopEventSink());
  lifecycle.setWorkDir(workDir);
  return lifecycle;
}

function connectionState(lifecycle: ConnectorLifecycleManager): string | undefined {
  return lifecycle.getInstance(SERVER, WS)?.connections?.get("_workspace")?.state;
}

async function readGauge(
  gauge: typeof connectorReauthRequired | typeof connectorUnhealthy,
  source: string,
): Promise<number | undefined> {
  const metric = await gauge.get();
  return metric.values.find((v) => v.labels.source === source)?.value;
}

/** A source stand-in with the liveness surface `HealthMonitor` reads. */
function downSource(name: string): McpSource & { restartCalls: number; alive: boolean } {
  const s = Object.assign(
    stub<McpSource>({
      name,
      isAlive: () => s.alive,
      isStopped: () => false,
      uptime: () => null,
      restart: async () => {
        s.restartCalls++;
        s.alive = true;
        return true;
      },
    }),
    { restartCalls: 0, alive: false },
  );
  return s;
}

describe("nb_connector_reauth_required", () => {
  test("test_reauthGauge_afterRestartWithAuthLostAndNoTokens_reportsOne", async () => {
    // The SDK deleted the rejected tokens; only the flag is left. Boot skips the
    // start (no tokens), so no source is registered, and the seed decides.
    await records().write("auth_lost", { at: "2026-01-01T00:00:00.000Z" });
    const lifecycle = freshLifecycle();
    await lifecycle.seedInstance(SERVER, SERVER, oauthRef(), undefined, WS);

    expect(connectionState(lifecycle)).toBe("reauth_required");
    registerConnectorReauthGauge(() =>
      lifecycle.reauthRequiredConnections().map((c) => c.serverName),
    );
    expect(await readGauge(connectorReauthRequired, SERVER)).toBe(1);
  });

  test("test_reauthGauge_afterReconnect_seriesDisappears", async () => {
    const lifecycle = freshLifecycle();
    await lifecycle.seedInstance(SERVER, SERVER, oauthRef(), undefined, WS);
    lifecycle.recordConnectionStateChange(SERVER, WS, "_workspace", "reauth_required");
    registerConnectorReauthGauge(() =>
      lifecycle.reauthRequiredConnections().map((c) => c.serverName),
    );
    expect(await readGauge(connectorReauthRequired, SERVER)).toBe(1);

    lifecycle.recordConnectionStateChange(SERVER, WS, "_workspace", "running");
    expect(await readGauge(connectorReauthRequired, SERVER)).toBeUndefined();
  });
});

describe("HealthMonitor and a connection awaiting Reconnect", () => {
  test("test_healthMonitor_awaitingReconnect_doesNotRestartAndIsNotUnhealthy", async () => {
    const source = downSource(SERVER);
    let awaiting = true;
    const monitor = new HealthMonitor(() => [source], new NoopEventSink(), {
      checkIntervalMs: 60_000,
      baseDelayMs: 1,
      awaitingReconnect: (s) => awaiting && s === source,
    });
    registerConnectorHealthGauge(() => monitor.getStatus());

    // Seeded from the predicate, not as `restarting`, so the gauge never asserts.
    expect(monitor.getStatus()[0]?.state).toBe("awaiting_reconnect");
    expect(await readGauge(connectorUnhealthy, SERVER)).toBeUndefined();

    for (let i = 0; i < 3; i++) await monitor.check();
    expect(source.restartCalls).toBe(0);
    expect(monitor.getStatus()[0]).toMatchObject({
      state: "awaiting_reconnect",
      restartCount: 0,
    });
    expect(await readGauge(connectorUnhealthy, SERVER)).toBeUndefined();

    // The same source object returns to `running` (a broker's Reconnect keeps
    // it): the monitor handles it as usual again.
    awaiting = false;
    await monitor.check();
    expect(source.restartCalls).toBe(1);
    expect(monitor.getStatus()[0]?.state).toBe("healthy");
  });

  test("test_healthMonitor_awaitingReconnect_matchesBySourceIdentity", async () => {
    // Two workspaces, one connector name: only the one whose connection lost
    // its credential is left alone.
    const waiting = downSource(SERVER);
    const other = downSource(SERVER);
    const monitor = new HealthMonitor(() => [waiting, other], new NoopEventSink(), {
      checkIntervalMs: 60_000,
      baseDelayMs: 1,
      awaitingReconnect: (s) => s === waiting,
    });
    await monitor.check();
    expect(waiting.restartCalls).toBe(0);
    expect(other.restartCalls).toBe(1);
  });
});

describe("tryRecoverSource and a connection awaiting Reconnect", () => {
  test("test_tryRecoverSource_reauthRequiredAfterRestart_doesNotReRegister", async () => {
    await records().write("auth_lost", { at: "2026-01-01T00:00:00.000Z" });
    const lifecycle = freshLifecycle();
    const registry = new ToolRegistry();
    lifecycle.bindWorkspaceRegistries(() => new Map([[WS, registry]]));
    await lifecycle.seedInstance(SERVER, SERVER, oauthRef(), undefined, WS);
    let respawns = 0;
    // biome-ignore lint/suspicious/noExplicitAny: override the re-spawn the wrapper would call
    (lifecycle as any).ensureSourceRegistered = async () => {
      respawns++;
    };

    expect(await lifecycle.tryRecoverSource(SERVER, WS, workDir)).toBe(false);
    expect(respawns).toBe(0);
    expect(registry.hasSource(SERVER)).toBe(false);
  });
});

describe("a failed Reconnect while auth_lost is set", () => {
  async function failReconnect(lifecycle: ConnectorLifecycleManager): Promise<void> {
    const source = stub<McpSource>({
      start: async () => {
        throw new Error("invalid_grant");
      },
      isStopped: () => false,
    });
    const provider = stub<WorkspaceOAuthProvider>({ setInteractiveAuthAllowed: () => {} });
    let settled!: () => void;
    const done = new Promise<void>((r) => {
      settled = r;
    });
    // biome-ignore lint/complexity/useLiteralKeys: `startAuthBackground` is private; bracket access is TypeScript's typed path to it
    lifecycle["startAuthBackground"]({
      source,
      provider,
      serverName: SERVER,
      wsId: WS,
      principalId: "_workspace",
      getCapturedAuthUrl: () => undefined,
      resolveAuthUrl: () => settled(),
      rejectAuthUrl: () => settled(),
    });
    await done;
  }

  test("test_failedReconnect_withAuthLost_keepsReauthRequired", async () => {
    await records().write("auth_lost", { at: "2026-01-01T00:00:00.000Z" });
    const lifecycle = freshLifecycle();
    await lifecycle.seedInstance(SERVER, SERVER, oauthRef(), undefined, WS);
    expect(connectionState(lifecycle)).toBe("reauth_required");

    await failReconnect(lifecycle);

    // Same as the boot seed would record from the same flag after a restart.
    expect(connectionState(lifecycle)).toBe("reauth_required");
    const restarted = freshLifecycle();
    await restarted.seedInstance(SERVER, SERVER, oauthRef(), undefined, WS);
    expect(connectionState(restarted)).toBe("reauth_required");
  });

  test("test_failedReconnect_withoutAuthLost_recordsDead", async () => {
    await records().write("tokens", { access_token: "t" });
    const lifecycle = freshLifecycle();
    await lifecycle.seedInstance(SERVER, SERVER, oauthRef(), undefined, WS);

    await failReconnect(lifecycle);

    expect(connectionState(lifecycle)).toBe("dead");
  });
});

describe("a brokered connection's lost credential", () => {
  const BROKER = "example-broker";

  function brokeredRef(): ConnectorRef {
    return {
      url: "https://broker.test/session/abc/mcp",
      serverName: SERVER,
      brokered: { provider: BROKER, connectorId: SERVER },
    };
  }

  /** A lifecycle whose broker still holds a local account for the connection. */
  function brokeredLifecycle(): ConnectorLifecycleManager {
    const broker: ManagedConnectorProvider = {
      id: BROKER,
      userId: (owner) => (owner.type === "workspace" ? owner.wsId : owner.userId),
      createSession: async () => ({ type: "http", url: "https://broker.test/session/abc/mcp" }),
      hasConnection: () => true,
    };
    const lifecycle = freshLifecycle();
    lifecycle.setManagedConnectorRegistry(managedConnectorRegistryOf([broker]));
    return lifecycle;
  }

  async function settleWrites(lifecycle: ConnectorLifecycleManager): Promise<void> {
    // biome-ignore lint/complexity/useLiteralKeys: the write chain is private; bracket access is TypeScript's typed path to it
    await Promise.all([...lifecycle["credentialLossWrites"].values()]);
  }

  test("test_brokeredFlip_survivesRestart_untilReconnect", async () => {
    const before = brokeredLifecycle();
    await before.seedInstance(SERVER, SERVER, brokeredRef(), undefined, WS);
    expect(connectionState(before)).toBe("running");

    // The revalidator's flip.
    before.recordConnectionStateChange(SERVER, WS, "_workspace", "reauth_required");
    await settleWrites(before);
    expect(await hasMcpOAuthAuthLost(OWNER, SERVER)).toBe(true);

    const afterRestart = brokeredLifecycle();
    await afterRestart.seedInstance(SERVER, SERVER, brokeredRef(), undefined, WS);
    expect(connectionState(afterRestart)).toBe("reauth_required");

    // The broker's Reconnect lands.
    afterRestart.recordConnectionStateChange(SERVER, WS, "_workspace", "running");
    await settleWrites(afterRestart);
    expect(await hasMcpOAuthAuthLost(OWNER, SERVER)).toBe(false);

    const afterSecondRestart = brokeredLifecycle();
    await afterSecondRestart.seedInstance(SERVER, SERVER, brokeredRef(), undefined, WS);
    expect(connectionState(afterSecondRestart)).toBe("running");
  });
});
