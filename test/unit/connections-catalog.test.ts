import { describe, expect, test } from "bun:test";
import { DEFAULT_CONNECTION_CATALOG } from "../../src/connections/catalog.ts";
import { validateCatalog } from "../../src/connections/load-catalog.ts";

describe("DEFAULT_CONNECTION_CATALOG", () => {
  test("validates against the validator (sanity check)", () => {
    const v = validateCatalog(DEFAULT_CONNECTION_CATALOG);
    expect(v.length).toBe(DEFAULT_CONNECTION_CATALOG.length);
  });

  test("all ids are unique", () => {
    const ids = DEFAULT_CONNECTION_CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("static-auth entries all have operatorSetup with credentialKey", () => {
    for (const entry of DEFAULT_CONNECTION_CATALOG) {
      if (entry.auth === "static") {
        expect(entry.operatorSetup).toBeDefined();
        expect(entry.operatorSetup?.credentialKey.length).toBeGreaterThan(0);
        expect(entry.operatorSetup?.portalUrl.startsWith("http")).toBe(true);
      }
    }
  });
});

describe("validateCatalog", () => {
  test("rejects entries with missing required fields", () => {
    const out = validateCatalog([
      { id: "ok", name: "OK", description: "d", iconUrl: "u", url: "u", auth: "dcr", defaultScope: "workspace" },
      { id: "no-name", description: "d", iconUrl: "u", url: "u", auth: "dcr", defaultScope: "workspace" } as unknown,
      { name: "no-id" } as unknown,
      { id: "BAD-CASE", name: "x", description: "d", iconUrl: "u", url: "u", auth: "dcr", defaultScope: "workspace" } as unknown,
    ]);
    expect(out.length).toBe(1);
    expect(out[0]?.id).toBe("ok");
  });

  test("rejects duplicate ids — first wins", () => {
    const out = validateCatalog([
      { id: "dup", name: "first", description: "d", iconUrl: "u", url: "u1", auth: "dcr", defaultScope: "workspace" },
      { id: "dup", name: "second", description: "d", iconUrl: "u", url: "u2", auth: "dcr", defaultScope: "workspace" },
    ]);
    expect(out.length).toBe(1);
    expect(out[0]?.name).toBe("first");
  });

  test("rejects static-auth entry missing operatorSetup", () => {
    const out = validateCatalog([
      { id: "no-setup", name: "n", description: "d", iconUrl: "u", url: "u", auth: "static", defaultScope: "member" } as unknown,
    ]);
    expect(out.length).toBe(0);
  });

  test("accepts static-auth entry with full operatorSetup", () => {
    const out = validateCatalog([
      {
        id: "with-setup",
        name: "n",
        description: "d",
        iconUrl: "u",
        url: "u",
        auth: "static",
        defaultScope: "member",
        operatorSetup: {
          portalUrl: "https://example.com",
          hint: "do this",
          credentialKey: "x.secret",
        },
      },
    ]);
    expect(out.length).toBe(1);
  });

  test("drops malformed optional fields silently (entry survives)", () => {
    const out = validateCatalog([
      {
        id: "weird-extras",
        name: "n",
        description: "d",
        iconUrl: "u",
        url: "u",
        auth: "dcr",
        defaultScope: "workspace",
        // Wrong shape — should be dropped, but the entry itself survives.
        requiredScopes: "not-an-array",
        tags: [123, "ok"],
      } as unknown,
    ]);
    expect(out.length).toBe(1);
    expect(out[0]?.requiredScopes).toBeUndefined();
    expect(out[0]?.tags).toBeUndefined();
  });
});
