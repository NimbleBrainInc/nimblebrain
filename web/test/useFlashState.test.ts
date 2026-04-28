import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { useFlashState } from "../src/hooks/useFlashState";

let timers: Array<{ at: number; fn: () => void; id: number }> = [];
let now = 0;
let nextId = 1;

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

function advance(ms: number) {
  now += ms;
  const due = timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at);
  timers = timers.filter((t) => t.at > now);
  for (const t of due) t.fn();
}

beforeEach(() => {
  now = 0;
  nextId = 1;
  timers = [];
  // Replace setTimeout with a deterministic fake so tests don't depend on
  // real-clock progression. Cast through `unknown` because Node and DOM
  // disagree about the return type.
  (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((
    fn: () => void,
    ms: number,
  ) => {
    const id = nextId++;
    timers.push({ at: now + ms, fn, id });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  (globalThis as unknown as { clearTimeout: typeof clearTimeout }).clearTimeout = ((
    id: number,
  ) => {
    timers = timers.filter((t) => t.id !== id);
  }) as typeof clearTimeout;
});

afterEach(() => {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
});

describe("useFlashState", () => {
  it("starts inactive", () => {
    const { result } = renderHook(() => useFlashState(1500));
    expect(result.current[0]).toBe(false);
  });

  it("activates on flash() and clears after the duration", () => {
    const { result } = renderHook(() => useFlashState(1500));
    act(() => {
      result.current[1]();
    });
    expect(result.current[0]).toBe(true);
    act(() => {
      advance(1500);
    });
    expect(result.current[0]).toBe(false);
  });

  it("resets the timer when flash() is re-fired within the window", () => {
    // Re-firing should NOT cause an early clear from the prior timer —
    // the latest fire's full duration should be honored.
    const { result } = renderHook(() => useFlashState(1500));
    act(() => {
      result.current[1]();
    });
    expect(result.current[0]).toBe(true);
    act(() => {
      advance(1000); // 500ms left on the original timer
      result.current[1](); // re-fire — should reset to a fresh 1500ms
    });
    act(() => {
      advance(500); // would have cleared the original; should NOT clear the refreshed one
    });
    expect(result.current[0]).toBe(true);
    act(() => {
      advance(1000); // total elapsed since refresh = 1500ms
    });
    expect(result.current[0]).toBe(false);
  });

  it("clears the pending timer on unmount", () => {
    // Without cleanup, the setTimeout from flash() would call setState on
    // the unmounted component. We can't observe that directly here, but
    // we can assert the timer queue is drained after unmount.
    const { result, unmount } = renderHook(() => useFlashState(1500));
    act(() => {
      result.current[1]();
    });
    expect(timers.length).toBe(1);
    unmount();
    expect(timers.length).toBe(0);
  });
});
