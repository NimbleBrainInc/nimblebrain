import { describe, expect, it } from "bun:test";
import { mapWithConcurrency } from "../../../src/util/concurrency.ts";

describe("mapWithConcurrency", () => {
  it("returns immediately on empty input and does not invoke the worker", async () => {
    let calls = 0;
    await mapWithConcurrency([], 4, async () => {
      calls++;
    });
    expect(calls).toBe(0);
  });

  it("invokes the worker once per item with its original index", async () => {
    const items = ["a", "b", "c", "d", "e"];
    const seen: Array<{ item: string; index: number }> = [];
    await mapWithConcurrency(items, 2, async (item, index) => {
      seen.push({ item, index });
    });
    expect(seen).toHaveLength(items.length);
    // Every (item, index) pair must match the input ordering exactly,
    // regardless of completion order.
    const byIndex = seen.sort((a, b) => a.index - b.index);
    expect(byIndex.map((s) => s.item)).toEqual(items);
    expect(byIndex.map((s) => s.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it("preserves per-item index when workers complete out of order", async () => {
    // Workers finish in reverse; the index passed to each must still match
    // the item's position in the input array.
    const items = [0, 1, 2, 3, 4];
    const results: Array<{ item: number; index: number }> = [];
    await mapWithConcurrency(items, 5, async (item, index) => {
      await new Promise((resolve) => setTimeout(resolve, (items.length - item) * 5));
      results.push({ item, index });
    });
    // Completion order: item=4 first, item=0 last.
    expect(results[0]).toEqual({ item: 4, index: 4 });
    expect(results[results.length - 1]).toEqual({ item: 0, index: 0 });
    // Index always matches the item for this test (item === position).
    for (const r of results) {
      expect(r.index).toBe(r.item);
    }
  });

  it("respects the concurrency cap (peak in-flight never exceeds limit)", async () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    const cap = 3;
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(items, cap, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
    });
    expect(peak).toBeLessThanOrEqual(cap);
    // With 20 items and cap=3 and non-zero worker duration, we should
    // actually reach the cap at some point — sanity check the helper is
    // running workers concurrently, not serially.
    expect(peak).toBe(cap);
  });

  it("clamps concurrency to items.length when the cap is larger", async () => {
    const items = [1, 2, 3];
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(items, 100, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
    });
    expect(peak).toBe(items.length);
  });

  it("treats concurrency < 1 as 1 (serial fallback)", async () => {
    const items = [1, 2, 3];
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(items, 0, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
    });
    expect(peak).toBe(1);
  });

  it("propagates thrown worker errors to the caller", async () => {
    const items = [1, 2, 3];
    const err = new Error("boom");
    await expect(
      mapWithConcurrency(items, 2, async (item) => {
        if (item === 2) throw err;
      }),
    ).rejects.toBe(err);
  });
});
