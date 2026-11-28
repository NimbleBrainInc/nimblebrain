/**
 * One poller sweep reads the operator's connector list once.
 *
 * A catalog read is synchronous (directory listing, parse, schema validation),
 * and a sweep resolves a declaration for every `(workspace, connector)` pair.
 * A read per lookup blocks the event loop for the length of the whole sweep,
 * which on a tenant with many installs is long enough to stall every chat. So
 * each sweep opens one list, and each workspace's lookups get one view of it
 * that adds that workspace's own plugins' records. Which connectors
 * become targets is `notifications/targets.test.ts`'s subject; this file pins
 * only the sharing.
 */

import { describe, expect, test } from "bun:test";
import type { ConnectorCatalog } from "../../../../src/connectors/catalog/catalog.ts";
import {
  type Connection,
  WORKSPACE_PRINCIPAL_ID,
} from "../../../../src/connectors/runtime/connection.ts";
import type { ConnectorLifecycleManager } from "../../../../src/connectors/runtime/lifecycle.ts";
import type { ConnectorInstance } from "../../../../src/connectors/runtime/types.ts";
import { pollTargets } from "../../../../src/platform/notifications/source.ts";
import type { Runtime } from "../../../../src/runtime/runtime.ts";
import type { McpSource } from "../../../../src/tools/mcp-source.ts";
import { stub } from "../../../helpers/stub.ts";

const WORKSPACES = ["ws_aaaaaaaaaaaaaaaa", "ws_bbbbbbbbbbbbbbbb", "ws_cccccccccccccccc"];
const SERVERS = ["acme", "globex", "initech", "umbrella"];

/** A runtime with every server installed and running in every workspace. */
function makeRuntime() {
  const instances = WORKSPACES.flatMap((wsId) =>
    SERVERS.map((serverName) =>
      stub<ConnectorInstance>({
        wsId,
        serverName,
        connections: new Map([[WORKSPACE_PRINCIPAL_ID, stub<Connection>({ state: "running" })]]),
      }),
    ),
  );
  /** Every catalog opened: the list (no owner), or a workspace's view sharing one. */
  const opened: Array<{ catalog: object; wsId?: string; sharing?: object }> = [];
  const lookups: Array<{ wsId: string; serverName: string; catalog: unknown }> = [];
  const runtime = stub<Runtime>({
    getLifecycle: () =>
      stub<ConnectorLifecycleManager>({
        getInstances: () => instances,
        connectionSource: () => stub<McpSource>({}),
      }),
    getConnectorCatalog: (
      owner?: { kind: "workspace"; wsId: string },
      opts?: { sharing?: ConnectorCatalog },
    ) => {
      const catalog = stub<ConnectorCatalog>({});
      opened.push({
        catalog,
        ...(owner ? { wsId: owner.wsId } : {}),
        ...(opts?.sharing ? { sharing: opts.sharing } : {}),
      });
      return catalog;
    },
    getNotificationsDeclaration: async (wsId: string, serverName: string, catalog: unknown) => {
      lookups.push({ wsId, serverName, catalog });
      return { resource: `${serverName}://notifications` };
    },
  });
  return { runtime, opened, lookups };
}

/** The sweep's one list, and the view each lookup was given. */
function sweep(opened: Array<{ catalog: object; wsId?: string; sharing?: object }>) {
  const lists = opened.filter((o) => o.wsId === undefined);
  const views = opened.filter((o) => o.wsId !== undefined);
  return { lists, views };
}

describe("pollTargets", () => {
  test("reads the list once per sweep, and resolves each workspace against its own view of it", async () => {
    const { runtime, opened, lookups } = makeRuntime();

    const targets = await pollTargets(runtime);

    expect(targets).toHaveLength(WORKSPACES.length * SERVERS.length);
    expect(lookups).toHaveLength(WORKSPACES.length * SERVERS.length);
    const { lists, views } = sweep(opened);
    expect(lists).toHaveLength(1);
    expect(views.map((v) => v.wsId)).toEqual(WORKSPACES);
    for (const view of views) expect(view.sharing).toBe(lists[0]?.catalog);
    for (const lookup of lookups) {
      expect(lookup.catalog).toBe(views.find((v) => v.wsId === lookup.wsId)?.catalog);
    }
  });

  test("the next sweep reads the list again, so a catalog edit is seen", async () => {
    const { runtime, opened } = makeRuntime();

    await pollTargets(runtime);
    await pollTargets(runtime);

    const { lists, views } = sweep(opened);
    expect(lists).toHaveLength(2);
    expect(lists[0]?.catalog).not.toBe(lists[1]?.catalog);
    for (const view of views.slice(WORKSPACES.length)) expect(view.sharing).toBe(lists[1]?.catalog);
  });
});
