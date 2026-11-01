import { describe, expect, it } from "bun:test";
import { NoopEventSink } from "../../../src/adapters/noop-events.ts";
import { slugifyServerName } from "../../../src/connectors/runtime/paths.ts";
import {
  FleetConnectorUnavailableError,
  startConnectorSource,
} from "../../../src/connectors/runtime/startup.ts";
import type { ConnectorRef } from "../../../src/connectors/runtime/types.ts";
import { ToolRegistry } from "../../../src/tools/registry.ts";

/**
 * `startConnectorSource` refuses a minted fleet connector before building any
 * connection when it cannot take the connector's credential settings from the
 * catalog: started without a catalog, or with one that no longer offers it.
 * Neither case registers a source, so nothing mints from the stored copy.
 */

const ID = "ai.example.alpha/mcp";
const URL_ = "http://mcp-alpha.fleet.svc.cluster.local/mcp";

const minted: ConnectorRef = {
  url: URL_,
  serverName: slugifyServerName(ID),
  transport: {
    type: "streamable-http",
    auth: {
      type: "provider",
      provider: "minted",
      config: { audience: "shared-audience", scope: "mcp:invoke" },
    },
  },
};

describe("startConnectorSource with a minted fleet connector", () => {
  it("throws when started without the catalog", async () => {
    const registry = new ToolRegistry();
    await expect(startConnectorSource(minted, registry, new NoopEventSink(), {})).rejects.toThrow(
      /without the connector catalog/,
    );
    expect(registry.hasSource(minted.serverName)).toBe(false);
  });

  it("does not start one the catalog no longer offers", async () => {
    const registry = new ToolRegistry();
    await expect(
      startConnectorSource(minted, registry, new NoopEventSink(), {
        readCatalog: async () => [],
        keepRegisteredOnStartFailure: true,
      }),
    ).rejects.toBeInstanceOf(FleetConnectorUnavailableError);
    expect(registry.hasSource(minted.serverName)).toBe(false);
  });
});
