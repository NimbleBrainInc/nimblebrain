/**
 * Which connectors the poller may read.
 *
 * Three conditions, and each is somebody else's decision read back: the server
 * declared an outbox, the connection is `running` under the workspace
 * principal, and the workspace registry holds its source. A connector that
 * fails any of them is not skipped politely — it is never a target at all, so
 * there is no code path on which the poller could revive it.
 *
 * **Every case here seeds through the real boot path**, not a hand-built
 * `Connection`. That distinction is the whole point of this file: a
 * hand-assembled connection can be given a source that no code path actually
 * sets, and a suite built that way stays green over a poller that selects
 * nothing. So each test constructs a `BundleLifecycleManager`, registers the
 * source in the workspace registry the way a completed `startBundleSource`
 * leaves it, and calls `seedInstance` with the arguments the boot seeder
 * passes.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { NoopEventSink } from "../../../src/adapters/noop-events.ts";
import { WORKSPACE_PRINCIPAL_ID } from "../../../src/bundles/connection.ts";
import { BundleLifecycleManager } from "../../../src/bundles/lifecycle.ts";
import type { BundleRef, BundleState } from "../../../src/bundles/types.ts";
import { collectPollTargets } from "../../../src/notifications/targets.ts";
import type { NotificationsDeclaration } from "../../../src/notifications/types.ts";
import { McpSource } from "../../../src/tools/mcp-source.ts";
import { ToolRegistry } from "../../../src/tools/registry.ts";

const OUTBOX: NotificationsDeclaration = { resource: "acme://notifications" };
const declaresOutbox = async () => OUTBOX;
const declaresNothing = async () => undefined;

const URL_FOR = (serverName: string) => `https://${serverName}.invalid/mcp`;

/**
 * A provider-auth ref — the fleet shape. It carries its own credential, so the
 * boot seeder's readiness probe answers from the ref alone and seeds `running`
 * without reading a token file.
 */
function fleetRef(serverName: string): BundleRef {
  return {
    url: URL_FOR(serverName),
    serverName,
    transport: {
      type: "streamable-http",
      auth: { type: "provider", provider: "minted", config: { audience: "test" } },
    },
  };
}

/** The source object a completed `startBundleSource` leaves in the registry. */
function startedSource(serverName: string): McpSource {
  return new McpSource(
    serverName,
    { type: "remote", url: new URL(URL_FOR(serverName)) },
    new NoopEventSink(),
  );
}

let lifecycle: BundleLifecycleManager;
let registries: Map<string, ToolRegistry>;

beforeEach(() => {
  lifecycle = new BundleLifecycleManager(new NoopEventSink(), undefined);
  registries = new Map();
  lifecycle.bindWorkspaceRegistries(() => registries);
});

/**
 * A workspace's registry, created on demand — the way `Runtime` does it, by
 * adding to the map the lifecycle reads rather than handing it a new one.
 * Every workspace here is therefore provisioned the post-boot way.
 */
function registryFor(wsId: string): ToolRegistry {
  const existing = registries.get(wsId);
  if (existing) return existing;
  const registry = new ToolRegistry();
  registries.set(wsId, registry);
  return registry;
}

/**
 * Boot one connector into one workspace, the way the platform does: the boot
 * loop starts the source (leaving it registered under its server name), then
 * `seedWorkspaceBundleInstances` seeds the instance from the surviving
 * inventory entry.
 *
 * `started: false` is the install whose source never came up — the entry is
 * seeded all the same, because installed and running are independent facts.
 */
async function boot(
  serverName: string,
  opts: { wsId?: string; started?: boolean } = {},
): Promise<{ wsId: string; source: McpSource | null }> {
  const wsId = opts.wsId ?? "ws_one";
  const registry = registryFor(wsId);
  let source: McpSource | null = null;
  if (opts.started !== false) {
    source = startedSource(serverName);
    registry.addSource(source);
  }
  const ref = fleetRef(serverName);
  await lifecycle.seedInstance(serverName, ref.url, ref, undefined, wsId);
  return { wsId, source };
}

describe("collectPollTargets", () => {
  test("a boot-seeded fleet connector is a target", async () => {
    // The case the fixture-backed suite could not fail on: nothing in the boot
    // path hands the connection a source object, and the poller still has to
    // find one.
    const { source } = await boot("acme");

    const targets = await collectPollTargets(lifecycle, declaresOutbox);

    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      wsId: "ws_one",
      serverName: "acme",
      resource: "acme://notifications",
    });
    expect(targets[0]?.source).toBe(source as McpSource);
  });

  test("the boot seed really did record `running` under the workspace principal", async () => {
    // Guards the premise of every other case: if the seeder ever stopped
    // recording `running` here, the tests above would pass by seeding nothing.
    await boot("acme");

    const connection = lifecycle
      .getInstance("acme", "ws_one")
      ?.connections?.get(WORKSPACE_PRINCIPAL_ID);

    expect(connection?.state).toBe("running");
  });

  test("the source is resolved on every sweep, never held", async () => {
    // The meaning of `running`: the credential is good and a source is
    // registered — not "here is a handle". A reconnect replaces the source
    // wholesale (`adoptSource` swaps the registry entry and stops the
    // predecessor), so a target built from a reference captured at connect
    // time would keep reading a stopped object forever.
    await boot("acme");
    const reconnected = startedSource("acme");
    await registryFor("ws_one").adoptSource(reconnected);

    const targets = await collectPollTargets(lifecycle, declaresOutbox);

    expect(targets).toHaveLength(1);
    expect(targets[0]?.source).toBe(reconnected);
  });

  test("the registries are asked for on every sweep, not captured at wiring time", async () => {
    // A workspace can be provisioned at any point after the wiring —
    // `ensureWorkspaceRegistry` adds its registry to whatever map the runtime
    // holds — and the lifecycle has to poll its connectors like any other.
    // Asking the runtime each time is what makes that true for any way the map
    // can move, so this exercises the harder one: replaced wholesale between
    // the two workspaces. Against a reference captured at wiring time, or a
    // copy of the contents, `ws_provisioned_later` is skipped silently.
    await boot("acme", { wsId: "ws_at_boot" });
    registries = new Map(registries);
    await boot("acme", { wsId: "ws_provisioned_later" });

    const targets = await collectPollTargets(lifecycle, declaresOutbox);

    expect(targets.map((t) => t.wsId).sort()).toEqual(["ws_at_boot", "ws_provisioned_later"]);
  });

  test("a connector whose source is not registered is not a target", async () => {
    // `running` with nothing in the registry is a real state — an install whose
    // eager start failed reads exactly this. The poller skips it and lets the
    // machinery that owns recovery do its job.
    await boot("acme", { started: false });

    expect(await collectPollTargets(lifecycle, declaresOutbox)).toEqual([]);
  });

  test("never polls a connector that declares no outbox", async () => {
    await boot("acme");

    expect(await collectPollTargets(lifecycle, declaresNothing)).toEqual([]);
  });

  test.each<BundleState>([
    "starting",
    "pending_auth",
    "reauth_required",
    "not_authenticated",
    "crashed",
    "dead",
    "stopped",
  ])("skips a connection in state %s", async (state) => {
    await boot("acme");
    lifecycle.recordConnectionStateChange("acme", "ws_one", WORKSPACE_PRINCIPAL_ID, state);

    expect(await collectPollTargets(lifecycle, declaresOutbox)).toEqual([]);
  });

  test("skips a per-user connection", async () => {
    // An outbox belongs to the workspace that installed the connector. Reading
    // one as a member would file the workspace's notifications under whoever
    // happened to be connected.
    await boot("acme");
    lifecycle.recordConnectionStateChange(
      "acme",
      "ws_one",
      WORKSPACE_PRINCIPAL_ID,
      "not_authenticated",
    );
    lifecycle.recordConnectionStateChange("acme", "ws_one", "usr_1", "running");

    expect(await collectPollTargets(lifecycle, declaresOutbox)).toEqual([]);
  });

  test("resolves each connector's declaration once, however many workspaces hold it", async () => {
    await boot("acme", { wsId: "ws_one" });
    await boot("acme", { wsId: "ws_two" });
    await boot("acme", { wsId: "ws_three" });

    let lookups = 0;
    const targets = await collectPollTargets(lifecycle, async () => {
      lookups++;
      return OUTBOX;
    });

    expect(targets).toHaveLength(3);
    expect(lookups).toBe(1);
  });
});
