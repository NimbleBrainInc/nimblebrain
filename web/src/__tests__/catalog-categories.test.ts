import { describe, expect, test } from "bun:test";
import type { CatalogListing } from "../api/client";
import { categoryCounts, matchesListing } from "../lib/catalog-categories";

function listing(over: Partial<CatalogListing>): CatalogListing {
  return {
    id: "com.example/mcp",
    name: "Example",
    description: "An example server",
    install: {
      kind: "remote-oauth",
      url: "https://example.test/mcp",
      transportType: "streamable-http",
      auth: "dcr",
    },
    ...over,
  } as CatalogListing;
}

describe("categoryCounts", () => {
  test("counts each category the entries name, sorted by name, skipping entries with none", () => {
    expect(
      categoryCounts([
        listing({ category: "Sales & support" }),
        listing({ category: "Developer tools" }),
        listing({ category: "Sales & support" }),
        listing({}),
      ]),
    ).toEqual([
      { name: "Developer tools", count: 1 },
      { name: "Sales & support", count: 2 },
    ]);
  });

  test("is empty for a catalog that names no categories", () => {
    expect(categoryCounts([listing({}), listing({})])).toEqual([]);
  });
});

describe("matchesListing", () => {
  const hubspot = listing({
    name: "HubSpot",
    description: "Contacts and deals",
    category: "Sales & support",
    tags: ["crm"],
  });

  test("a null category and an empty query match everything", () => {
    expect(matchesListing(hubspot, "", null)).toBe(true);
    expect(matchesListing(listing({}), "  ", null)).toBe(true);
  });

  test("a category keeps only entries in it", () => {
    expect(matchesListing(hubspot, "", "Sales & support")).toBe(true);
    expect(matchesListing(hubspot, "", "Developer tools")).toBe(false);
    expect(matchesListing(listing({}), "", "Sales & support")).toBe(false);
  });

  test("the query matches name, description, category, and tags, case-insensitively", () => {
    for (const q of ["hub", "DEALS", "support", "CRM"]) {
      expect(matchesListing(hubspot, q, null)).toBe(true);
    }
    expect(matchesListing(hubspot, "invoices", null)).toBe(false);
  });

  test("query and category both apply", () => {
    expect(matchesListing(hubspot, "crm", "Sales & support")).toBe(true);
    expect(matchesListing(hubspot, "crm", "Developer tools")).toBe(false);
  });
});
