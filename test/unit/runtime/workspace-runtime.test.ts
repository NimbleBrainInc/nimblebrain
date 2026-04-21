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

function makeWorkspace(
  id: string,
  name: string,
  bundles: BundleRef[],
): Workspace {
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

// ---------------------------------------------------------------------------
// buildProcessInventory
// ---------------------------------------------------------------------------

describe("buildProcessInventory", () => {
  it("builds empty inventory for no workspaces", () => {
    const entries = buildProcessInventory([], WORK_DIR);
    expect(entries).toEqual([]);
  });

  it("builds empty inventory for workspace with no bundles", () => {
    const ws = makeWorkspace("ws_empty", "Empty", []);
    const entries = buildProcessInventory([ws], WORK_DIR);
    expect(entries).toEqual([]);
  });

  it("2 workspaces with 3 bundles each → 6 entries", () => {
    const bundles: BundleRef[] = [
      { name: "@nimblebraininc/crm" },
      { name: "@nimblebraininc/tasks" },
      { name: "@nimblebraininc/docs" },
    ];
    const ws1 = makeWorkspace("ws_engineering", "Engineering", bundles);
    const ws2 = makeWorkspace("ws_sales", "Sales", bundles);

    const entries = buildProcessInventory([ws1, ws2], WORK_DIR);
    expect(entries).toHaveLength(6);
  });

  it("each entry has correct workspace-scoped data dir", () => {
    const bundles: BundleRef[] = [{ name: "@nimblebraininc/crm" }];
    const ws = makeWorkspace("ws_engineering", "Engineering", bundles);

    const entries = buildProcessInventory([ws], WORK_DIR);
    expect(entries).toHaveLength(1);
    expect(entries[0].dataDir).toBe(
      join(WORK_DIR, "workspaces", "ws_engineering", "data", "nimblebraininc-crm"),
    );
  });

  it("entry has plain serverName (no compound key)", () => {
    const bundles: BundleRef[] = [{ name: "@nimblebraininc/crm" }];
    const ws = makeWorkspace("ws_engineering", "Engineering", bundles);

    const entries = buildProcessInventory([ws], WORK_DIR);
    expect(entries[0].serverName).toBe("crm");
  });

  it("same bundle in two workspaces → two entries, different data dirs", () => {
    const bundles: BundleRef[] = [{ name: "@nimblebraininc/crm" }];
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

  it("handles path-based bundle refs", () => {
    const bundles: BundleRef[] = [{ path: "../mcp-servers/echo" }];
    const ws = makeWorkspace("ws_dev", "Dev", bundles);

    const entries = buildProcessInventory([ws], WORK_DIR);
    expect(entries).toHaveLength(1);
    expect(entries[0].serverName).toBe("echo");
  });

  it("handles url-based bundle refs with explicit serverName", () => {
    const bundles: BundleRef[] = [
      { url: "https://example.com/mcp", serverName: "remote-tool" },
    ];
    const ws = makeWorkspace("ws_prod", "Production", bundles);

    const entries = buildProcessInventory([ws], WORK_DIR);
    expect(entries).toHaveLength(1);
    expect(entries[0].serverName).toBe("remote-tool");
  });

  it("preserves the original bundle ref in each entry", () => {
    const ref: BundleRef = {
      name: "@nimblebraininc/crm",
      env: { DB_URL: "postgres://localhost/crm" },
    };
    const ws = makeWorkspace("ws_eng", "Eng", [ref]);

    const entries = buildProcessInventory([ws], WORK_DIR);
    expect(entries[0].bundle).toBe(ref);
  });

  it("multiple workspaces with different bundles", () => {
    const ws1 = makeWorkspace("ws_eng", "Engineering", [
      { name: "@nimblebraininc/crm" },
      { name: "@nimblebraininc/tasks" },
    ]);
    const ws2 = makeWorkspace("ws_sales", "Sales", [
      { name: "@nimblebraininc/crm" },
      { name: "@acme/analytics" },
      { name: "@acme/reports" },
    ]);

    const entries = buildProcessInventory([ws1, ws2], WORK_DIR);
    expect(entries).toHaveLength(5);

    const engEntries = entries.filter((e) => e.wsId === "ws_eng");
    const salesEntries = entries.filter((e) => e.wsId === "ws_sales");
    expect(engEntries).toHaveLength(2);
    expect(salesEntries).toHaveLength(3);
  });

  it("no global bundle state leaks between workspaces", () => {
    const bundles: BundleRef[] = [{ name: "@nimblebraininc/crm" }];
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
