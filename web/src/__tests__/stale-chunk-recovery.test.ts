// ---------------------------------------------------------------------------
// shouldReloadForStaleChunk — the loop guard
//
// The only real branch logic in the stale-chunk recovery: a reload fires at
// most once per debounce window. A regression here (reload loop) would hammer
// the asset server and trap the user on a blank page, so it's the one piece
// worth pinning. Pure over an injected clock + Storage — no DOM needed.
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, test } from "bun:test";
import { shouldReloadForStaleChunk } from "../lib/stale-chunk-recovery";

/** Minimal in-memory Storage stub (only the two methods under test). */
function fakeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => {
      m.set(k, v);
    },
    removeItem: (k) => {
      m.delete(k);
    },
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size;
    },
  } as Storage;
}

describe("shouldReloadForStaleChunk", () => {
  let storage: Storage;
  beforeEach(() => {
    storage = fakeStorage();
  });

  test("reloads on the first stale-chunk failure", () => {
    expect(shouldReloadForStaleChunk(1_000_000, storage)).toBe(true);
  });

  test("suppresses a second failure inside the debounce window (no reload loop)", () => {
    const t0 = 1_000_000;
    expect(shouldReloadForStaleChunk(t0, storage)).toBe(true);
    expect(shouldReloadForStaleChunk(t0 + 1, storage)).toBe(false);
    expect(shouldReloadForStaleChunk(t0 + 9_999, storage)).toBe(false);
  });

  test("reloads again once the debounce window has elapsed (recovers from a later deploy)", () => {
    const t0 = 1_000_000;
    expect(shouldReloadForStaleChunk(t0, storage)).toBe(true);
    expect(shouldReloadForStaleChunk(t0 + 10_000, storage)).toBe(true);
    // ...and the fresh attempt re-arms the guard.
    expect(shouldReloadForStaleChunk(t0 + 10_001, storage)).toBe(false);
  });
});
