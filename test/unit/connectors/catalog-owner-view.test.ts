/**
 * A connector list as one owner sees it (ADR-0077): that owner's installed
 * plugins' records ahead of the listings' bare connectors, and a view per
 * owner sharing one read of the listings.
 */

import { describe, expect, test } from "bun:test";
import { ConnectorCatalog } from "../../../src/connectors/catalog/catalog.ts";
import { serverRecord } from "../../helpers/plugin-artifacts.ts";

const LIST = async () => [
  {
    address: "notion@listing",
    detail: serverRecord({
      name: "com.notion/mcp",
      url: "https://list.test/mcp",
      title: "From the listing",
    }),
  },
];

const supplied = (title: string) => async () => [
  {
    address: "notion@x",
    detail: serverRecord({
      name: "com.notion/mcp",
      url: "https://p.test/mcp",
      title,
    }),
  },
];

describe("ConnectorCatalog for one owner", () => {
  test("the owner's record comes first; a view with none reads the listings alone", async () => {
    const list = new ConnectorCatalog(LIST);
    expect((await list.catalogById("com.notion/mcp"))?.name).toBe("From the listing");
    expect((await list.forOwner(supplied("A")).catalogById("com.notion/mcp"))?.name).toBe("A");
    expect((await list.forOwner(supplied("B")).catalogById("com.notion/mcp"))?.name).toBe("B");
    // Only the owner's views shape what the list says; the list itself is unchanged.
    expect((await list.catalogById("com.notion/mcp"))?.name).toBe("From the listing");
    expect((await list.listings()).map((l) => l.install.url)).toEqual(["https://list.test/mcp"]);
    const { servers } = await list.servers();
    expect(servers.map((s) => s.file)).toEqual(["listing notion@listing"]);
  });

  test("a refused listed record is kept only as refused, and an owner's record shadows it", async () => {
    const refused = async () => [
      {
        address: "notion@listing",
        detail: serverRecord({ name: "com.notion/mcp", url: "https://l.test/mcp", title: "L" }),
        refused: true as const,
      },
    ];
    const list = new ConnectorCatalog(refused);
    expect(await list.servers()).toEqual({
      servers: [],
      refused: [{ file: "listing notion@listing", detail: expect.anything() }],
    });
    const mine = await list.forOwner(supplied("A")).servers();
    expect(mine.servers.map((s) => s.file)).toEqual(["plugin notion@x"]);
    expect(mine.refused).toEqual([]);
  });

  test("views share one read of the listings", async () => {
    let reads = 0;
    const list = new ConnectorCatalog(async () => {
      reads++;
      return LIST();
    });
    await Promise.all([
      list.forOwner(supplied("A")).servers(),
      list.forOwner(supplied("B")).servers(),
      list.servers(),
    ]);
    expect(reads).toBe(1);
  });
});
