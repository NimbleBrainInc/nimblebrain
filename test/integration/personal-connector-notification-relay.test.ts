/**
 * A personal connector's own notifications reach its owner's views of it, and
 * no one else's.
 *
 * A personal connector is one person's MCP connection, held in that person's
 * registry and mounted in their views under its marked name (`my_<server>`,
 * the iframe's `data-app`). When its server announces a change, here inside the
 * response to the tool call that made it (a 2026-07-28 stateless server
 * answering over SSE), the host relays it stamped with the connector's owner
 * and named by its marked name, so it reaches neither another person nor a
 * workspace app of the same bare name.
 *
 * Drives a real Streamable HTTP server behind the lifecycle's lazy start, so the
 * source, the user registry and the relay are the ones production builds.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpHandler, Server } from "@modelcontextprotocol/server";
import { ConnectorLifecycleManager } from "../../src/connectors/runtime/lifecycle.ts";
import type { EngineEvent } from "../../src/engine/types.ts";
import { IdentityConnectorStore } from "../../src/identity/connector-store.ts";
import {
  RELAY_COALESCE_WINDOW_MS,
  RESOURCES_LIST_CHANGED,
} from "../../src/tools/server-notifications.ts";
import type { ToolSource } from "../../src/tools/types.ts";
import {
  installTestCredentialStore,
  resetTestCredentialStore,
} from "../helpers/credential-store.ts";
import { payloadsOf } from "../helpers/engine-events.ts";

const SERVER = "crm";

/** A CRM whose write tool announces a change from inside its own response. */
function buildCrm(): Server {
  const server = new Server(
    { name: SERVER, version: "1.0.0" },
    { capabilities: { tools: {}, resources: { listChanged: true } } },
  );
  server.setRequestHandler("tools/list", async () => ({
    tools: [{ name: "log_interaction", inputSchema: { type: "object", properties: {} } }],
  }));
  server.setRequestHandler("resources/list", async () => ({ resources: [] }));
  // A stateless server has no standalone stream: the announcement goes out on
  // the call's own SSE response.
  server.setRequestHandler("tools/call", async (_request, ctx) => {
    await ctx.mcpReq.notify({ method: RESOURCES_LIST_CHANGED });
    return { content: [{ type: "text", text: "logged" }] };
  });
  return server;
}

describe("a personal connector's server notifications", () => {
  let workDir: string;
  let stopServer: () => void;
  let url: string;
  let events: EngineEvent[];
  let lifecycle: ConnectorLifecycleManager;
  const started: ToolSource[] = [];

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "nb-personal-relay-"));
    installTestCredentialStore(workDir);
    const handler = createMcpHandler(() => buildCrm());
    const http = Bun.serve({ port: 0, fetch: (request) => handler.fetch(request) });
    url = `http://localhost:${http.port}/mcp`;
    stopServer = () => http.stop(true);
    events = [];
    // allowInsecureRemotes: the fake server is on localhost.
    lifecycle = new ConnectorLifecycleManager({ emit: (event) => events.push(event) }, true);
  });

  afterEach(async () => {
    jest.useRealTimers();
    for (const source of started) await source.stop().catch(() => {});
    started.length = 0;
    stopServer();
    resetTestCredentialStore();
    rmSync(workDir, { recursive: true, force: true });
  });

  async function sourceFor(userId: string): Promise<ToolSource> {
    await new IdentityConnectorStore({ workDir }).add(userId, {
      url,
      serverName: SERVER,
      ui: null,
    });
    const source = await lifecycle.getIdentityConnectorSource(userId, SERVER, workDir);
    if (!source) throw new Error(`no ${SERVER} source for ${userId}`);
    started.push(source);
    return source;
  }

  const relayed = () => payloadsOf(events, "server.notification");

  it("reach the owner alone, under the connector's marked name", async () => {
    const alice = await sourceFor("usr_alice");
    await sourceFor("usr_bob");

    await alice.execute("log_interaction", {});

    expect(relayed()).toEqual([
      { server: `my_${SERVER}`, userId: "usr_alice", method: RESOURCES_LIST_CHANGED },
    ]);
  });

  it("are coalesced per owner: one person's burst does not hold back another's", async () => {
    const alice = await sourceFor("usr_alice");
    const bob = await sourceFor("usr_bob");

    await alice.execute("log_interaction", {});
    await alice.execute("log_interaction", {});
    await bob.execute("log_interaction", {});

    expect(relayed().map((d) => ("userId" in d ? d.userId : d.workspaceId))).toEqual([
      "usr_alice",
      "usr_bob",
    ]);

    // Alice's second announcement lands as the trailing delivery of her window.
    await new Promise((resolve) => setTimeout(resolve, RELAY_COALESCE_WINDOW_MS + 50));
    expect(relayed().map((d) => ("userId" in d ? d.userId : d.workspaceId))).toEqual([
      "usr_alice",
      "usr_bob",
      "usr_alice",
    ]);
  });
});
