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
  test("aggregates entries from enabled registries; bundled-static populates today", async () => {
    const { aggregator, store, cleanup } = freshAggregator();
    try {
      // Disable mpak so the test doesn't depend on a live network. The
      // bundled-static registry alone should yield > 0 entries.
      await store.update("mpak", { enabled: false });
      const result = await aggregator.list();
      const fromBundled = result.entries.filter((e) => e.registryId === "bundled-static");
      expect(fromBundled.length).toBeGreaterThan(0);
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
    const { aggregator, store, cleanup } = freshAggregator();
    try {
      await store.update("mpak", { enabled: false });
      const result = await aggregator.list();
      for (const e of result.entries) {
        expect(e.registryId.length).toBeGreaterThan(0);
        expect(["static", "mpak"]).toContain(e.registryType);
      }
    } finally {
      cleanup();
    }
  });

  test("dedupes on (registryId, id) — within-registry duplicates are collapsed", async () => {
    const { aggregator, store, cleanup } = freshAggregator();
    try {
      await store.update("mpak", { enabled: false });
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

  test("operatorConfigured passed through from ListEntriesContext for static-auth entries", async () => {
    const { aggregator, store, cleanup } = freshAggregator();
    try {
      await store.update("mpak", { enabled: false });
      // Stub: only "io.asana/mcp" reports configured; everything else returns false.
      const isOperatorConfigured = async (catalogId: string): Promise<boolean> =>
        catalogId === "io.asana/mcp";
      const result = await aggregator.list({ wsId: "ws_test", isOperatorConfigured });
      const asana = result.entries.find((e) => e.id === "io.asana/mcp");
      const hubspot = result.entries.find((e) => e.id === "com.hubspot/mcp");
      expect(asana?.operatorConfigured).toBe(true);
      expect(hubspot?.operatorConfigured).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("DCR entries leave operatorConfigured undefined regardless of context", async () => {
    const { aggregator, store, cleanup } = freshAggregator();
    try {
      await store.update("mpak", { enabled: false });
      // Resolver always returns true — but DCR entries (Notion, Granola)
      // shouldn't read the field at all because operator setup doesn't apply.
      const isOperatorConfigured = async (): Promise<boolean> => true;
      const result = await aggregator.list({ wsId: "ws_test", isOperatorConfigured });
      const granola = result.entries.find((e) => e.id === "ai.granola/mcp");
      expect(granola?.operatorConfigured).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("works without context — registries skip workspace-aware fields", async () => {
    const { aggregator, store, cleanup } = freshAggregator();
    try {
      await store.update("mpak", { enabled: false });
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
