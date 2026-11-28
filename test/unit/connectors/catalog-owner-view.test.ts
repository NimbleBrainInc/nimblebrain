/**
 * A connector list as one owner sees it (ADR-0077): that owner's installed
 * plugins' records ahead of the operator's list, and a view per owner sharing
 * one read of the list.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectorCatalog } from "../../../src/connectors/catalog/catalog.ts";
import { serverRecord } from "../../helpers/plugin-artifacts.ts";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nb-owner-view-"));
  file = join(dir, "list.json");
  writeFileSync(
    file,
    JSON.stringify({
      servers: [
        serverRecord({
          name: "com.notion/mcp",
          url: "https://list.test/mcp",
          title: "From the list",
        }),
      ],
    }),
  );
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

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
  test("the owner's record comes first; a view with none reads the list alone", async () => {
    const list = new ConnectorCatalog(file);
    expect((await list.catalogById("com.notion/mcp"))?.name).toBe("From the list");
    expect((await list.forOwner(supplied("A")).catalogById("com.notion/mcp"))?.name).toBe("A");
    expect((await list.forOwner(supplied("B")).catalogById("com.notion/mcp"))?.name).toBe("B");
    // Only the owner's views shape what the list says; the list itself is unchanged.
    expect((await list.catalogById("com.notion/mcp"))?.name).toBe("From the list");
    expect((await list.listings({ installed: false })).map((l) => l.install.url)).toEqual([
      "https://list.test/mcp",
    ]);
  });

  test("views share one read of the operator's list", async () => {
    let reads = 0;
    const list = new ConnectorCatalog(async () => {
      reads++;
      return { path: file };
    });
    await Promise.all([
      list.forOwner(supplied("A")).servers(),
      list.forOwner(supplied("B")).servers(),
      list.servers(),
    ]);
    expect(reads).toBe(1);
  });
});
