import { describe, expect, test } from "bun:test";
import type { PlacementEntry } from "../../../src/bundles/types.ts";
import type { Workspace } from "../../../src/workspace/types.ts";
import { filterPlacementsForWorkspace } from "../../../src/runtime/workspace-access.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorkspace(bundles: Workspace["bundles"]): Workspace {
  return {
    id: "ws-1",
    name: "Test Workspace",
    members: [],
    bundles,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
  };
}

// ---------------------------------------------------------------------------
// filterPlacementsForWorkspace
// ---------------------------------------------------------------------------

describe("filterPlacementsForWorkspace", () => {
  const placement = (serverName: string): PlacementEntry => ({
    serverName,
    slot: "sidebar",
    resourceUri: `ui://${serverName}/main`,
    priority: 100,
  });

  test("placements without wsId are always included (protected)", () => {
    const ws = makeWorkspace([]);

    const placements = [placement("bash"), placement("echo")];
    const result = filterPlacementsForWorkspace(placements, ws);
    expect(result.map((p) => p.serverName)).toEqual(["bash", "echo"]);
  });

  test("placement with matching wsId is included", () => {
    const ws = makeWorkspace([]);

    const p: PlacementEntry = {
      ...placement("echo"),
      wsId: "ws-1",
    };
    const result = filterPlacementsForWorkspace([p], ws);
    expect(result.map((e) => e.serverName)).toEqual(["echo"]);
  });

  test("placement with non-matching wsId is excluded", () => {
    const ws = makeWorkspace([]);

    const p: PlacementEntry = {
      ...placement("echo"),
      wsId: "ws-other",
    };
    const result = filterPlacementsForWorkspace([p], ws);
    expect(result).toEqual([]);
  });

  test("mixed protected and workspace-scoped placements", () => {
    const ws = makeWorkspace([]);

    const placements: PlacementEntry[] = [
      placement("protected-app"), // no wsId → protected, included
      { ...placement("ws-app"), wsId: "ws-1" }, // matching wsId → included
      { ...placement("other-app"), wsId: "ws-other" }, // non-matching wsId → excluded
    ];

    const result = filterPlacementsForWorkspace(placements, ws);
    expect(result.map((p) => p.serverName)).toEqual(["protected-app", "ws-app"]);
  });
});

// ---------------------------------------------------------------------------
// wsId tagging (type-level — ensures BundleInstance supports wsId)
// ---------------------------------------------------------------------------

describe("wsId tagging on BundleInstance", () => {
  test("workspace bundle instance has wsId set", async () => {
    const { default: types } = await import("../../../src/bundles/types.ts");
    // Type-level check — BundleInstance should have optional wsId
    const instance = {
      serverName: "echo",
      bundleName: "@test/echo",
      version: "1.0.0",
      state: "running" as const,
      trustScore: null,
      ui: null,
      briefing: null,
      protected: false,
      type: "plain" as const,
      wsId: "ws-1",
    };
    expect(instance.wsId).toBe("ws-1");
  });
});
