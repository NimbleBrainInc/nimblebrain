/**
 * The connector-list converter (`scripts/connector-list-to-ai-catalog.ts`):
 * an old `{servers: [...]}` directory round-trips into an AI Catalog listing
 * whose bare connectors carry each record unchanged, verify against their
 * digests, and reach Browse and install with the setup the record holds.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { outputFile } from "../../../scripts/connector-list-to-ai-catalog.ts";
import {
  ConnectorListError,
  convertConnectorList,
} from "../../../scripts/lib/connector-list-to-ai-catalog.ts";
import { browseCatalog } from "../../../src/catalogs/browse.ts";
import { listedServerRecords } from "../../../src/catalogs/listed-records.ts";
import { parseListing, SERVER_RECORD_TYPE } from "../../../src/catalogs/listing.ts";
import { createCatalogListings } from "../../../src/catalogs/reader.ts";
import { projectServerDetailToCatalogListing } from "../../../src/connectors/catalog/projection.ts";
import { readCatalogServers } from "../../../src/connectors/catalog/read.ts";
import { obtainArtifact, readArtifact } from "../../../src/plugins/installed/artifact.ts";
import { pathCatalog } from "../../helpers/ai-catalog.ts";

const DCR = `servers:
  - name: com.notion/mcp
    title: Notion
    description: Pages and databases
    version: "1.0.0"
    icons:
      - src: https://static.test/notion.svg
    remotes:
      - type: streamable-http
        url: https://mcp.notion.test/mcp
    _meta:
      ai.nimblebrain/connector:
        auth: dcr
        category: Docs & knowledge
        tags: [docs]
`;

const SETUP = {
  servers: [
    {
      name: "com.box/files",
      title: "Box",
      description: "Files in Box",
      version: "1.0.0",
      remotes: [{ type: "streamable-http", url: "https://mcp.box.test/mcp" }],
      _meta: {
        "ai.nimblebrain/connector": {
          auth: "static",
          oauthClientSetup: {
            portalUrl: "https://developer.box.test/console",
            hint: "Create an OAuth app",
            clientSecretKey: "box.client_secret",
          },
        },
      },
    },
    {
      name: "us.zoom/mcp",
      description: "Meetings",
      version: "1.0.0",
      remotes: [{ type: "streamable-http", url: "https://backend.composio.test/zoom" }],
      _meta: {
        "ai.nimblebrain/connector": {
          auth: "composio",
          composio: { toolkit: "zoom", authScheme: "API_KEY" },
        },
      },
    },
  ],
};

let dir: string;
let source: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nb-convert-"));
  source = join(dir, "connectors");
  mkdirSync(source);
  writeFileSync(join(source, "a-dcr.yaml"), DCR);
  writeFileSync(join(source, "b-setup.json"), JSON.stringify(SETUP));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function convertedBytes(): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify(convertConnectorList(source, { publisher: "acme.example" })),
  );
}

describe("convertConnectorList", () => {
  test("every server becomes a bare connector carrying its record unchanged", () => {
    const { entries, diagnostics } = parseListing("local", convertedBytes());
    expect(diagnostics).toEqual([]);
    const originals = readCatalogServers(source);
    expect(entries.map((e) => e.type)).toEqual(originals.map(() => SERVER_RECORD_TYPE));
    expect(entries.map((e) => e.data)).toEqual(originals);
    expect(entries.map((e) => e.address)).toEqual([
      "com-notion-mcp@local",
      "com-box-files@local",
      "us-zoom-mcp@local",
    ]);
    expect(entries[0]).toMatchObject({
      identifier: "urn:air:acme.example:com-notion-mcp:server",
      displayName: "Notion",
      description: "Pages and databases",
      tags: ["docs"],
      iconUrl: "https://static.test/notion.svg",
      category: "Docs & knowledge",
      servers: { "com-notion-mcp": { name: "com.notion/mcp", auth: "dcr" } },
    });
  });

  test("each digest verifies, and install reads the same record back", async () => {
    const { entries } = parseListing("local", convertedBytes());
    const originals = readCatalogServers(source);
    for (const [i, entry] of entries.entries()) {
      const { bytes } = await obtainArtifact(entry, { cacheDir: "" });
      expect(readArtifact(entry, bytes).servers.map((s) => s.detail)).toEqual([originals[i]]);
    }
  });

  test("Browse and the connector list read each row's setup from its record", async () => {
    const out = join(dir, "listing");
    mkdirSync(out);
    writeFileSync(outputFile(out), convertedBytes());
    const listings = createCatalogListings({
      catalogs: [pathCatalog("local", out)],
      cacheDir: join(dir, "cache"),
    });
    const { entries } = await browseCatalog({
      listings,
      brokers: { has: (id) => id === "composio" },
    });
    const originals = readCatalogServers(source);
    expect(entries.map((e) => e.install)).toEqual(
      originals.map((d) => projectServerDetailToCatalogListing(d)?.install),
    );
    const records = await listedServerRecords(await listings.snapshots());
    expect(records.map((r) => r.detail)).toEqual(originals);
  });

  test("an entry the runtime would drop fails the conversion, naming it", () => {
    writeFileSync(
      join(source, "c-bad.yaml"),
      'servers:\n  - name: com.bad/mcp\n    description: no version or remote\n    version: "1"\n',
    );
    expect(() => convertConnectorList(source)).toThrow(ConnectorListError);
    try {
      convertConnectorList(source);
    } catch (err) {
      expect((err as ConnectorListError).problems.join("\n")).toContain("com.bad/mcp");
    }
  });

  test("the output names a file, or ai-catalog.json in a directory", () => {
    expect(outputFile("/etc/nb/catalogs/local")).toBe("/etc/nb/catalogs/local/ai-catalog.json");
    expect(outputFile("/etc/nb/local.json")).toBe("/etc/nb/local.json");
  });
});
