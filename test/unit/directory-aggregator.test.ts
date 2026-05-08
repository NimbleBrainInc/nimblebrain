import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DirectoryAggregator } from "../../src/registries/aggregator.ts";
import { RegistryStore } from "../../src/registries/registry-store.ts";

function freshAggregator(): {
  aggregator: DirectoryAggregator;
  store: RegistryStore;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "nb-aggregator-"));
  const store = new RegistryStore(dir);
  return {
    aggregator: new DirectoryAggregator(store),
    store,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("DirectoryAggregator", () => {
  test("aggregates entries from all enabled registries by default (curated + mpak)", async () => {
    const { aggregator, cleanup } = freshAggregator();
    try {
      const result = await aggregator.list();
      const fromCurated = result.entries.filter((e) => e.registryId === "curated");
      const fromMpak = result.entries.filter((e) => e.registryId === "mpak");
      expect(fromCurated.length).toBeGreaterThan(0);
      expect(fromMpak.length).toBeGreaterThan(0);
      expect(result.errors).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("disabled registries don't surface entries", async () => {
    const { aggregator, store, cleanup } = freshAggregator();
    try {
      await store.update("mpak", { enabled: false });
      const result = await aggregator.list();
      expect(result.entries.every((e) => e.registryId !== "mpak")).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("each entry carries registryId + registryType for attribution", async () => {
    const { aggregator, cleanup } = freshAggregator();
    try {
      const result = await aggregator.list();
      for (const e of result.entries) {
        expect(e.registryId.length).toBeGreaterThan(0);
        expect(["curated", "mpak"]).toContain(e.registryType);
      }
    } finally {
      cleanup();
    }
  });

  test("dedupes on (registryId, id) — within-registry duplicates are collapsed", async () => {
    const { aggregator, cleanup } = freshAggregator();
    try {
      const result = await aggregator.list();
      const keys = new Set<string>();
      for (const e of result.entries) {
        const key = `${e.registryId}::${e.id}`;
        expect(keys.has(key)).toBe(false);
        keys.add(key);
      }
    } finally {
      cleanup();
    }
  });

  test("dedupes across registries on install target — curated wins over mpak for the same package", async () => {
    // CuratedRegistry surfaces every @nimblebraininc/* bundle in
    // STDIO_BUNDLES; MpakRegistry's stub also surfaces some of them
    // (echo, ipinfo, ...). Without cross-registry dedup the user
    // sees the same connector twice with different ids — and the
    // mpak entry's id is the package name, which used to break the
    // install handler's catalog lookup.
    const { aggregator, cleanup } = freshAggregator();
    try {
      const result = await aggregator.list();
      // Group by mpak install target.
      const byPackage = new Map<string, string[]>();
      for (const e of result.entries) {
        if (e.install.kind !== "mpak-bundle") continue;
        const list = byPackage.get(e.install.package) ?? [];
        list.push(e.registryType);
        byPackage.set(e.install.package, list);
      }
      // Every package surfaces at most once. When both curated and
      // mpak listed it, only curated's row survives.
      for (const [pkg, types] of byPackage) {
        expect(types.length).toBe(1);
        // Spot-check a known overlap: ipinfo is in both registries.
        if (pkg === "@nimblebraininc/ipinfo") {
          expect(types[0]).toBe("curated");
        }
      }
    } finally {
      cleanup();
    }
  });

  test("operatorConfigured passed through from ListEntriesContext for static-auth entries", async () => {
    const { aggregator, cleanup } = freshAggregator();
    try {
      // Stub: only "asana" reports configured; everything else returns false.
      const isOperatorConfigured = async (catalogId: string): Promise<boolean> =>
        catalogId === "asana";
      const result = await aggregator.list({ wsId: "ws_test", isOperatorConfigured });
      const asana = result.entries.find((e) => e.id === "asana");
      const hubspot = result.entries.find((e) => e.id === "hubspot");
      expect(asana?.operatorConfigured).toBe(true);
      expect(hubspot?.operatorConfigured).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("DCR entries leave operatorConfigured undefined regardless of context", async () => {
    const { aggregator, cleanup } = freshAggregator();
    try {
      // Resolver always returns true — but DCR entries (notion-org, granola)
      // shouldn't read the field at all because operator setup doesn't apply.
      const isOperatorConfigured = async (): Promise<boolean> => true;
      const result = await aggregator.list({ wsId: "ws_test", isOperatorConfigured });
      const granola = result.entries.find((e) => e.id === "granola");
      expect(granola?.operatorConfigured).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("works without context — registries skip workspace-aware fields", async () => {
    const { aggregator, cleanup } = freshAggregator();
    try {
      const result = await aggregator.list();
      // operatorConfigured should be undefined for everyone since we
      // gave the aggregator no resolver.
      for (const e of result.entries) {
        expect(e.operatorConfigured).toBeUndefined();
      }
    } finally {
      cleanup();
    }
  });
});
