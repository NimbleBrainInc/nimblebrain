/**
 * Catalog-level uniqueness for the wire `serverName`.
 *
 * `shortServerName` trades global collision-freedom for a name that fits the
 * providers' 64-character budget. That trade is only sound because the
 * uniqueness actually required is narrower than global:
 *
 *   - **within an owner** — permissions and OAuth credentials are stored under
 *     `users/<id>/` or `workspaces/<id>/`, so two servers conflict only if the
 *     same owner installs both. Enforced at install, fail-closed.
 *   - **across the curated catalog** — which is keyed by this name. Enforced
 *     HERE, because the catalog is ours: a collision is something we ship, so it
 *     should fail at edit time rather than surprise a tenant at install time.
 *
 * If this test goes red after adding a catalog entry, do not reach for a counter
 * or a hash suffix. Rename the entry. An auto-generated `crm-2` is unreadable to
 * the model that has to choose between `crm` and `crm-2`, and an unreadable name
 * is how a tool call reaches the wrong connector.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isReservedServerName,
  shortServerName,
  validateServerName,
} from "../../../src/bundles/paths.ts";

const CURATED_DIR = join(import.meta.dir, "../../../src/connectors/curated");

/** Every canonical `ServerDetail.name` the curated catalog ships. */
function curatedServerIds(): string[] {
  const ids: string[] = [];
  for (const file of readdirSync(CURATED_DIR)) {
    if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
    const doc = Bun.YAML.parse(readFileSync(join(CURATED_DIR, file), "utf8")) as {
      servers?: { name?: string }[];
    } | null;
    for (const server of doc?.servers ?? []) {
      if (typeof server?.name === "string") ids.push(server.name);
    }
  }
  return ids;
}

describe("curated catalog server names", () => {
  test("the catalog is non-empty (the other assertions are only meaningful if it is)", () => {
    expect(curatedServerIds().length).toBeGreaterThan(0);
  });

  test("no two catalog entries reduce to the same wire name", () => {
    const byWireName = new Map<string, string[]>();
    for (const id of curatedServerIds()) {
      const wire = shortServerName(id);
      byWireName.set(wire, [...(byWireName.get(wire) ?? []), id]);
    }

    const collisions = [...byWireName.entries()]
      .filter(([, ids]) => ids.length > 1)
      .map(([wire, ids]) => `${wire} ← ${ids.join(", ")}`);

    expect(collisions).toEqual([]);
  });

  test("no catalog entry reduces to a reserved or personal-marked name", () => {
    // A catalog entry that slugs to a system prefix would shadow platform tools;
    // one that slugs into the personal-connector marker would shadow the identity
    // door. `validateServerName` owns both rules — assert through it so the test
    // cannot drift from the runtime check.
    for (const id of curatedServerIds()) {
      const wire = shortServerName(id);
      expect(isReservedServerName(wire)).toBe(false);
      expect(() => validateServerName(wire)).not.toThrow();
    }
  });

  test("every wire name is non-empty", () => {
    // `shortServerName` falls back to the full slug rather than returning empty;
    // an empty source segment would make `<source>__<tool>` unroutable.
    for (const id of curatedServerIds()) {
      expect(shortServerName(id).length).toBeGreaterThan(0);
    }
  });
});
