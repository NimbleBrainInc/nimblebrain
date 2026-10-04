/**
 * One poller sweep reads the connector catalog once.
 *
 * A catalog read is synchronous (directory listing, parse, schema validation),
 * and a sweep resolves a declaration for every `(workspace, connector)` pair.
 * A read per lookup blocks the event loop for the length of the whole sweep,
 * which on a tenant with many installs is long enough to stall every chat. So
 * each sweep opens one catalog and hands it to every lookup. Which connectors
 * become targets is `notifications/targets.test.ts`'s subject; this file pins
 * only the sharing.
 */

import { describe, expect, test } from "bun:test";
import { WORKSPACE_PRINCIPAL_ID } from "../../../../src/connectors/runtime/connection.ts";
import { pollTargets } from "../../../../src/platform/notifications/source.ts";
import type { Runtime } from "../../../../src/runtime/runtime.ts";

const WORKSPACES = ["ws_aaaaaaaaaaaaaaaa", "ws_bbbbbbbbbbbbbbbb", "ws_cccccccccccccccc"];
const SERVERS = ["acme", "globex", "initech", "umbrella"];

/** A runtime with every server installed and running in every workspace. */
function makeRuntime() {
  const instances = WORKSPACES.flatMap((wsId) =>
    SERVERS.map((serverName) => ({
      wsId,
      serverName,
      connections: new Map([[WORKSPACE_PRINCIPAL_ID, { state: "running" }]]),
    })),
  );
  const opened: object[] = [];
  const lookups: Array<{ wsId: string; serverName: string; catalog: unknown }> = [];
  const runtime = {
    getLifecycle: () => ({
      getInstances: () => instances,
      connectionSource: () => ({}),
    }),
    getConnectorCatalog: () => {
      const catalog = {};
      opened.push(catalog);
      return catalog;
    },
    getNotificationsDeclaration: async (wsId: string, serverName: string, catalog: unknown) => {
      lookups.push({ wsId, serverName, catalog });
      return { resource: `${serverName}://notifications` };
    },
  } as unknown as Runtime;
  return { runtime, opened, lookups };
}

describe("pollTargets", () => {
  test("opens one catalog per sweep and resolves every install against it", async () => {
    const { runtime, opened, lookups } = makeRuntime();

    const targets = await pollTargets(runtime);

    expect(targets).toHaveLength(WORKSPACES.length * SERVERS.length);
    expect(lookups).toHaveLength(WORKSPACES.length * SERVERS.length);
    expect(opened).toHaveLength(1);
    for (const lookup of lookups) expect(lookup.catalog).toBe(opened[0]);
  });

  test("the next sweep opens a fresh catalog, so a catalog edit is seen", async () => {
    const { runtime, opened, lookups } = makeRuntime();

    await pollTargets(runtime);
    await pollTargets(runtime);

    expect(opened).toHaveLength(2);
    expect(opened[0]).not.toBe(opened[1]);
    const perSweep = WORKSPACES.length * SERVERS.length;
    for (const lookup of lookups.slice(perSweep)) expect(lookup.catalog).toBe(opened[1]);
  });
});
