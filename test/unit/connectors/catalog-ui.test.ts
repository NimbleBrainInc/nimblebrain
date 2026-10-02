import { describe, expect, it } from "bun:test";
import type { ConnectorCatalogEntry } from "../../../src/connectors/catalog/types.ts";
import {
  catalogTitleByServerName,
  catalogUiByServerName,
  withCatalogUi,
} from "../../../src/connectors/runtime/catalog-ui.ts";
import { slugifyServerName } from "../../../src/connectors/runtime/paths.ts";
import type {
  ConnectorRef,
  ConnectorUiMeta,
  LocalConnectorMeta,
} from "../../../src/connectors/runtime/types.ts";

const ID = "ai.example.outbound/mcp";
const SN = slugifyServerName(ID);

const atInstall: ConnectorUiMeta = {
  placements: [{ slot: "sidebar.apps", resourceUri: "ui://outbound/main", route: "outbound" }],
};
const now: ConnectorUiMeta = {
  ...atInstall,
  placements: [
    ...(atInstall.placements ?? []),
    { slot: "settings", resourceUri: "ui://outbound/settings" },
  ],
};

function entry(id: string, ui?: ConnectorUiMeta): ConnectorCatalogEntry {
  return {
    id,
    name: id,
    description: "",
    url: "https://example.test/mcp",
    ui,
  } as ConnectorCatalogEntry;
}

function installed(serverName: string, ui: ConnectorUiMeta | null) {
  const connector: ConnectorRef = { url: "https://example.test/mcp", serverName, ui };
  const meta: LocalConnectorMeta = { version: "remote", ui };
  return { wsId: "ws_a", serverName, connector, meta, dataDir: "/d" };
}

describe("installed connectors take their host UI from the catalog at boot", () => {
  it("gives an installed connector a placement the catalog gained after install", () => {
    const [out] = withCatalogUi(
      [installed(SN, atInstall)],
      catalogUiByServerName([entry(ID, now)]),
    );
    expect(out?.connector.ui).toEqual(now);
    // Both copies: the seeded instance falls back from `ref.ui` to `meta.ui`.
    expect(out?.meta?.ui).toEqual(now);
  });

  it("clears the host UI when the catalog entry no longer declares one", () => {
    const [out] = withCatalogUi([installed(SN, atInstall)], catalogUiByServerName([entry(ID)]));
    expect(out?.connector.ui).toBeNull();
    expect(out?.meta?.ui).toBeNull();
  });

  it("leaves a connector no catalog entry names exactly as stored", () => {
    const row = installed("some-other-server", atInstall);
    const [out] = withCatalogUi([row], catalogUiByServerName([entry(ID, now)]));
    expect(out).toBe(row);
  });

  it("changes nothing when the catalog could not be read", () => {
    const row = installed(SN, atInstall);
    expect(withCatalogUi([row], new Map())).toEqual([row]);
  });

  it("matches by the install's slug rule, first entry per slug winning", () => {
    const map = catalogUiByServerName([entry(ID, now), entry(ID, atInstall)]);
    expect(map.get(SN)).toEqual(now);
  });
});

describe("a connector's display name comes from its catalog entry", () => {
  it("maps each entry's name by the server name its install uses, first entry winning", () => {
    const first = { ...entry(ID), name: "Outbound" };
    const second = { ...entry(ID), name: "Shadow" };
    expect(catalogTitleByServerName([first, second])).toEqual(new Map([[SN, "Outbound"]]));
  });
});
