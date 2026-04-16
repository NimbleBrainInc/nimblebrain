import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BundleRef } from "../../../src/bundles/types.ts";
import type { EngineEvent, EventSink } from "../../../src/engine/types.ts";
import {
  buildProcessInventory,
  type ProcessInventoryEntry,
  startWorkspaceBundles,
} from "../../../src/runtime/workspace-runtime.ts";
import { WorkspaceStore } from "../../../src/workspace/workspace-store.ts";
import type { Workspace } from "../../../src/workspace/types.ts";

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
// startWorkspaceBundles — failure surfacing (issue #7)
// ---------------------------------------------------------------------------

describe("startWorkspaceBundles — bundle.start_failed surfacing", () => {
  it("emits bundle.start_failed and returns failures when a local bundle path is missing", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "nb-start-fail-"));
    try {
      const store = new WorkspaceStore(tmp);
      const ws = await store.create("Broken");
      // Point at a path that does not exist — startBundleSource will throw
      // "Local bundle not found" inside the try block.
      await store.update(ws.id, {
        bundles: [{ path: "/this/path/does/not/exist/__nb_test__" }],
      });

      const collected: EngineEvent[] = [];
      const sink: EventSink = { emit: (e) => collected.push(e) };

      // Swallow the "Failed to start" stderr write that the function also does
      // — the important behavior is the event + return value.
      const origWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = (() => true) as typeof process.stderr.write;
      try {
        const result = await startWorkspaceBundles(store, [], null, undefined, {
          workDir: tmp,
          eventSink: sink,
        });

        // The failed bundle is not in resultEntries, but is in startFailures.
        expect(result.entries.some((e) => e.wsId === ws.id)).toBe(false);
        expect(result.startFailures).toHaveLength(1);
        expect(result.startFailures[0]!.wsId).toBe(ws.id);
        expect(result.startFailures[0]!.error).toContain("Local bundle not found");

        // The registry was still created so the workspace is usable for
        // platform tools — existing "startup continues on failure" behavior.
        expect(result.registries.has(ws.id)).toBe(true);

        // An event was emitted with the same details.
        const failedEvents = collected.filter((e) => e.type === "bundle.start_failed");
        expect(failedEvents).toHaveLength(1);
        expect(failedEvents[0]!.data.wsId).toBe(ws.id);
        expect(failedEvents[0]!.data.error).toContain("Local bundle not found");
      } finally {
        process.stderr.write = origWrite;
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("no failures emitted and no event when all bundles start cleanly (empty workspace)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "nb-start-ok-"));
    try {
      const store = new WorkspaceStore(tmp);
      await store.create("Empty");

      const collected: EngineEvent[] = [];
      const sink: EventSink = { emit: (e) => collected.push(e) };

      const result = await startWorkspaceBundles(store, [], null, undefined, {
        workDir: tmp,
        eventSink: sink,
      });

      expect(result.startFailures).toEqual([]);
      expect(collected.filter((e) => e.type === "bundle.start_failed")).toHaveLength(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
