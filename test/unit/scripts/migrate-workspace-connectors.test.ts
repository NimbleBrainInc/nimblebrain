/**
 * Tests for `scripts/lib/migrate-workspace-connectors.ts` — the pure transform
 * behind `bun run migrate:workspace-connectors`.
 *
 * The headline assertion: a migrated record satisfies the SAME guard the
 * runtime applies at its disk-read boundary (`assertWorkspaceIsMigrated`), and
 * an un-migrated one does not. That pins the migration to the real contract
 * rather than to a hand-rolled approximation of it.
 */

import { describe, expect, test } from "bun:test";
import { migrateWorkspaceContent } from "../../../scripts/lib/migrate-workspace-connectors.ts";
import {
  assertWorkspaceIsMigrated,
  UnmigratedWorkspaceError,
} from "../../../src/workspace/migration-guard.ts";
import type { Workspace } from "../../../src/workspace/types.ts";

const RECORD = {
  id: "ws_eng",
  name: "Engineering",
  members: [],
  bundles: [{ url: "https://example.com/mcp", serverName: "example" }],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function asWorkspace(json: string): Workspace {
  return JSON.parse(json) as Workspace;
}

describe("migrateWorkspaceContent", () => {
  test("renames the connector array and keeps its entries", () => {
    const result = migrateWorkspaceContent(JSON.stringify(RECORD, null, 2));
    expect(result.status).toBe("changed");
    const migrated = JSON.parse(result.content as string);
    expect(migrated.connectors).toEqual(RECORD.bundles);
    expect(migrated).not.toHaveProperty("bundles");
  });

  test("the renamed key keeps its position, so the diff is one line", () => {
    // The store's writer adds the trailing newline, so compare against a
    // `before` that already has one.
    const before = `${JSON.stringify(RECORD, null, 2)}\n`;
    const after = migrateWorkspaceContent(before).content as string;
    const beforeLines = before.split("\n");
    const changed = after.split("\n").filter((line, i) => line !== beforeLines[i]);
    expect(changed).toEqual(['  "connectors": [']);
  });

  test("every other field survives untouched", () => {
    const full = { ...RECORD, isPersonal: true, ownerUserId: "u1", skillDirs: ["./s"] };
    const migrated = JSON.parse(
      migrateWorkspaceContent(JSON.stringify(full, null, 2)).content as string,
    );
    expect(migrated.isPersonal).toBe(true);
    expect(migrated.ownerUserId).toBe("u1");
    expect(migrated.skillDirs).toEqual(["./s"]);
  });

  test("a migrated record satisfies the runtime's read-boundary guard", () => {
    const before = JSON.stringify(RECORD, null, 2);
    expect(() => assertWorkspaceIsMigrated(asWorkspace(before))).toThrow(UnmigratedWorkspaceError);
    const after = migrateWorkspaceContent(before).content as string;
    expect(() => assertWorkspaceIsMigrated(asWorkspace(after))).not.toThrow();
  });

  test("the guard's message names the script and the workspace", () => {
    try {
      assertWorkspaceIsMigrated(asWorkspace(JSON.stringify(RECORD)));
      throw new Error("expected a throw");
    } catch (err) {
      expect((err as Error).message).toContain("ws_eng");
      expect((err as Error).message).toContain("migrate:workspace-connectors");
    }
  });

  test("a second run is a no-op", () => {
    const once = migrateWorkspaceContent(JSON.stringify(RECORD, null, 2)).content as string;
    expect(migrateWorkspaceContent(once).status).toBe("unchanged");
  });

  test("an empty connector list is a migrated record, not a missing one", () => {
    const result = migrateWorkspaceContent(JSON.stringify({ ...RECORD, connectors: [], bundles: undefined }));
    expect(result.status).toBe("unchanged");
  });

  test("a record with neither key gets an empty connector list", () => {
    const { bundles: _drop, ...noList } = RECORD;
    const result = migrateWorkspaceContent(JSON.stringify(noList, null, 2));
    expect(result.status).toBe("changed");
    expect(JSON.parse(result.content as string).connectors).toEqual([]);
  });

  test("both keys present is refused rather than resolved by guesswork", () => {
    const result = migrateWorkspaceContent(JSON.stringify({ ...RECORD, connectors: [] }));
    expect(result.status).toBe("error");
    expect(result.error).toContain("both");
  });

  test("a non-array connector list is an error, not a silent rewrite", () => {
    expect(migrateWorkspaceContent(JSON.stringify({ ...RECORD, bundles: {} })).status).toBe("error");
    const { bundles: _drop, ...rest } = RECORD;
    expect(migrateWorkspaceContent(JSON.stringify({ ...rest, connectors: "x" })).status).toBe(
      "error",
    );
  });

  test("malformed input is reported, never written", () => {
    expect(migrateWorkspaceContent("{ not json").status).toBe("error");
    expect(migrateWorkspaceContent("[]").status).toBe("error");
  });
});
