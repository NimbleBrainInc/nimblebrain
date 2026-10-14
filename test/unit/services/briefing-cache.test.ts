/**
 * The per-facet count cache: fresh for a minute, served stale for up to ten
 * while one refresh runs, and unavailable past that when the read fails.
 */

import { describe, expect, it } from "bun:test";
import {
  createFacetCache,
  FACET_FRESH_MS,
  FACET_STALE_CEILING_MS,
} from "../../../src/services/briefing-cache.ts";

const KEY = { workspaceId: "ws_00079598e311c160", serverName: "tasks", facetName: "blocked" };

function harness() {
  let clock = 1_000_000;
  const cache = createFacetCache(() => clock);
  let calls = 0;
  let next: () => Promise<number> = async () => 1;
  const fetch = () => {
    calls++;
    return next();
  };
  return {
    cache,
    fetch,
    advance: (ms: number) => {
      clock += ms;
    },
    calls: () => calls,
    answer: (fn: () => Promise<number>) => {
      next = fn;
    },
  };
}

describe("createFacetCache", () => {
  it("serves a fresh count without reading", async () => {
    const h = harness();
    expect(await h.cache.read(KEY, h.fetch)).toEqual({ state: "ok", count: 1 });
    h.advance(FACET_FRESH_MS - 1);
    expect(await h.cache.read(KEY, h.fetch)).toEqual({ state: "ok", count: 1 });
    expect(h.calls()).toBe(1);
  });

  it("serves a stale count at once and refreshes it in the background", async () => {
    const h = harness();
    await h.cache.read(KEY, h.fetch);
    h.advance(FACET_FRESH_MS);
    h.answer(async () => 5);

    expect(await h.cache.read(KEY, h.fetch)).toEqual({ state: "ok", count: 1 });
    await Bun.sleep(0);
    expect(await h.cache.read(KEY, h.fetch)).toEqual({ state: "ok", count: 5 });
    expect(h.calls()).toBe(2);
  });

  it("keeps the stale count when the background refresh fails", async () => {
    const h = harness();
    await h.cache.read(KEY, h.fetch);
    h.advance(FACET_FRESH_MS);
    h.answer(async () => {
      throw new Error("down");
    });

    expect(await h.cache.read(KEY, h.fetch)).toEqual({ state: "ok", count: 1 });
    await Bun.sleep(0);
    expect(await h.cache.read(KEY, h.fetch)).toEqual({ state: "ok", count: 1 });
  });

  it("is unavailable past the ceiling when the read fails", async () => {
    const h = harness();
    await h.cache.read(KEY, h.fetch);
    h.advance(FACET_STALE_CEILING_MS + 1);
    h.answer(async () => {
      throw new Error("down");
    });

    expect(await h.cache.read(KEY, h.fetch)).toEqual({ state: "unavailable" });
  });

  it("is unavailable when the first read fails", async () => {
    const h = harness();
    h.answer(async () => {
      throw new Error("down");
    });
    expect(await h.cache.read(KEY, h.fetch)).toEqual({ state: "unavailable" });
  });

  it("shares one read between concurrent loads of the same facet", async () => {
    const h = harness();
    let release!: (n: number) => void;
    h.answer(() => new Promise<number>((resolve) => (release = resolve)));

    const both = Promise.all([h.cache.read(KEY, h.fetch), h.cache.read(KEY, h.fetch)]);
    release(4);

    expect(await both).toEqual([
      { state: "ok", count: 4 },
      { state: "ok", count: 4 },
    ]);
    expect(h.calls()).toBe(1);
  });

  it("reads again on force, even when fresh", async () => {
    const h = harness();
    await h.cache.read(KEY, h.fetch);
    h.answer(async () => 9);
    expect(await h.cache.read(KEY, h.fetch, { force: true })).toEqual({ state: "ok", count: 9 });
    expect(h.calls()).toBe(2);
  });
});
