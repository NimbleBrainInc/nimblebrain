import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { ConnectorRef } from "../../../src/connectors/runtime/types.ts";
import {
  buildProcessInventory,
  resolveConnectorStartConcurrency,
} from "../../../src/runtime/workspace-runtime.ts";
import type { Workspace } from "../../../src/workspace/types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeWorkspace(id: string, name: string, connectors: ConnectorRef[]): Workspace {
  return {
    id,
    name,
    members: [],
    connectors: connectors,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

const WORK_DIR = "/home/user/.nimblebrain";

function crm(): ConnectorRef {
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
    const ws = makeWorkspace("ws_002e1fc3b4a15a41", "Empty", []);
    const entries = buildProcessInventory([ws], WORK_DIR);
    expect(entries).toEqual([]);
  });

  it("2 workspaces with 3 connectors each → 6 entries", () => {
    const connectors: ConnectorRef[] = [
      crm(),
      { url: "https://tasks.example.com/mcp", serverName: "tasks" },
      { url: "https://docs.example.com/mcp", serverName: "docs" },
    ];
    const ws1 = makeWorkspace("ws_0030a37f450693bf", "Engineering", connectors);
    const ws2 = makeWorkspace("ws_006a3c0eb78706fc", "Sales", connectors);

    const entries = buildProcessInventory([ws1, ws2], WORK_DIR);
    expect(entries).toHaveLength(6);
  });

  it("each entry has correct workspace-scoped data dir", () => {
    const ws = makeWorkspace("ws_0030a37f450693bf", "Engineering", [crm()]);

    const entries = buildProcessInventory([ws], WORK_DIR);
    expect(entries).toHaveLength(1);
    expect(entries[0].dataDir).toBe(
      join(WORK_DIR, "workspaces", "ws_0030a37f450693bf", "data", "crm"),
    );
  });

  it("entry has plain serverName (no compound key)", () => {
    const ws = makeWorkspace("ws_0030a37f450693bf", "Engineering", [crm()]);

    const entries = buildProcessInventory([ws], WORK_DIR);
    expect(entries[0].serverName).toBe("crm");
  });

  it("same connector in two workspaces → two entries, different data dirs", () => {
    const connectors = [crm()];
    const ws1 = makeWorkspace("ws_0030a37f450693bf", "Engineering", connectors);
    const ws2 = makeWorkspace("ws_006a3c0eb78706fc", "Sales", connectors);

    const entries = buildProcessInventory([ws1, ws2], WORK_DIR);
    expect(entries).toHaveLength(2);

    expect(entries[0].serverName).toBe("crm");
    expect(entries[1].serverName).toBe("crm");

    expect(entries[0].dataDir).not.toBe(entries[1].dataDir);
    expect(entries[0].dataDir).toContain("ws_0030a37f450693bf");
    expect(entries[1].dataDir).toContain("ws_006a3c0eb78706fc");
  });

  it("skips a row that names no server", () => {
    const ws = makeWorkspace("ws_0061a3cbd4f78051", "Production", [
      { url: "https://example.com/mcp" } as unknown as ConnectorRef,
    ]);

    expect(buildProcessInventory([ws], WORK_DIR)).toHaveLength(0);
  });

  it("preserves the original connector ref in each entry", () => {
    const ref: ConnectorRef = {
      url: "https://crm.example.com/mcp",
      serverName: "crm",
      scopes: ["read"],
    };
    const ws = makeWorkspace("ws_002fbb9fda6654ca", "Eng", [ref]);

    const entries = buildProcessInventory([ws], WORK_DIR);
    expect(entries[0].connector).toBe(ref);
  });

  it("multiple workspaces with different connectors", () => {
    const ws1 = makeWorkspace("ws_002fbb9fda6654ca", "Engineering", [
      crm(),
      { url: "https://tasks.example.com/mcp", serverName: "tasks" },
    ]);
    const ws2 = makeWorkspace("ws_006a3c0eb78706fc", "Sales", [
      crm(),
      { url: "https://analytics.example.com/mcp", serverName: "analytics" },
      { url: "https://reports.example.com/mcp", serverName: "reports" },
    ]);

    const entries = buildProcessInventory([ws1, ws2], WORK_DIR);
    expect(entries).toHaveLength(5);

    const engEntries = entries.filter((e) => e.wsId === "ws_002fbb9fda6654ca");
    const salesEntries = entries.filter((e) => e.wsId === "ws_006a3c0eb78706fc");
    expect(engEntries).toHaveLength(2);
    expect(salesEntries).toHaveLength(3);
  });

  it("skips a row with no usable url instead of aborting the whole inventory", () => {
    // Boot reads every workspace's `connectors[]` in one pass before any
    // per-entry containment, so a throw here takes the instance down over one
    // bad row: a row with no url, and a blank or unparseable url that
    // reached the store.
    const ws = makeWorkspace("ws_004ae1946ec2cba8", "Mixed", [
      { serverName: "echo" } as unknown as ConnectorRef,
      { url: "", serverName: "echo" },
      { url: "   ", serverName: "echo" },
      { url: "...", serverName: "echo" },
      crm(),
    ]);

    const entries = buildProcessInventory([ws], WORK_DIR);

    // The healthy row survives; the unusable ones are dropped, not thrown on.
    expect(entries).toHaveLength(1);
    expect(entries[0]?.serverName).toBe("crm");
  });

  it("one workspace's bad row does not cost another workspace its connectors", () => {
    const broken = makeWorkspace("ws_00231ca3a812703c", "Broken", [
      { url: "", serverName: "echo" },
    ]);
    const healthy = makeWorkspace("ws_003de686f8a1bb95", "Healthy", [crm()]);

    const entries = buildProcessInventory([broken, healthy], WORK_DIR);

    expect(entries.map((e) => e.wsId)).toEqual(["ws_003de686f8a1bb95"]);
  });

  it("no global connector state leaks between workspaces", () => {
    const connectors = [crm()];
    const ws1 = makeWorkspace("ws_00079598e311c160", "A", connectors);
    const ws2 = makeWorkspace("ws_001c32f121060ff3", "B", connectors);

    const entries = buildProcessInventory([ws1, ws2], WORK_DIR);
    const dataDirs = entries.map((e) => e.dataDir);
    const uniqueDirs = new Set(dataDirs);
    expect(uniqueDirs.size).toBe(dataDirs.length);
  });
});

// ---------------------------------------------------------------------------
// resolveConnectorStartConcurrency
// ---------------------------------------------------------------------------

describe("resolveConnectorStartConcurrency", () => {
  const original = process.env.NB_CONNECTOR_START_CONCURRENCY;

  beforeEach(() => {
    delete process.env.NB_CONNECTOR_START_CONCURRENCY;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.NB_CONNECTOR_START_CONCURRENCY;
    else process.env.NB_CONNECTOR_START_CONCURRENCY = original;
  });

  it("defaults to 4 when unset", () => {
    expect(resolveConnectorStartConcurrency()).toBe(4);
  });

  it("defaults to 4 for empty string", () => {
    process.env.NB_CONNECTOR_START_CONCURRENCY = "";
    expect(resolveConnectorStartConcurrency()).toBe(4);
  });

  it("honors a valid positive integer", () => {
    process.env.NB_CONNECTOR_START_CONCURRENCY = "8";
    expect(resolveConnectorStartConcurrency()).toBe(8);
  });

  it("accepts 1 as the legacy sequential value", () => {
    process.env.NB_CONNECTOR_START_CONCURRENCY = "1";
    expect(resolveConnectorStartConcurrency()).toBe(1);
  });

  it("falls back to default on zero, negatives, or garbage", () => {
    process.env.NB_CONNECTOR_START_CONCURRENCY = "0";
    expect(resolveConnectorStartConcurrency()).toBe(4);
    process.env.NB_CONNECTOR_START_CONCURRENCY = "-2";
    expect(resolveConnectorStartConcurrency()).toBe(4);
    process.env.NB_CONNECTOR_START_CONCURRENCY = "abc";
    expect(resolveConnectorStartConcurrency()).toBe(4);
  });
});
