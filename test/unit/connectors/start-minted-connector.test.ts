import { describe, expect, it } from "bun:test";
import { NoopEventSink } from "../../../src/adapters/noop-events.ts";
import { NO_CATALOG } from "../../../src/connectors/catalog/binding.ts";
import type { ConnectorCatalogEntry } from "../../../src/connectors/catalog/types.ts";
import { slugifyServerName } from "../../../src/connectors/runtime/paths.ts";
import {
  FleetConnectorUnavailableError,
  startConnectorSource,
} from "../../../src/connectors/runtime/startup.ts";
import type { ConnectorRef } from "../../../src/connectors/runtime/types.ts";
import { MINTED_PROVIDER } from "../../../src/oauth/minted-credential-provider.ts";
import { registerCredentialProvider } from "../../../src/tools/credential-provider.ts";
import { McpSource } from "../../../src/tools/mcp-source.ts";
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
  it("does not start when handed NO_CATALOG", async () => {
    const registry = new ToolRegistry();
    await expect(
      startConnectorSource(minted, registry, new NoopEventSink(), { readCatalog: NO_CATALOG }),
    ).rejects.toBeInstanceOf(FleetConnectorUnavailableError);
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

  it("re-reads the catalog when a retained source restarts", async () => {
    // A spy in place of the minted provider records the audience each
    // connection build asks for, then throws before any network access.
    const audiences: unknown[] = [];
    registerCredentialProvider(MINTED_PROVIDER, {
      credentialFor(_ws, config) {
        audiences.push(config.audience);
        throw new Error("spy: no network");
      },
    });
    const entry = (audience: string): ConnectorCatalogEntry => ({
      id: ID,
      name: "Alpha",
      description: "",
      url: URL_,
      auth: "provider",
      providerAuth: { provider: MINTED_PROVIDER, config: { audience, scope: "mcp:invoke" } },
    });
    let catalog: ConnectorCatalogEntry[] = [entry("catalog-v1")];

    const registry = new ToolRegistry();
    await expect(
      startConnectorSource(minted, registry, new NoopEventSink(), {
        readCatalog: async () => catalog,
        keepRegisteredOnStartFailure: true,
      }),
    ).rejects.toThrow();
    const source = registry.getSource(minted.serverName);
    expect(source).toBeInstanceOf(McpSource);
    expect(audiences).toEqual(["catalog-v1"]);

    // An audience edit reaches the restart.
    catalog = [entry("catalog-v2")];
    expect(await (source as McpSource).restart()).toBe(false);
    expect(audiences).toEqual(["catalog-v1", "catalog-v2"]);

    // A withdrawn entry stops the restart before the provider is asked.
    catalog = [];
    expect(await (source as McpSource).restart()).toBe(false);
    expect(audiences).toEqual(["catalog-v1", "catalog-v2"]);
  });
});
