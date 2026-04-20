import { describe, expect, it, mock, beforeEach } from "bun:test";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useShell } from "../src/hooks/useShell";

// ---------------------------------------------------------------------------
// Mock getShell
// ---------------------------------------------------------------------------

const mockGetShell = mock(() =>
  Promise.resolve({ placements: [], chatEndpoint: "", eventsEndpoint: "" }),
);

mock.module("../src/api/client", () => ({
  getShell: (...args: unknown[]) => mockGetShell(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeShell(placements: Array<{ slot: string; route?: string; priority: number }>) {
  return { placements, chatEndpoint: "/v1/chat", eventsEndpoint: "/v1/events" };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useShell", () => {
  beforeEach(() => {
    mockGetShell.mockClear();
  });

  it("uses bootstrap data without fetching on initial mount", () => {
    const bootstrap = makeShell([{ slot: "sidebar", route: "/", priority: 0 }]);

    const { result } = renderHook(() => useShell("tok", "ws-1", bootstrap));

    expect(result.current.shell).toBe(bootstrap);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(mockGetShell).not.toHaveBeenCalled();
  });

  it("fetches shell data when workspaceId changes", async () => {
    const bootstrap = makeShell([{ slot: "sidebar", route: "/home", priority: 0 }]);
    const newShell = makeShell([{ slot: "sidebar.apps", route: "/app1", priority: 10 }]);
    mockGetShell.mockResolvedValueOnce(newShell);

    const { result, rerender } = renderHook(
      ({ wsId }) => useShell("tok", wsId, bootstrap),
      { initialProps: { wsId: "ws-1" } },
    );

    // Initial: bootstrap data, no fetch
    expect(result.current.shell).toBe(bootstrap);
    expect(mockGetShell).not.toHaveBeenCalled();

    // Switch workspace — old shell stays visible (no loading flash)
    rerender({ wsId: "ws-2" });

    expect(result.current.loading).toBe(false);
    expect(result.current.shell).toBe(bootstrap); // still showing old data

    await waitFor(() => {
      expect(result.current.shell).toBe(newShell);
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(mockGetShell).toHaveBeenCalled();
  });

  it("fetches again when switching back to the original workspace", async () => {
    const bootstrap = makeShell([{ slot: "sidebar", route: "/home", priority: 0 }]);
    const ws2Shell = makeShell([{ slot: "sidebar.apps", route: "/app2", priority: 10 }]);
    const ws1Shell = makeShell([{ slot: "sidebar", route: "/refreshed", priority: 0 }]);
    mockGetShell.mockResolvedValueOnce(ws2Shell);
    mockGetShell.mockResolvedValueOnce(ws1Shell);

    const { result, rerender } = renderHook(
      ({ wsId }) => useShell("tok", wsId, bootstrap),
      { initialProps: { wsId: "ws-1" } },
    );

    // Switch to ws-2
    rerender({ wsId: "ws-2" });
    await waitFor(() => expect(result.current.shell).toBe(ws2Shell));

    // Switch back to ws-1 — must refetch, not reuse stale bootstrap
    rerender({ wsId: "ws-1" });
    await waitFor(() => expect(result.current.shell).toBe(ws1Shell));
    expect(mockGetShell).toHaveBeenCalledTimes(2);
  });

  it("does not refetch when workspaceId stays the same", () => {
    const bootstrap = makeShell([]);

    const { rerender } = renderHook(
      ({ wsId }) => useShell("tok", wsId, bootstrap),
      { initialProps: { wsId: "ws-1" } },
    );

    rerender({ wsId: "ws-1" });

    expect(mockGetShell).not.toHaveBeenCalled();
  });

  it("cancels in-flight fetch when workspaceId changes again", async () => {
    const bootstrap = makeShell([]);
    const staleShell = makeShell([{ slot: "sidebar", route: "/stale", priority: 0 }]);
    const freshShell = makeShell([{ slot: "sidebar", route: "/fresh", priority: 0 }]);

    let resolveFirst!: (v: unknown) => void;
    mockGetShell.mockImplementationOnce(
      () => new Promise((r) => { resolveFirst = r; }),
    );
    mockGetShell.mockResolvedValueOnce(freshShell);

    const { result, rerender } = renderHook(
      ({ wsId }) => useShell("tok", wsId, bootstrap),
      { initialProps: { wsId: "ws-1" } },
    );

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
    const bootstrap = makeShell([]);
    mockGetShell.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const { result, rerender } = renderHook(
      ({ wsId }) => useShell("tok", wsId, bootstrap),
      { initialProps: { wsId: "ws-1" } },
    );

    rerender({ wsId: "ws-2" });

    await waitFor(() => expect(result.current.error).toBe("ECONNREFUSED"));
    // Shell retains the previous data (bootstrap) — no null flash
    expect(result.current.shell).not.toBeNull();
  });

  it("fetches on mount when no bootstrap data is provided", async () => {
    const fetched = makeShell([{ slot: "main", route: "/app", priority: 1 }]);
    mockGetShell.mockResolvedValueOnce(fetched);

    const { result } = renderHook(() => useShell("tok", "ws-1"));

    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.shell).toBe(fetched);
    expect(mockGetShell).toHaveBeenCalled();
  });

  it("forSlot filters and sorts placements correctly", () => {
    const shell = makeShell([
      { slot: "sidebar.apps", route: "/b", priority: 20 },
      { slot: "sidebar", route: "/", priority: 0 },
      { slot: "sidebar.apps", route: "/a", priority: 10 },
      { slot: "main", route: "/other", priority: 1 },
    ]);

    const { result } = renderHook(() => useShell("tok", "ws-1", shell));

    const sidebarItems = result.current.forSlot("sidebar");
    expect(sidebarItems).toHaveLength(3);
    expect(sidebarItems[0].route).toBe("/");
    expect(sidebarItems[1].route).toBe("/a");
    expect(sidebarItems[2].route).toBe("/b");
  });

  it("forSlot sorts equal-priority placements alphabetically by label", () => {
    const shell = {
      placements: [
        { slot: "sidebar.apps", route: "/todo", priority: 100, label: "To-Do Board" },
        { slot: "sidebar.apps", route: "/crm", priority: 100, label: "CRM" },
        { slot: "sidebar.apps", route: "/collateral", priority: 100, label: "Collateral" },
      ],
      chatEndpoint: "/v1/chat",
      eventsEndpoint: "/v1/events",
    };

    const { result } = renderHook(() => useShell("tok", "ws-1", shell));

    const items = result.current.forSlot("sidebar");
    expect(items.map((p) => p.label)).toEqual(["Collateral", "CRM", "To-Do Board"]);
  });

  it("forSlot falls back to route when label is missing for tie-break", () => {
    const shell = makeShell([
      { slot: "sidebar.apps", route: "/zebra", priority: 100 },
      { slot: "sidebar.apps", route: "/apple", priority: 100 },
      { slot: "sidebar.apps", route: "/mango", priority: 100 },
    ]);

    const { result } = renderHook(() => useShell("tok", "ws-1", shell));

    const items = result.current.forSlot("sidebar");
    expect(items.map((p) => p.route)).toEqual(["/apple", "/mango", "/zebra"]);
  });
});
