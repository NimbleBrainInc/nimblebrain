import { describe, expect, it, mock, beforeEach } from "bun:test";
import { renderHook, waitFor } from "@testing-library/react";
import { useShell } from "../src/hooks/useShell";
import type { PlacementEntry, ShellResponse } from "../src/types";
import { realClient } from "./setup";

// ---------------------------------------------------------------------------
// Mock getShell
// ---------------------------------------------------------------------------

const mockGetShell = mock(
  (_workspaceId?: string): Promise<ShellResponse> =>
    Promise.resolve({ placements: [], chatEndpoint: "", eventsEndpoint: "" }),
);

// Spread the preload's real-module snapshot (see web/test/setup.ts) so this
// whole-module mock exposes every api/client export; only `getShell` is
// overridden. Bun's mock.module registry is process-global, so an incomplete
// stub leaking into another suite's module graph is what crashed bridge tests
// with "Export named 'getActiveWorkspaceId' not found".
mock.module("../src/api/client", () => ({
  ...realClient,
  getShell: (workspaceId?: string) => mockGetShell(workspaceId),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `useShell` reads only slot, route, priority and label; the rest is filler. */
function makeShell(
  placements: Array<Omit<PlacementEntry, "serverName" | "resourceUri">>,
): ShellResponse {
  return {
    placements: placements.map((p) => ({ serverName: "app", resourceUri: "ui://app/panel", ...p })),
    chatEndpoint: "/v1/chat",
    eventsEndpoint: "/v1/events",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useShell", () => {
  beforeEach(() => {
    mockGetShell.mockReset();
    mockGetShell.mockResolvedValue({ placements: [], chatEndpoint: "", eventsEndpoint: "" });
  });

  /** Mount on `ws-1` and let its shell land. */
  async function mountOn(first: ShellResponse) {
    mockGetShell.mockResolvedValueOnce(first);
    const hook = renderHook(({ wsId }: { wsId?: string }) => useShell("tok", wsId), {
      initialProps: { wsId: "ws-1" as string | undefined },
    });
    await waitFor(() => expect(hook.result.current.shell).toBe(first));
    return hook;
  }

  it("fetches nothing when no workspace is named", () => {
    const { result } = renderHook(() => useShell("tok", undefined));

    expect(result.current.loading).toBe(false);
    expect(result.current.shell).toBeNull();
    expect(result.current.shellWorkspaceId).toBeUndefined();
    expect(mockGetShell).not.toHaveBeenCalled();
  });

  it("fetches the named workspace's shell on mount", async () => {
    const fetched = makeShell([{ slot: "main", route: "/app", priority: 1 }]);
    mockGetShell.mockResolvedValueOnce(fetched);

    const { result } = renderHook(() => useShell("tok", "ws-1"));

    expect(result.current.loading).toBe(true);
    expect(result.current.shellWorkspaceId).toBeUndefined();

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.shell).toBe(fetched);
    expect(result.current.shellWorkspaceId).toBe("ws-1");
    expect(mockGetShell.mock.calls).toEqual([["ws-1"]]);
  });

  it("fetches shell data when workspaceId changes", async () => {
    const first = makeShell([{ slot: "sidebar", route: "/home", priority: 0 }]);
    const newShell = makeShell([{ slot: "sidebar.apps", route: "/app1", priority: 10 }]);
    const { result, rerender } = await mountOn(first);
    mockGetShell.mockResolvedValueOnce(newShell);

    // Switch workspace — old shell stays visible (no loading flash)
    rerender({ wsId: "ws-2" });

    expect(result.current.loading).toBe(false);
    expect(result.current.shell).toBe(first); // still showing old data
    // ...and shellWorkspaceId still points at the OLD workspace: this is the
    // window the overview page reads to render a skeleton instead of the old
    // workspace's apps (loading stays false, so it can't rely on that).
    expect(result.current.shellWorkspaceId).toBe("ws-1");

    await waitFor(() => {
      expect(result.current.shell).toBe(newShell);
    });

    // Once the fetch lands, the shell reflects the new workspace — the one
    // the fetch named, not whichever the client's active workspace was.
    expect(result.current.shellWorkspaceId).toBe("ws-2");
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(mockGetShell.mock.calls).toEqual([["ws-1"], ["ws-2"]]);
  });

  it("fetches again when switching back to the original workspace", async () => {
    const first = makeShell([{ slot: "sidebar", route: "/home", priority: 0 }]);
    const ws2Shell = makeShell([{ slot: "sidebar.apps", route: "/app2", priority: 10 }]);
    const ws1Shell = makeShell([{ slot: "sidebar", route: "/refreshed", priority: 0 }]);
    const { result, rerender } = await mountOn(first);
    mockGetShell.mockResolvedValueOnce(ws2Shell);
    mockGetShell.mockResolvedValueOnce(ws1Shell);

    rerender({ wsId: "ws-2" });
    await waitFor(() => expect(result.current.shell).toBe(ws2Shell));

    rerender({ wsId: "ws-1" });
    await waitFor(() => expect(result.current.shell).toBe(ws1Shell));
    expect(mockGetShell).toHaveBeenCalledTimes(3);
  });

  it("does not refetch when workspaceId stays the same", async () => {
    const { rerender } = await mountOn(makeShell([]));

    rerender({ wsId: "ws-1" });

    expect(mockGetShell).toHaveBeenCalledTimes(1);
  });

  it("keeps the shell it has when the workspace goes away", async () => {
    const first = makeShell([{ slot: "sidebar", route: "/home", priority: 0 }]);
    const { result, rerender } = await mountOn(first);

    rerender({ wsId: undefined });

    expect(result.current.shell).toBe(first);
    expect(result.current.loading).toBe(false);
    expect(mockGetShell).toHaveBeenCalledTimes(1);
  });

  it("cancels in-flight fetch when workspaceId changes again", async () => {
    const staleShell = makeShell([{ slot: "sidebar", route: "/stale", priority: 0 }]);
    const freshShell = makeShell([{ slot: "sidebar", route: "/fresh", priority: 0 }]);
    const { result, rerender } = await mountOn(makeShell([]));

    let resolveFirst!: (v: ShellResponse) => void;
    mockGetShell.mockImplementationOnce(
      () => new Promise((r) => { resolveFirst = r; }),
    );
    mockGetShell.mockResolvedValueOnce(freshShell);

    // Switch to ws-2 — starts fetch (no loading flash, keeps old shell)
    rerender({ wsId: "ws-2" });
    expect(result.current.loading).toBe(false);

    // Switch to ws-3 before ws-2 fetch completes — cancels ws-2 fetch
    rerender({ wsId: "ws-3" });

    // Resolve the stale ws-2 fetch — should be ignored
    resolveFirst(staleShell);

    await waitFor(() => expect(result.current.shell).toBe(freshShell));
  });

  it("sets error on fetch failure", async () => {
    const { result, rerender } = await mountOn(makeShell([]));
    mockGetShell.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    rerender({ wsId: "ws-2" });

    await waitFor(() => expect(result.current.error).toBe("ECONNREFUSED"));
    // Shell retains the previous workspace's data — no null flash
    expect(result.current.shell).not.toBeNull();
  });

  it("forSlot filters and sorts placements correctly", async () => {
    const { result } = await mountOn(
      makeShell([
        { slot: "sidebar.apps", route: "/b", priority: 20 },
        { slot: "sidebar", route: "/", priority: 0 },
        { slot: "sidebar.apps", route: "/a", priority: 10 },
        { slot: "main", route: "/other", priority: 1 },
      ]),
    );

    const sidebarItems = result.current.forSlot("sidebar");
    expect(sidebarItems).toHaveLength(3);
    expect(sidebarItems[0].route).toBe("/");
    expect(sidebarItems[1].route).toBe("/a");
    expect(sidebarItems[2].route).toBe("/b");
  });

  it("forSlot sorts equal-priority placements alphabetically by label", async () => {
    const { result } = await mountOn(
      makeShell([
        { slot: "sidebar.apps", route: "/todo", priority: 100, label: "To-Do Board" },
        { slot: "sidebar.apps", route: "/crm", priority: 100, label: "CRM" },
        { slot: "sidebar.apps", route: "/collateral", priority: 100, label: "Collateral" },
      ]),
    );

    const items = result.current.forSlot("sidebar");
    expect(items.map((p) => p.label)).toEqual(["Collateral", "CRM", "To-Do Board"]);
  });

  it("forSlot falls back to route when label is missing for tie-break", async () => {
    const { result } = await mountOn(
      makeShell([
        { slot: "sidebar.apps", route: "/zebra", priority: 100 },
        { slot: "sidebar.apps", route: "/apple", priority: 100 },
        { slot: "sidebar.apps", route: "/mango", priority: 100 },
      ]),
    );

    const items = result.current.forSlot("sidebar");
    expect(items.map((p) => p.route)).toEqual(["/apple", "/mango", "/zebra"]);
  });
});
