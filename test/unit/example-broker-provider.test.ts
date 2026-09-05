/**
 * The acceptance test for the brokered seam: a THIRD provider, added as one
 * object registered under one id, reaches install, liveness probing, teardown
 * and boot-state derivation without a line of kernel code knowing it exists.
 *
 * `example-broker` is defined entirely in this file. Nothing under `src/` names
 * it — no ref block, no auth-kind literal, no arm in the lifecycle or the tool
 * layer, no entry in a credential-path allowlist. If any of that were still
 * required, this file could not be written.
 *
 * It also pins the shapes the seam is deliberately generous about: the catalog
 * block is opaque (this provider's coordinates are nothing like Composio's), and
 * `providerRef` is opaque both ways (the kernel persists it and hands it back
 * without reading a key).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { brokeredConnectorDir } from "../../src/bundles/brokered.ts";
import { WORKSPACE_PRINCIPAL_ID } from "../../src/bundles/connection.ts";
import type { ConnectionLiveness, ProbeTarget } from "../../src/bundles/connection-probe.ts";
import { BundleLifecycleManager } from "../../src/bundles/lifecycle.ts";
import type { BundleRef } from "../../src/bundles/types.ts";
import type {
  BrokeredStateOptions,
  ManagedConnectorProvider,
} from "../../src/connectors/providers/managed-provider.ts";
import { managedConnectorRegistryOf } from "../../src/connectors/providers/registry.ts";
import { ConnectorDirectory } from "../../src/registries/directory.ts";
import { RegistryStore } from "../../src/registries/registry-store.ts";
import type { DirectoryEntry } from "../../src/registries/types.ts";
import type { Runtime } from "../../src/runtime/runtime.ts";
import {
  createManageConnectorsTool,
  type ManageConnectorsContext,
} from "../../src/tools/connector-tools.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { WorkspaceStore } from "../../src/workspace/workspace-store.ts";

const PROVIDER_ID = "example-broker";
const CONNECTOR_ID = "com.example/widgets";
const ADMIN = { id: "usr_admin", name: "Admin", email: "admin@test" };

// ── The provider ────────────────────────────────────────────────────
//
// Its coordinates are deliberately unlike either shipped provider's: the catalog
// block names a `realm` and a `widget`, and the session comes back identified by
// a `lease` — a shape no kernel type could have anticipated.

interface BrokerCalls {
  sessions: Array<{ userId: string; connectorId: string; config: Record<string, unknown> }>;
  cleanups: BrokeredStateOptions[];
  probed: ProbeTarget[];
}

function exampleBroker(
  calls: BrokerCalls,
  opts: { liveness?: ConnectionLiveness; connectedLeases?: Set<string> } = {},
): ManagedConnectorProvider {
  return {
    id: PROVIDER_ID,

    userId: (owner) => (owner.type === "workspace" ? `ws:${owner.wsId}` : `u:${owner.userId}`),

    createSession: async (o) => {
      calls.sessions.push({ userId: o.userId, connectorId: o.connectorId, config: o.config });
      const realm = String(o.config.realm ?? "");
      const widget = String(o.config.widget ?? "");
      if (!realm || !widget) throw new Error("example-broker: config needs `realm` and `widget`.");
      const lease = `${realm}.${widget}.${o.userId}`;
      return {
        type: "http",
        url: `https://broker.example/${realm}/${lease}/mcp`,
        credentialProvider: PROVIDER_ID,
        providerRef: { lease, realm },
      };
    },

    cleanup: async (o) => {
      calls.cleanups.push(o);
      return { upstreamDeleted: true, localDeleted: false };
    },

    hasConnection: (o) => (opts.connectedLeases ?? new Set()).has(o.brokered.providerRef?.lease ?? ""),

    probe: () => ({
      providerId: PROVIDER_ID,
      probe: async (target) => {
        calls.probed.push(target);
        return opts.liveness ?? "live";
      },
    }),
  };
}

function noCalls(): BrokerCalls {
  return { sessions: [], cleanups: [], probed: [] };
}

// ── Harness ─────────────────────────────────────────────────────────

interface Harness {
  workDir: string;
  wsId: string;
  workspaceStore: WorkspaceStore;
  lifecycle: BundleLifecycleManager;
  runtime: Runtime;
}

function catalogYaml(): string {
  return [
    "servers:",
    `  - name: ${CONNECTOR_ID}`,
    "    title: Widgets",
    "    description: Widgets, brokered",
    '    version: "1.0.0"',
    "    remotes:",
    "      - type: streamable-http",
    "        url: https://widgets.example/mcp",
    "    _meta:",
    "      ai.nimblebrain/connector:",
    // The auth kind IS the provider id, and the block sits under that same key.
    // That convention is the whole extension mechanism.
    `        auth: ${PROVIDER_ID}`,
    `        ${PROVIDER_ID}:`,
    "          realm: acme",
    "          widget: sprockets",
    "",
  ].join("\n");
}

function buildHarness(provider: ManagedConnectorProvider): Harness {
  const workDir = mkdtempSync(join(tmpdir(), "nb-example-broker-"));
  const wsId = "ws_test";
  const workspaceStore = new WorkspaceStore(workDir);
  writeFileSync(
    join(workDir, "registries.json"),
    JSON.stringify({
      registries: [
        {
          id: "bundled-static",
          name: "Curated",
          type: "static",
          enabled: true,
          locked: true,
          url: join(workDir, "catalog.yaml"),
        },
      ],
    }),
  );
  writeFileSync(join(workDir, "catalog.yaml"), catalogYaml());

  const registryStore = new RegistryStore(workDir);
  const registry = managedConnectorRegistryOf([provider]);
  const lifecycle = new BundleLifecycleManager(new NoopEventSink(), undefined);
  lifecycle.setManagedConnectorRegistry(registry);
  lifecycle.setWorkDir(workDir);
  const workspaceRegistry = new ToolRegistry();

  const runtime = {
    getWorkDir: () => workDir,
    getWorkspaceStore: () => workspaceStore,
    getRegistryStore: () => registryStore,
    getConnectorDirectory: () => new ConnectorDirectory(registryStore),
    getLifecycle: () => lifecycle,
    getRegistryForWorkspace: () => workspaceRegistry,
    getAllowInsecureRemotes: () => false,
    getEventSink: () => new NoopEventSink(),
    getPermissionStore: () => ({
      deleteConnector: async () => {},
      listConnectorGrants: async () => ({}),
      getConnectorGrants: async () => [],
      revokeConnector: async () => {},
    }),
    getUserStore: () => ({ get: async () => null }),
    getBundleInstancesForWorkspace: () => lifecycle.getInstances(),
    getManagedConnectorRegistry: () => registry,
  } as unknown as Runtime;

  return { workDir, wsId, workspaceStore, lifecycle, runtime };
}

function buildTool(h: Harness) {
  return createManageConnectorsTool({
    runtime: h.runtime,
    getIdentity: () => ADMIN,
    getWorkspaceId: () => h.wsId,
  } as unknown as ManageConnectorsContext);
}

function widgetsEntry(): DirectoryEntry {
  return {
    id: CONNECTOR_ID,
    name: "Widgets",
    description: "Widgets, brokered",
    registryId: "bundled-static",
    install: {
      kind: "remote-oauth",
      url: "https://widgets.example/mcp",
      transportType: "streamable-http",
      auth: PROVIDER_ID,
      [PROVIDER_ID]: { realm: "acme", widget: "sprockets" },
    },
  } as unknown as DirectoryEntry;
}

/** The ref an install of this connector persists. */
function installedRef(): BundleRef {
  return {
    url: "https://broker.example/acme/acme.sprockets.ws:ws_test/mcp",
    serverName: "com-example-widgets",
    oauthScope: "workspace",
    transport: {
      type: "streamable-http",
      auth: { type: "provider", provider: PROVIDER_ID, config: {} },
    },
    brokered: {
      provider: PROVIDER_ID,
      connectorId: CONNECTOR_ID,
      providerRef: { lease: "acme.sprockets.ws:ws_test", realm: "acme" },
    },
  };
}

let h: Harness;
let calls: BrokerCalls;

afterEach(() => {
  rmSync(h.workDir, { recursive: true, force: true });
});

// ── Install ─────────────────────────────────────────────────────────

describe("example-broker — install", () => {
  beforeEach(async () => {
    calls = noCalls();
    h = buildHarness(exampleBroker(calls));
    await h.workspaceStore.create("Test", h.wsId.slice(3));
    await h.workspaceStore.addMember(h.wsId, ADMIN.id, "admin");
  });

  test("mints a session from its own catalog block and persists one brokered ref", async () => {
    await buildTool(h).handler({ action: "install", entry: widgetsEntry(), wsId: h.wsId });

    // The kernel handed the block through verbatim without reading a key.
    expect(calls.sessions).toHaveLength(1);
    expect(calls.sessions[0]?.connectorId).toBe(CONNECTOR_ID);
    expect(calls.sessions[0]?.config).toEqual({ realm: "acme", widget: "sprockets" });
    expect(calls.sessions[0]?.userId).toBe("ws:ws_test");

    const ws = await h.workspaceStore.get(h.wsId);
    const ref = ws?.bundles.find((b) => b.brokered !== undefined);
    expect(ref?.brokered?.provider).toBe(PROVIDER_ID);
    expect(ref?.brokered?.connectorId).toBe(CONNECTOR_ID);
    // Opaque both ways: persisted exactly as returned.
    expect(ref?.brokered?.providerRef).toEqual({
      lease: "acme.sprockets.ws:ws_test",
      realm: "acme",
    });
    // The session URL, not the catalog placeholder.
    expect(ref?.url).toContain("/acme.sprockets.ws:ws_test/mcp");
    // The transport names the provider's credential — no secret at rest.
    expect(ref?.transport?.auth).toEqual({ type: "provider", provider: PROVIDER_ID, config: {} });
  });

  test("refuses an entry the trusted catalog doesn't publish, without calling the broker", async () => {
    const forged = widgetsEntry();
    forged.id = "attacker.example/forged";

    const result = await buildTool(h).handler({
      action: "install",
      entry: forged,
      wsId: h.wsId,
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("is not a recognized");
    expect(JSON.stringify(result.content)).toContain(PROVIDER_ID);
    expect(calls.sessions).toHaveLength(0);
  });

  test("refuses when no provider is registered for the kind", async () => {
    const bare = buildHarness({ ...exampleBroker(calls), id: "some-other-broker" });
    try {
      await bare.workspaceStore.create("Test", bare.wsId.slice(3));
      await bare.workspaceStore.addMember(bare.wsId, ADMIN.id, "admin");
      const result = await buildTool(bare).handler({
        action: "install",
        entry: widgetsEntry(),
        wsId: bare.wsId,
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("is brokered by");
      expect(JSON.stringify(result.content)).toContain("EXAMPLE_BROKER_API_KEY");
    } finally {
      rmSync(bare.workDir, { recursive: true, force: true });
    }
  });
});

// ── Probe ───────────────────────────────────────────────────────────

describe("example-broker — probe", () => {
  beforeEach(() => {
    calls = noCalls();
    h = buildHarness(exampleBroker(calls, { liveness: "credential_lost" }));
  });

  test("the registered probe is dispatched by the ref's provider id", async () => {
    const provider = h.runtime.getManagedConnectorRegistry().get(PROVIDER_ID);
    const probe = provider?.probe?.(h.runtime.getConnectorDirectory());
    expect(probe?.providerId).toBe(PROVIDER_ID);

    const target: ProbeTarget = {
      serverName: "com-example-widgets",
      wsId: h.wsId,
      principalId: WORKSPACE_PRINCIPAL_ID,
      ref: installedRef(),
    };
    const verdict = await probe?.probe(target, new AbortController().signal);

    expect(verdict).toBe("credential_lost");
    // The probe reads its own opaque coordinates off the ref it was handed.
    expect(calls.probed[0]?.ref.brokered?.providerRef?.lease).toBe("acme.sprockets.ws:ws_test");
  });
});

// ── Cleanup ─────────────────────────────────────────────────────────

describe("example-broker — cleanup on uninstall", () => {
  beforeEach(async () => {
    calls = noCalls();
    h = buildHarness(exampleBroker(calls));
    await h.workspaceStore.create("Test", h.wsId.slice(3));
    await h.workspaceStore.addMember(h.wsId, ADMIN.id, "admin");
  });

  test("uninstall calls the provider's cleanup and clears its credential directory", async () => {
    const ref = installedRef();
    await h.lifecycle.seedInstance("com-example-widgets", ref.url ?? "", ref, undefined, h.wsId);

    // Provider-owned local state, at the directory rule the kernel owns.
    const dir = brokeredConnectorDir(
      h.workDir,
      { type: "workspace", wsId: h.wsId },
      PROVIDER_ID,
      CONNECTOR_ID,
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "lease.json"), "{}\n");

    await h.lifecycle.uninstall("com-example-widgets", new ToolRegistry(), h.wsId);

    expect(calls.cleanups).toHaveLength(1);
    expect(calls.cleanups[0]?.brokered.connectorId).toBe(CONNECTOR_ID);
    expect(calls.cleanups[0]?.owner).toEqual({ type: "workspace", wsId: h.wsId });
    expect(existsSync(dir)).toBe(false);
  });
});

// ── Boot-state derivation ───────────────────────────────────────────

describe("example-broker — boot-state derivation", () => {
  afterEach(() => {
    /* h cleaned by the outer afterEach */
  });

  test("an unconnected connector seeds not_authenticated despite static transport auth", async () => {
    calls = noCalls();
    h = buildHarness(exampleBroker(calls, { connectedLeases: new Set() }));
    const ref = installedRef();
    await h.lifecycle.seedInstance("com-example-widgets", ref.url ?? "", ref, undefined, h.wsId);

    const conn = h.lifecycle
      .getInstance("com-example-widgets", h.wsId)
      ?.connections.get(WORKSPACE_PRINCIPAL_ID);
    expect(conn?.state).toBe("not_authenticated");
  });

  test("a connected connector seeds running", async () => {
    calls = noCalls();
    h = buildHarness(
      exampleBroker(calls, { connectedLeases: new Set(["acme.sprockets.ws:ws_test"]) }),
    );
    const ref = installedRef();
    await h.lifecycle.seedInstance("com-example-widgets", ref.url ?? "", ref, undefined, h.wsId);

    const conn = h.lifecycle
      .getInstance("com-example-widgets", h.wsId)
      ?.connections.get(WORKSPACE_PRINCIPAL_ID);
    expect(conn?.state).toBe("running");
  });
});
