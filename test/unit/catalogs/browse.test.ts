import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bareConnectorEntry } from "../../../scripts/lib/connector-list-to-ai-catalog.ts";
import { browseCatalog, browseStatus } from "../../../src/catalogs/browse.ts";
import { createCatalogListings } from "../../../src/catalogs/reader.ts";
import type { ServerDetail } from "../../../src/connectors/catalog/server-detail.ts";
import { listingBytes, listingEntry, pathCatalog } from "../../helpers/ai-catalog.ts";

const none = { has: () => false };
const composio = { has: (id: string) => id === "composio" };

describe("browseStatus", () => {
  test.each(["dcr", "none", "provider"])("%s is ready", (auth) => {
    expect(browseStatus(auth, { brokers: none })).toBe("ready");
  });

  test("static needs setup until the workspace has its OAuth client", () => {
    expect(browseStatus("static", { brokers: none })).toBe("setup");
    expect(browseStatus("static", { brokers: none, oauthClientConfigured: false })).toBe("setup");
    expect(browseStatus("static", { brokers: none, oauthClientConfigured: true })).toBe("ready");
  });

  test("a broker is ready when this instance has it, else hidden", () => {
    expect(browseStatus("composio", { brokers: composio })).toBe("ready");
    expect(browseStatus("composio", { brokers: none })).toBe("hidden");
    expect(browseStatus("smithery", { brokers: composio })).toBe("hidden");
  });
});

/** A server's `ServerDetail` record. */
function record(name: string, meta: Record<string, unknown> = {}): ServerDetail {
  return {
    name,
    title: `${name} (record title)`,
    description: `${name} record`,
    version: "1.0.0",
    remotes: [{ type: "streamable-http", url: `https://${name.replace("/", ".")}.test/mcp` }],
    ...(Object.keys(meta).length > 0 ? { _meta: { "ai.nimblebrain/connector": meta } } : {}),
  };
}

const STATIC_SETUP = {
  auth: "static",
  oauthClientSetup: {
    portalUrl: "https://dev.box.test/console",
    hint: "Create an OAuth app",
    clientSecretKey: "box.client_secret",
  },
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nb-browse-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeListing(name: string, entries: unknown[]): string {
  const file = join(dir, `${name}.json`);
  writeFileSync(file, listingBytes(entries));
  return file;
}

const ahrefs = listingEntry({ name: "ahrefs", tags: ["seo"], category: "Marketing & websites" });
/** Bare connectors: each carries its record, and so its setup, inline. */
const box = bareConnectorEntry(record("com.box/files", STATIC_SETUP), "catalog.test");
const zoom = bareConnectorEntry(
  record("us.zoom/mcp", { auth: "composio", composio: { toolkit: "zoom" } }),
  "catalog.test",
);

function browse(
  files: Record<string, string>,
  opts: { brokers?: { has(id: string): boolean }; configured?: boolean } = {},
) {
  return browseCatalog({
    listings: createCatalogListings({
      catalogs: Object.entries(files).map(([name, file]) => pathCatalog(name, file)),
      cacheDir: join(dir, "cache"),
    }),
    brokers: opts.brokers ?? none,
    ...(opts.configured !== undefined
      ? { isOAuthClientConfigured: async () => opts.configured as boolean }
      : {}),
  });
}

describe("browseCatalog", () => {
  test("a row shows the listing's fields, addressed name@catalog, with its extension's install", async () => {
    const { entries, errors } = await browse({ nimblebrain: writeListing("nb", [ahrefs]) });
    expect(errors).toEqual([]);
    const row = entries.find((e) => e.address === "ahrefs@nimblebrain");
    expect(row).toMatchObject({
      id: "com.ahrefs/mcp",
      name: "Ahrefs",
      description: "ahrefs tools",
      iconUrl: "https://static.test/logos/ahrefs/light.svg",
      category: "Marketing & websites",
      tags: ["seo"],
      catalog: "nimblebrain",
      status: "ready",
      install: { kind: "remote-oauth", auth: "dcr" },
    });
  });

  test("a static entry needs setup until its OAuth client is configured", async () => {
    const file = writeListing("nb", [box]);
    const before = await browse({ nimblebrain: file }, { configured: false });
    expect(before.entries.find((e) => e.id === "com.box/files")).toMatchObject({
      status: "setup",
      oauthClientConfigured: false,
    });
    const after = await browse({ nimblebrain: file }, { configured: true });
    expect(after.entries.find((e) => e.id === "com.box/files")?.status).toBe("ready");
  });

  test("a brokered entry is hidden without its broker and ready with it", async () => {
    const file = writeListing("nb", [zoom]);
    const without = await browse({ nimblebrain: file });
    expect(without.entries.map((e) => e.id)).not.toContain("us.zoom/mcp");
    const withBroker = await browse({ nimblebrain: file }, { brokers: composio });
    expect(withBroker.entries.find((e) => e.id === "us.zoom/mcp")?.status).toBe("ready");
  });

  test("two catalogs sit side by side, and one server listed by both is a row under each", async () => {
    const vendorAhrefs = listingEntry({ name: "ahrefs", displayName: "Ahrefs (vendor)" });
    const { entries } = await browse({
      nimblebrain: writeListing("nb", [ahrefs, box]),
      vendor: writeListing("vendor", [vendorAhrefs]),
    });
    const ahrefsRows = entries.filter((e) => e.id === "com.ahrefs/mcp");
    expect(ahrefsRows.map((e) => [e.address, e.name])).toEqual([
      ["ahrefs@nimblebrain", "Ahrefs"],
      ["ahrefs@vendor", "Ahrefs (vendor)"],
    ]);
    expect(entries.find((e) => e.id === "com.box/files")?.address).toBe(
      "com-box-files@nimblebrain",
    );
  });

  test("every row comes from a listing entry; there is no curated catalog", async () => {
    const { entries } = await browse({ nimblebrain: writeListing("nb", [ahrefs, box, zoom]) });
    expect(entries.map((e) => e.catalog)).toEqual(["nimblebrain", "nimblebrain"]);
    expect(entries.some((e) => e.address?.endsWith("@curated"))).toBe(false);
  });

  test("an entry Browse cannot describe is left out: unlisted setup, several servers, another type", async () => {
    const unlistedStatic = listingEntry({
      name: "drive",
      servers: { drive: { name: "com.google/drive", auth: "static" } },
    });
    const twoServers = listingEntry({
      name: "suite",
      servers: {
        a: { name: "com.ahrefs/mcp", auth: "dcr" },
        b: { name: "com.box/files", auth: "static" },
      },
    });
    const skill = { ...listingEntry({ name: "notes" }), type: "application/agent-skills+zip" };
    const { entries } = await browse({
      nimblebrain: writeListing("nb", [unlistedStatic, twoServers, skill]),
    });
    expect(entries.filter((e) => e.catalog === "nimblebrain")).toEqual([]);
  });

  test("a bare connector carries the setup a static row shows, which a plugin entry cannot", async () => {
    const staticPlugin = listingEntry({
      name: "boxplugin",
      servers: { box: { name: "com.box/files", auth: "static" } },
    });
    const { entries } = await browse({ nimblebrain: writeListing("nb", [staticPlugin, box]) });
    expect(entries.map((e) => e.address)).toEqual(["com-box-files@nimblebrain"]);
    expect(entries[0]?.install).toMatchObject({
      auth: "static",
      oauthClientSetup: STATIC_SETUP.oauthClientSetup,
    });
  });

  test("a dcr plugin entry is a row from its extension alone", async () => {
    const { entries } = await browse({
      nimblebrain: writeListing("nb", [listingEntry({ name: "linear" })]),
    });
    const row = entries.find((e) => e.address === "linear@nimblebrain");
    expect(row?.id).toBe("com.linear/mcp");
    expect(row?.status).toBe("ready");
    expect(row?.install).toMatchObject({ kind: "remote-oauth", auth: "dcr" });
  });

  test("a bare connector's row is projected from its inline record", async () => {
    const bare = {
      identifier: "urn:air:vendor.test:crm:server",
      displayName: "CRM",
      type: "application/vnd.nimblebrain.server+json",
      data: record("com.vendor/crm"),
      digest: `sha256:${"0".repeat(64)}`,
    };
    const { entries } = await browse({ vendor: writeListing("vendor", [bare]) });
    const row = entries.find((e) => e.address === "crm@vendor");
    expect(row?.id).toBe("com.vendor/crm");
    expect(row?.install).toMatchObject({ url: "https://com.vendor.crm.test/mcp", auth: "dcr" });
  });

  test("an entry whose server map holds a non-server value is dropped, and the rest list", async () => {
    // A key with a line break escapes the map's key pattern; the map refuses it.
    const malformed = {
      ...listingEntry({ name: "broken" }),
      extensions: { "ai.nimblebrain": { servers: { "a\nb": null } } },
    };
    const { entries, errors } = await browse({
      nimblebrain: writeListing("nb", [malformed, ahrefs]),
    });
    expect(errors).toEqual([]);
    expect(entries.filter((e) => e.catalog === "nimblebrain").map((e) => e.address)).toEqual([
      "ahrefs@nimblebrain",
    ]);
  });

  test("a catalog that cannot be read is reported, and the others still list", async () => {
    const { entries, errors } = await browse({
      nimblebrain: writeListing("nb", [ahrefs]),
      vendor: join(dir, "missing.json"),
    });
    expect(entries.some((e) => e.address === "ahrefs@nimblebrain")).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.file).toBe(join(dir, "missing.json"));
    expect(errors[0]?.message).toMatch(/does not exist/);
  });
});
