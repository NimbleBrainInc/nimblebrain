import { describe, expect, it } from "bun:test";
import { ARCHIVE_FETCH_CONCURRENCY, mapArchives } from "../../../src/plugins/pinned-catalog.ts";

describe("mapArchives", () => {
  it("fetches a whole index a few archives at a time, results in index order", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 100 }, (_, i) => i);
    const out = await mapArchives(items, async (i) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Bun.sleep(1 + (i % 3));
      inFlight--;
      return i * 2;
    });
    expect(peak).toBe(ARCHIVE_FETCH_CONCURRENCY);
    expect(out).toEqual(items.map((i) => i * 2));
  });
});
