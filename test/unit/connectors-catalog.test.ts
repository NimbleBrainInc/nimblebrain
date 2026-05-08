import { describe, expect, test } from "bun:test";
import { readDefaultCatalogYaml } from "../../src/connectors/catalog.ts";
import { loadCatalog, validateCatalog } from "../../src/connectors/load-catalog.ts";

describe("bundled catalog.yaml", () => {
  test("parses + validates with zero drops", () => {
    const raw = readDefaultCatalogYaml();
    const validated = validateCatalog(raw, "<test:bundled>");
    expect(validated.length).toBe(raw.length);
  });

  test("loadCatalog() returns the bundled list when NB_CATALOG_PATH is unset", () => {
    // Test runs without NB_CATALOG_PATH so this exercises the
    // bundled-catalog code path end-to-end.
    expect(process.env.NB_CATALOG_PATH).toBeUndefined();
    const v = loadCatalog();
    expect(v.length).toBeGreaterThan(0);
  });

  test("all ids are unique", () => {
    const v = loadCatalog();
    const ids = v.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("static-auth entries all have operatorSetup with clientSecretKey", () => {
    for (const entry of loadCatalog()) {
      if (entry.auth === "static") {
        expect(entry.operatorSetup).toBeDefined();
        expect(entry.operatorSetup?.clientSecretKey.length).toBeGreaterThan(0);
        expect(entry.operatorSetup?.portalUrl.startsWith("http")).toBe(true);
      }
    }
  });
});

describe("validateCatalog", () => {
  test("rejects entries with missing required fields", () => {
    const out = validateCatalog([
      { id: "ok", name: "OK", description: "d", iconUrl: "https://x.test/i.svg", url: "u", auth: "dcr", defaultScope: "workspace" },
      { id: "no-name", description: "d", iconUrl: "https://x.test/i.svg", url: "u", auth: "dcr", defaultScope: "workspace" } as unknown,
      { name: "no-id" } as unknown,
      { id: "BAD-CASE", name: "x", description: "d", iconUrl: "https://x.test/i.svg", url: "u", auth: "dcr", defaultScope: "workspace" } as unknown,
    ]);
    expect(out.length).toBe(1);
    expect(out[0]?.id).toBe("ok");
  });

  test("rejects duplicate ids — first wins", () => {
    const out = validateCatalog([
      { id: "dup", name: "first", description: "d", iconUrl: "https://x.test/i.svg", url: "u1", auth: "dcr", defaultScope: "workspace" },
      { id: "dup", name: "second", description: "d", iconUrl: "https://x.test/i.svg", url: "u2", auth: "dcr", defaultScope: "workspace" },
    ]);
    expect(out.length).toBe(1);
    expect(out[0]?.name).toBe("first");
  });

  test("rejects static-auth entry missing operatorSetup", () => {
    const out = validateCatalog([
      { id: "no-setup", name: "n", description: "d", iconUrl: "https://x.test/i.svg", url: "u", auth: "static", defaultScope: "user" } as unknown,
    ]);
    expect(out.length).toBe(0);
  });

  test("accepts static-auth entry with full operatorSetup", () => {
    const out = validateCatalog([
      {
        id: "with-setup",
        name: "n",
        description: "d",
        iconUrl: "https://x.test/i.svg",
        url: "u",
        auth: "static",
        defaultScope: "user",
        operatorSetup: {
          portalUrl: "https://example.com",
          hint: "do this",
          clientSecretKey: "x.secret",
        },
      },
    ]);
    expect(out.length).toBe(1);
  });

  test("rejects iconUrl with non-http(s) protocol", () => {
    const base = {
      id: "x",
      name: "x",
      description: "d",
      url: "https://example.com",
      auth: "dcr" as const,
      defaultScope: "workspace" as const,
    };
    expect(validateCatalog([{ ...base, iconUrl: "javascript:alert(1)" }]).length).toBe(0);
    expect(
      validateCatalog([{ ...base, iconUrl: "data:image/svg+xml;<script>alert(1)</script>" }])
        .length,
    ).toBe(0);
    expect(validateCatalog([{ ...base, iconUrl: "file:///etc/passwd" }]).length).toBe(0);
    // Allowed shapes:
    expect(validateCatalog([{ ...base, iconUrl: "https://x.test/i.svg" }]).length).toBe(1);
    expect(validateCatalog([{ ...base, iconUrl: "/icons/x.svg" }]).length).toBe(1); // relative
  });

  test("rejects entries with reserved keys in additionalAuthorizationParams", () => {
    const base = {
      id: "x",
      name: "x",
      description: "d",
      iconUrl: "https://x.test/i.svg",
      url: "https://example.com",
      auth: "dcr" as const,
      defaultScope: "workspace" as const,
    };
    expect(
      validateCatalog([
        { ...base, additionalAuthorizationParams: { client_id: "evil" } },
      ]).length,
    ).toBe(0);
    expect(
      validateCatalog([
        { ...base, additionalAuthorizationParams: { state: "no" } },
      ]).length,
    ).toBe(0);
    expect(
      validateCatalog([
        { ...base, additionalAuthorizationParams: { request: "smuggled-jwt" } },
      ]).length,
    ).toBe(0);
    // Non-reserved is fine.
    expect(
      validateCatalog([
        { ...base, additionalAuthorizationParams: { access_type: "offline" } },
      ]).length,
    ).toBe(1);
  });

  test("drops malformed optional fields silently (entry survives)", () => {
    const out = validateCatalog([
      {
        id: "weird-extras",
        name: "n",
        description: "d",
        iconUrl: "https://x.test/i.svg",
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
