import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { BundleRef } from "../../../src/bundles/types.ts";
import type { Workspace } from "../../../src/workspace/types.ts";
import {
  buildProcessInventory,
  type ProcessInventoryEntry,
  resolveBundleStartConcurrency,
} from "../../../src/runtime/workspace-runtime.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeWorkspace(id: string, name: string, bundles: BundleRef[]): Workspace {
  return {
    id,
    name,
    members: [],
    bundles,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

const WORK_DIR = "/home/user/.nimblebrain";

function crm(): BundleRef {
  return { url: "https://crm.example.com/mcp", serverName: "crm" };
}

// ---------------------------------------------------------------------------
// buildProcessInventory
// ---------------------------------------------------------------------------

describe("buildProcessInventory", () => {
  it("builds empty inventory for no workspaces", () => {
    const entries = buildProcessInventory([], WORK_DIR);
    expect(entries).toEqual([]);
  });

  it("builds empty inventory for workspace with no connectors", () => {
    const ws = makeWorkspace("ws_empty", "Empty", []);
    const entries = buildProcessInventory([ws], WORK_DIR);
    expect(entries).toEqual([]);
  });

  it("2 workspaces with 3 connectors each → 6 entries", () => {
    const bundles: BundleRef[] = [
      crm(),
      { url: "https://tasks.example.com/mcp", serverName: "tasks" },
      { url: "https://docs.example.com/mcp", serverName: "docs" },
    ];
    const ws1 = makeWorkspace("ws_engineering", "Engineering", bundles);
    const ws2 = makeWorkspace("ws_sales", "Sales", bundles);

    const entries = buildProcessInventory([ws1, ws2], WORK_DIR);
    expect(entries).toHaveLength(6);
  });

  it("each entry has correct workspace-scoped data dir", () => {
    const ws = makeWorkspace("ws_engineering", "Engineering", [crm()]);

    const entries = buildProcessInventory([ws], WORK_DIR);
    expect(entries).toHaveLength(1);
    expect(entries[0].dataDir).toBe(
      join(WORK_DIR, "workspaces", "ws_engineering", "data", "crm"),
    );
  });

  it("entry has plain serverName (no compound key)", () => {
    const ws = makeWorkspace("ws_engineering", "Engineering", [crm()]);

    const entries = buildProcessInventory([ws], WORK_DIR);
    expect(entries[0].serverName).toBe("crm");
  });

  it("same connector in two workspaces → two entries, different data dirs", () => {
    const bundles = [crm()];
    const ws1 = makeWorkspace("ws_engineering", "Engineering", bundles);
    const ws2 = makeWorkspace("ws_sales", "Sales", bundles);

    const entries = buildProcessInventory([ws1, ws2], WORK_DIR);
    expect(entries).toHaveLength(2);

    expect(entries[0].serverName).toBe("crm");
    expect(entries[1].serverName).toBe("crm");

    expect(entries[0].dataDir).not.toBe(entries[1].dataDir);
    expect(entries[0].dataDir).toContain("ws_engineering");
    expect(entries[1].dataDir).toContain("ws_sales");
  });

  it("derives serverName from the URL when the ref carries none", () => {
    const ws = makeWorkspace("ws_prod", "Production", [{ url: "https://example.com/mcp" }]);

    const entries = buildProcessInventory([ws], WORK_DIR);
    expect(entries).toHaveLength(1);
    expect(entries[0].serverName.length).toBeGreaterThan(0);
  });

  it("preserves the original connector ref in each entry", () => {
    const ref: BundleRef = {
      url: "https://crm.example.com/mcp",
      serverName: "crm",
      scopes: ["read"],
    };
    const ws = makeWorkspace("ws_eng", "Eng", [ref]);

    const entries = buildProcessInventory([ws], WORK_DIR);
    expect(entries[0].bundle).toBe(ref);
  });

  it("multiple workspaces with different connectors", () => {
    const ws1 = makeWorkspace("ws_eng", "Engineering", [
      crm(),
      { url: "https://tasks.example.com/mcp", serverName: "tasks" },
    ]);
    const ws2 = makeWorkspace("ws_sales", "Sales", [
      crm(),
      { url: "https://analytics.example.com/mcp", serverName: "analytics" },
      { url: "https://reports.example.com/mcp", serverName: "reports" },
    ]);

    const entries = buildProcessInventory([ws1, ws2], WORK_DIR);
    expect(entries).toHaveLength(5);

    const engEntries = entries.filter((e) => e.wsId === "ws_eng");
    const salesEntries = entries.filter((e) => e.wsId === "ws_sales");
    expect(engEntries).toHaveLength(2);
    expect(salesEntries).toHaveLength(3);
  });

  it("skips a row with no usable url instead of aborting the whole inventory", () => {
    // Boot reads every workspace's `bundles[]` in one pass before any
    // per-entry containment, so a throw here takes the instance down over one
    // bad row. Both reachable shapes are covered: a legacy `name:`/`path:`
    // entry predating the URL-only ref, and a `url: ""` that reached the store.
    const ws = makeWorkspace("ws_mixed", "Mixed", [
      { name: "@acme/echo" } as unknown as BundleRef,
      { path: "/opt/echo" } as unknown as BundleRef,
      { url: "" } as BundleRef,
      // Blank-but-nonempty and unparseable urls: the first guard tested
      // `length === 0`, so these still reached `getDataPath` and threw the
      // whole-instance boot crash the guard existed to stop.
      { url: "   " } as BundleRef,
      { url: "..." } as BundleRef,
      crm(),
    ]);

    const entries = buildProcessInventory([ws], WORK_DIR);

    // The healthy row survives; the three unusable ones are dropped, not thrown on.
    expect(entries).toHaveLength(1);
    expect(entries[0]?.serverName).toBe("crm");
  });

  it("one workspace's bad row does not cost another workspace its connectors", () => {
    const broken = makeWorkspace("ws_broken", "Broken", [
      { name: "@acme/echo" } as unknown as BundleRef,
    ]);
    const healthy = makeWorkspace("ws_healthy", "Healthy", [crm()]);

    const entries = buildProcessInventory([broken, healthy], WORK_DIR);

    expect(entries.map((e) => e.wsId)).toEqual(["ws_healthy"]);
  });

  it("no global connector state leaks between workspaces", () => {
    const bundles = [crm()];
    const ws1 = makeWorkspace("ws_a", "A", bundles);
    const ws2 = makeWorkspace("ws_b", "B", bundles);

    const entries = buildProcessInventory([ws1, ws2], WORK_DIR);
    const dataDirs = entries.map((e) => e.dataDir);
    const uniqueDirs = new Set(dataDirs);
    expect(uniqueDirs.size).toBe(dataDirs.length);
  });
});

// ---------------------------------------------------------------------------
// resolveBundleStartConcurrency
// ---------------------------------------------------------------------------

describe("resolveBundleStartConcurrency", () => {
  const original = process.env.NB_BUNDLE_START_CONCURRENCY;

  beforeEach(() => {
    delete process.env.NB_BUNDLE_START_CONCURRENCY;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.NB_BUNDLE_START_CONCURRENCY;
    else process.env.NB_BUNDLE_START_CONCURRENCY = original;
  });

  it("defaults to 4 when unset", () => {
    expect(resolveBundleStartConcurrency()).toBe(4);
  });

  it("defaults to 4 for empty string", () => {
    process.env.NB_BUNDLE_START_CONCURRENCY = "";
    expect(resolveBundleStartConcurrency()).toBe(4);
  });

  it("honors a valid positive integer", () => {
    process.env.NB_BUNDLE_START_CONCURRENCY = "8";
    expect(resolveBundleStartConcurrency()).toBe(8);
  });

  it("accepts 1 as the legacy sequential value", () => {
    process.env.NB_BUNDLE_START_CONCURRENCY = "1";
    expect(resolveBundleStartConcurrency()).toBe(1);
  });

  it("falls back to default on zero, negatives, or garbage", () => {
    process.env.NB_BUNDLE_START_CONCURRENCY = "0";
    expect(resolveBundleStartConcurrency()).toBe(4);
    process.env.NB_BUNDLE_START_CONCURRENCY = "-2";
    expect(resolveBundleStartConcurrency()).toBe(4);
    process.env.NB_BUNDLE_START_CONCURRENCY = "abc";
    expect(resolveBundleStartConcurrency()).toBe(4);
  });
});
