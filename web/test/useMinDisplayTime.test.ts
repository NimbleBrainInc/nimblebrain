/**
 * useMinDisplayTime — smoothed running→done transitions.
 *
 * The accordion owns the running state; this hook prevents very fast tools
 * from flashing through it in a handful of milliseconds. Covers:
 *   - Tools loaded already-complete pass through immediately (no flash).
 *   - Tools first seen running stay running until the grace period elapses.
 *   - After the grace period, they snap to their terminal status.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { renderHook } from "@testing-library/react";
import type { ToolCallDisplay } from "../src/hooks/useChat";
import { useMinDisplayTime } from "../src/hooks/useMinDisplayTime";

function makeCall(overrides: Partial<ToolCallDisplay> & { id: string }): ToolCallDisplay {
  return {
    id: overrides.id,
    name: "test_tool",
    status: "done",
    ok: true,
    ms: 10,
    ...overrides,
  };
}

let fakeNow = 0;
const realDateNow = Date.now;
beforeEach(() => {
  fakeNow = 1_000_000;
  Date.now = () => fakeNow;
});
afterEach(() => {
  Date.now = realDateNow;
});

describe("useMinDisplayTime", () => {
  it("passes through already-complete tools without a running flash (history load)", () => {
    const calls = [
      makeCall({ id: "a", status: "done", ok: true }),
      makeCall({ id: "b", status: "error", ok: false }),
    ];
    const { result } = renderHook(() => useMinDisplayTime(calls));
    expect(result.current[0].status).toBe("done");
    expect(result.current[1].status).toBe("error");
  });

  it("keeps tools first observed as running in the running state", () => {
    const calls = [makeCall({ id: "a", status: "running" })];
    const { result } = renderHook(() => useMinDisplayTime(calls));
    expect(result.current[0].status).toBe("running");
  });

  it("holds on running for the grace period after a tool completes", () => {
    const running = [makeCall({ id: "a", status: "running" })];
    const { result, rerender } = renderHook(
      ({ calls }: { calls: ToolCallDisplay[] }) => useMinDisplayTime(calls),
      { initialProps: { calls: running } },
    );
    expect(result.current[0].status).toBe("running");

    fakeNow += 100;
    const completed = [makeCall({ id: "a", status: "done" })];
    rerender({ calls: completed });
    expect(result.current[0].status).toBe("running");
  });

  it("releases to the final status after the grace period elapses", () => {
    const running = [makeCall({ id: "a", status: "running" })];
    const { result, rerender } = renderHook(
      ({ calls }: { calls: ToolCallDisplay[] }) => useMinDisplayTime(calls),
      { initialProps: { calls: running } },
    );

    fakeNow += 700;
    const completed = [makeCall({ id: "a", status: "done", ms: 700 })];
    rerender({ calls: completed });
    expect(result.current[0].status).toBe("done");
    expect(result.current[0].ms).toBe(700);
  });

  it("is stable when the same already-complete calls re-render", () => {
    const calls = [makeCall({ id: "a", status: "done" })];
    const { result, rerender } = renderHook(
      ({ calls }: { calls: ToolCallDisplay[] }) => useMinDisplayTime(calls),
      { initialProps: { calls } },
    );
    expect(result.current[0].status).toBe("done");
    fakeNow += 10_000;
    rerender({ calls });
    expect(result.current[0].status).toBe("done");
  });
});
