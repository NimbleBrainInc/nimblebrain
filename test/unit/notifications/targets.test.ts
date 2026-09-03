/**
 * Which connectors the poller may read.
 *
 * Three conditions, and each is somebody else's decision read back: the server
 * declared an outbox, the connection is `running`, and it is the workspace
 * principal's. A source that fails any of them is not skipped politely — it is
 * never a target at all, so there is no code path on which the poller could
 * revive it.
 */

import { describe, expect, test } from "bun:test";
import type { Connection } from "../../../src/bundles/connection.ts";
import { WORKSPACE_PRINCIPAL_ID } from "../../../src/bundles/connection.ts";
import type { BundleLifecycleManager } from "../../../src/bundles/lifecycle.ts";
import type { BundleInstance, BundleState } from "../../../src/bundles/types.ts";
import { collectPollTargets } from "../../../src/notifications/targets.ts";
import type { NotificationsDeclaration } from "../../../src/notifications/types.ts";
import type { McpSource } from "../../../src/tools/mcp-source.ts";

const OUTBOX: NotificationsDeclaration = { resource: "acme://notifications" };

/** A stand-in source object: identity is all the enumeration reads. */
function fakeSource(name: string): McpSource {
  return { name } as unknown as McpSource;
}

function instance(
  serverName: string,
  opts: {
    wsId?: string;
    state?: BundleState;
    principalId?: string;
    source?: McpSource | null;
  } = {},
): BundleInstance {
  const connection: Connection = {
    principalId: opts.principalId ?? WORKSPACE_PRINCIPAL_ID,
    state: opts.state ?? "running",
    source: opts.source === undefined ? fakeSource(serverName) : opts.source,
  };
  return {
    serverName,
    bundleName: `@test/${serverName}`,
    version: "1.0.0",
    state: connection.state,
    ui: null,
    briefing: null,
    wsId: opts.wsId ?? "ws_one",
    connections: new Map([[connection.principalId, connection]]),
  };
}

function lifecycleOver(instances: BundleInstance[]): BundleLifecycleManager {
  return { getInstances: () => instances } as unknown as BundleLifecycleManager;
}

const declaresOutbox = async () => OUTBOX;
const declaresNothing = async () => undefined;

describe("collectPollTargets", () => {
  test("returns a running workspace connection that declares an outbox", async () => {
    const targets = await collectPollTargets(
      lifecycleOver([instance("acme")]),
      declaresOutbox,
    );
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      wsId: "ws_one",
      serverName: "acme",
      resource: "acme://notifications",
    });
  });

  test("never polls a connector that declares no outbox", async () => {
    expect(await collectPollTargets(lifecycleOver([instance("acme")]), declaresNothing)).toEqual(
      [],
    );
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
    const targets = await collectPollTargets(
      lifecycleOver([instance("acme", { state })]),
      declaresOutbox,
    );
    expect(targets).toEqual([]);
  });

  test("skips a per-user connection", async () => {
    // An outbox belongs to the workspace that installed the connector. Reading
    // one as a member would file the workspace's notifications under whoever
    // happened to be connected.
    const targets = await collectPollTargets(
      lifecycleOver([instance("acme", { principalId: "usr_1" })]),
      declaresOutbox,
    );
    expect(targets).toEqual([]);
  });

  test("skips a running connection with no source object", async () => {
    const targets = await collectPollTargets(
      lifecycleOver([instance("acme", { source: null })]),
      declaresOutbox,
    );
    expect(targets).toEqual([]);
  });

  test("resolves each connector's declaration once, however many workspaces hold it", async () => {
    let lookups = 0;
    const targets = await collectPollTargets(
      lifecycleOver([
        instance("acme", { wsId: "ws_one" }),
        instance("acme", { wsId: "ws_two" }),
        instance("acme", { wsId: "ws_three" }),
      ]),
      async () => {
        lookups++;
        return OUTBOX;
      },
    );
    expect(targets).toHaveLength(3);
    expect(lookups).toBe(1);
  });
});
