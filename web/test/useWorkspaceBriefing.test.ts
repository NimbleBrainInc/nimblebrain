// useWorkspaceBriefing — the logic-heavy half of the briefing restore: the
// monotonic stale-response guard, clear-on-workspace-switch, and force_refresh
// routing. callTool is mocked with manually-resolvable deferreds so we can
// control response ordering (the whole point of the reqRef guard).

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
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

const { useWorkspaceBriefing } = await import("../src/hooks/useWorkspaceBriefing");

/** Resolve the Nth callTool with a briefing whose greeting tags its origin. */
function resolveCall(i: number, greeting: string): void {
  calls[i]?.resolve({
    isError: false,
    structuredContent: {
      greeting,
      date: "",
      lede: "",
      sections: [],
      state: "quiet",
      generated_at: "",
      cached: false,
    },
  });
}

const flush = () => act(async () => { await Promise.resolve(); });

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  calls = [];
});

describe("useWorkspaceBriefing", () => {
  test("fetches on mount and exposes the briefing", async () => {
    const { result } = renderHook(() => useWorkspaceBriefing("ws_a"));
    expect(calls.length).toBe(1);
    expect(calls[0]?.args).toEqual({}); // initial load is not a force-refresh
    await act(async () => {
      resolveCall(0, "alpha");
    });
    expect(result.current.briefing?.greeting).toBe("alpha");
    expect(result.current.loading).toBe(false);
  });

  test("refresh() sends force_refresh: true", async () => {
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

  test("switching workspace clears the briefing before the refetch resolves", async () => {
    const { result, rerender } = renderHook(({ ws }: { ws: string }) => useWorkspaceBriefing(ws), {
      initialProps: { ws: "ws_a" },
    });
    await act(async () => {
      resolveCall(0, "alpha");
    });
    expect(result.current.briefing?.greeting).toBe("alpha");

    await act(async () => {
      rerender({ ws: "ws_b" });
    });
    // Cleared immediately so the old workspace's briefing never shows under
    // the new X-Workspace-Id header; ws_b's fetch is now in flight.
    expect(result.current.briefing).toBeNull();
    expect(calls.length).toBe(2);
  });

  test("drops a stale response superseded by a workspace switch", async () => {
    const { result, rerender } = renderHook(({ ws }: { ws: string }) => useWorkspaceBriefing(ws), {
      initialProps: { ws: "ws_a" },
    });
    // call 0 = ws_a (left pending — the slow one)
    await act(async () => {
      rerender({ ws: "ws_b" });
    });
    expect(calls.length).toBe(2); // call 1 = ws_b

    // ws_b resolves first and wins.
    await act(async () => {
      resolveCall(1, "bravo");
    });
    expect(result.current.briefing?.greeting).toBe("bravo");

    // The slow ws_a now resolves LATE — the monotonic reqRef guard must drop
    // it so it can't clobber the current (ws_b) briefing.
    await act(async () => {
      resolveCall(0, "alpha-stale");
    });
    await flush();
    expect(result.current.briefing?.greeting).toBe("bravo");
  });

  test("does not fetch when there is no active workspace", () => {
    renderHook(() => useWorkspaceBriefing(undefined));
    expect(calls.length).toBe(0);
  });
});
