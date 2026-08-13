import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CONNECTOR_FIXTURE_DIR } from "../helpers/connector-fixtures.ts";
import { readStaticServers, validateStaticCatalog } from "../../src/registries/static-source.ts";

/**
 * `validateStaticCatalog` is what a pre-merge gate runs over a catalog
 * before it ships (`scripts/check-catalog-schema.ts`). It has to account
 * for **both** stages that silently remove an entry — this source's own
 * schema/dedup drops, and the safety scrub at the directory boundary —
 * because a gate that passes a catalog the runtime then guts is worse
 * than no gate: a green run reads as proof.
 *
 * The over-long-description case is the regression: a `description`
 * past the upstream 100-character cap has taken a connector out of
 * Browse four times, always merging green because nothing checked the
 * catalog before it reached a running deployment.
 */

let dir: string;

const VALID_ENTRY = {
  name: "com.example/mcp",
  description: "A short, valid description.",
  version: "1.0.0",
  remotes: [{ type: "streamable-http", url: "https://mcp.example.com/mcp" }],
};

function writeCatalog(file: string, servers: unknown[]): void {
  writeFileSync(join(dir, file), JSON.stringify({ servers }, null, 2));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "catalog-schema-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("validateStaticCatalog", () => {
  test("clean catalog yields no diagnostics", () => {
    writeCatalog("catalog.json", [VALID_ENTRY]);
    expect(validateStaticCatalog(dir)).toEqual([]);
  });

  test("description over the 100-char cap is reported, not silently dropped", () => {
    const overLong = { ...VALID_ENTRY, description: "x".repeat(101) };
    writeCatalog("catalog.json", [overLong]);

    const diagnostics = validateStaticCatalog(dir);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.name).toBe("com.example/mcp");
    expect(diagnostics[0]?.index).toBe(0);
    expect(diagnostics[0]?.message).toContain("must NOT have more than 100 characters");
  });

  test("a description at exactly 100 chars is valid", () => {
    writeCatalog("catalog.json", [{ ...VALID_ENTRY, description: "x".repeat(100) }]);
    expect(validateStaticCatalog(dir)).toEqual([]);
  });

  test("reports every bad entry, not just the first", () => {
    writeCatalog("catalog.json", [
      { ...VALID_ENTRY, description: "x".repeat(101) },
      { ...VALID_ENTRY, name: "com.other/mcp", version: undefined },
      VALID_ENTRY,
    ]);
    expect(validateStaticCatalog(dir)).toHaveLength(2);
  });

  test("a duplicate name across files is reported against the losing file", () => {
    writeCatalog("a-first.json", [VALID_ENTRY]);
    writeCatalog("b-second.json", [VALID_ENTRY]);

    const diagnostics = validateStaticCatalog(dir);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.source).toContain("b-second.json");
    expect(diagnostics[0]?.message).toContain("duplicate name");
  });

  test("an unparseable file is reported and does not sink its siblings", () => {
    writeFileSync(join(dir, "a-broken.json"), "{ not json");
    writeCatalog("b-fine.json", [VALID_ENTRY]);

    const diagnostics = validateStaticCatalog(dir);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.source).toContain("a-broken.json");
    expect(readStaticServers(dir).map((s) => s.name)).toEqual(["com.example/mcp"]);
  });

  test("a nonexistent path is a diagnostic, so a misaimed gate fails rather than passes empty", () => {
    const diagnostics = validateStaticCatalog(join(dir, "nope"));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain("not found");
  });

  test("diagnostics account for exactly what readStaticServers drops", () => {
    writeCatalog("catalog.json", [
      VALID_ENTRY,
      { ...VALID_ENTRY, name: "com.second/mcp", description: "y".repeat(101) },
      { ...VALID_ENTRY, name: "com.third/mcp" },
    ]);

    expect(readStaticServers(dir)).toHaveLength(2);
    expect(validateStaticCatalog(dir)).toHaveLength(1);
  });

  test("an unsafe icon src is reported even though it passes ServerDetail", () => {
    // The entry is schema-valid, so this source keeps it — and the
    // directory boundary then drops it. Same symptom as a schema
    // failure (connector never appears, nothing fails), so the gate has
    // to cover it or a green run certifies a catalog the runtime guts.
    writeCatalog("catalog.json", [
      { ...VALID_ENTRY, icons: [{ src: "javascript:alert(1)", sizes: ["any"] }] },
    ]);

    expect(readStaticServers(dir)).toHaveLength(1);

    const diagnostics = validateStaticCatalog(dir);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.name).toBe("com.example/mcp");
    expect(diagnostics[0]?.message).toContain("directory boundary");
    expect(diagnostics[0]?.message).toContain("icon src must be http(s)");
  });

  test("a reserved OAuth param is reported as a directory-boundary drop", () => {
    writeCatalog("catalog.json", [
      {
        ...VALID_ENTRY,
        _meta: {
          "ai.nimblebrain/connector": {
            auth: "dcr",
            additionalAuthorizationParams: { client_id: "attacker" },
          },
        },
      },
    ]);

    const diagnostics = validateStaticCatalog(dir);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain("directory boundary");
  });

  test("safety runs over survivors only — a schema failure is not double-reported", () => {
    writeCatalog("catalog.json", [
      {
        ...VALID_ENTRY,
        description: "x".repeat(101),
        icons: [{ src: "javascript:alert(1)", sizes: ["any"] }],
      },
    ]);

    const diagnostics = validateStaticCatalog(dir);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain("must NOT have more than 100 characters");
  });

  test("the shipped example catalog and the test fixtures both pass the gate", () => {
    // `check:catalog-schema` runs the gate over src/connectors/curated in
    // `verify:static`; this keeps the fixture catalog honest too, so a
    // fixture edit cannot quietly start relying on a dropped entry.
    expect(validateStaticCatalog("src/connectors/curated")).toEqual([]);
    expect(validateStaticCatalog(CONNECTOR_FIXTURE_DIR)).toEqual([]);
  });
});
