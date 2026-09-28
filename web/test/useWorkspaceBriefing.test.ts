// useWorkspaceBriefing — fetch on mount and on refresh, the stale-response
// guard, and that nothing one workspace loaded is served under another.
// callTool is mocked with manually-resolvable deferreds so we can control
// response ordering (the whole point of the request-id guard).

import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { realClient } from "./setup";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Deferred {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  args: Record<string, unknown> | undefined;
}

let calls: Deferred[] = [];

// Spread the preload's real-module snapshot (see web/test/setup.ts) so this
// whole-module mock exposes every api/client export; only `callTool` is
// overridden. Bun's mock.module registry is process-global, so an incomplete
// stub leaking into another suite's module graph is what crashed bridge tests
// with "Export named 'getActiveWorkspaceId' not found".
mock.module("../src/api/client", () => ({
  ...realClient,
  callTool: (_server: string, _tool: string, args?: Record<string, unknown>) =>
    new Promise((resolve, reject) => {
      calls.push({ resolve, reject, args });
    }),
}));

const { BRIEFING_TIMEOUT_MS, useWorkspaceBriefing } = await import(
  "../src/hooks/useWorkspaceBriefing"
);

/** Resolve the Nth callTool with one item whose label tags its origin. */
function resolveCall(i: number, label: string): void {
  calls[i]?.resolve({
    isError: false,
    structuredContent: {
      items: [{ app: "CRM", facet: "f", label, count: 1, route: "crm", state: "ok" }],
      generated_at: "2026-09-28T00:00:00.000Z",
    },
  });
}

const labelOf = (b: { items: { label: string }[] } | null) => b?.items[0]?.label;

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  calls = [];
});

describe("useWorkspaceBriefing", () => {
  test("fetches on mount and exposes the briefing", async () => {
    const { result } = renderHook(() => useWorkspaceBriefing("ws_a"));
    expect(result.current.loading).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0]?.args).toEqual({});
    await act(async () => {
      resolveCall(0, "alpha");
    });
    expect(labelOf(result.current.briefing)).toBe("alpha");
    expect(result.current.loading).toBe(false);
  });

  test("refresh() refetches with force_refresh: true", async () => {
    const { result } = renderHook(() => useWorkspaceBriefing("ws_a"));
    await act(async () => {
      resolveCall(0, "alpha");
    });
    await act(async () => {
      result.current.refresh();
    });
    expect(calls.length).toBe(2);
    expect(calls[1]?.args).toEqual({ force_refresh: true });
  });

  test("a remount fetches again: nothing is cached on the client", async () => {
    const first = renderHook(() => useWorkspaceBriefing("ws_a"));
    await act(async () => {
      resolveCall(0, "alpha");
    });
    first.unmount();

    const { result } = renderHook(() => useWorkspaceBriefing("ws_a"));
    expect(calls.length).toBe(2);
    expect(result.current.briefing).toBeNull();
    expect(result.current.loading).toBe(true);
  });

  test("no state survives a workspace change", async () => {
    const { result, rerender } = renderHook(({ ws }: { ws: string }) => useWorkspaceBriefing(ws), {
      initialProps: { ws: "ws_a" },
    });
    await act(async () => {
      resolveCall(0, "alpha");
    });
    expect(labelOf(result.current.briefing)).toBe("alpha");

    await act(async () => {
      rerender({ ws: "ws_b" });
    });
    expect(result.current.briefing).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(true);
    expect(calls.length).toBe(2);

    // An error in ws_b does not follow the member back to ws_a either.
    await act(async () => {
      calls[1]?.reject(new Error("boom"));
    });
    expect(result.current.error).toBe("boom");
    await act(async () => {
      rerender({ ws: "ws_a" });
    });
    expect(result.current.error).toBeNull();
    expect(result.current.briefing).toBeNull();
    expect(result.current.loading).toBe(true);
    expect(calls.length).toBe(3);
  });

  test("drops a stale response superseded by a workspace switch", async () => {
    const { result, rerender } = renderHook(({ ws }: { ws: string }) => useWorkspaceBriefing(ws), {
      initialProps: { ws: "ws_a" },
    });
    await act(async () => {
      rerender({ ws: "ws_b" });
    });
    expect(calls.length).toBe(2);

    await act(async () => {
      resolveCall(1, "bravo");
    });
    expect(labelOf(result.current.briefing)).toBe("bravo");

    // The slow ws_a response lands late and is dropped.
    await act(async () => {
      resolveCall(0, "alpha-stale");
    });
    expect(labelOf(result.current.briefing)).toBe("bravo");
  });

  test("a load that outlasts the client timeout becomes an error", async () => {
    jest.useFakeTimers();
    try {
      const { result } = renderHook(() => useWorkspaceBriefing("ws_a"));
      await act(async () => {
        jest.advanceTimersByTime(BRIEFING_TIMEOUT_MS);
      });
      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBe("The briefing took too long to load.");
    } finally {
      jest.useRealTimers();
    }
  });

  test("does not fetch when there is no workspace", () => {
    const { result } = renderHook(() => useWorkspaceBriefing(undefined));
    expect(calls.length).toBe(0);
    expect(result.current.loading).toBe(false);
  });
});
