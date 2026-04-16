import { describe, expect, it } from "bun:test";
import type { ToolCallDisplay } from "../src/hooks/useChat";
import { partitionToolCalls } from "../src/lib/tool-grouping";

function tc(name: string, id = `id-${Math.random()}`): ToolCallDisplay {
  return { id, name, status: "done" };
}

describe("partitionToolCalls", () => {
  it("returns an empty array for no calls", () => {
    expect(partitionToolCalls([])).toEqual([]);
  });

  it("keeps a single call as a single", () => {
    const calls = [tc("read")];
    const units = partitionToolCalls(calls);
    expect(units).toHaveLength(1);
    expect(units[0].kind).toBe("single");
    expect(units[0].indexes).toEqual([0]);
  });

  it("keeps two calls as two singles (below threshold)", () => {
    const calls = [tc("read"), tc("read")];
    const units = partitionToolCalls(calls);
    expect(units).toHaveLength(2);
    expect(units.every((u) => u.kind === "single")).toBe(true);
  });

  it("groups 3+ consecutive same-named calls into a homogeneous group", () => {
    const calls = [tc("read", "a"), tc("read", "b"), tc("read", "c")];
    const units = partitionToolCalls(calls);
    expect(units).toHaveLength(1);
    expect(units[0].kind).toBe("group");
    expect(units[0].groupName).toBe("read");
    expect(units[0].uniqueNames).toEqual(["read"]);
    expect(units[0].calls.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(units[0].indexes).toEqual([0, 1, 2]);
  });

  it("strips server prefixes when matching names", () => {
    const calls = [tc("docs__read"), tc("other__read"), tc("read")];
    const units = partitionToolCalls(calls);
    expect(units).toHaveLength(1);
    expect(units[0].kind).toBe("group");
    expect(units[0].groupName).toBe("read");
  });

  it("coalesces 3+ mixed singles into a mixed group", () => {
    const calls = [tc("status"), tc("search"), tc("list")];
    const units = partitionToolCalls(calls);
    expect(units).toHaveLength(1);
    expect(units[0].kind).toBe("group");
    expect(units[0].groupName).toBe("__mixed__");
    expect(units[0].uniqueNames).toEqual(["status", "search", "list"]);
  });

  it("dedupes uniqueNames in a mixed group", () => {
    const calls = [tc("status"), tc("search"), tc("status")];
    const units = partitionToolCalls(calls);
    expect(units).toHaveLength(1);
    expect(units[0].uniqueNames).toEqual(["status", "search"]);
  });

  it("does not coalesce 2 mixed singles", () => {
    const calls = [tc("status"), tc("search")];
    const units = partitionToolCalls(calls);
    expect(units).toHaveLength(2);
    expect(units.every((u) => u.kind === "single")).toBe(true);
  });

  it("keeps homogeneous groups separate from adjacent singles", () => {
    // [status, read×3] → single status, group of 3 reads
    const calls = [tc("status"), tc("read"), tc("read"), tc("read")];
    const units = partitionToolCalls(calls);
    expect(units).toHaveLength(2);
    expect(units[0].kind).toBe("single");
    expect(units[0].calls[0].name).toBe("status");
    expect(units[1].kind).toBe("group");
    expect(units[1].groupName).toBe("read");
    expect(units[1].calls).toHaveLength(3);
  });

  it("keeps group-then-single order and indexing", () => {
    // [read×3, status] → group of 3 reads, single status
    const calls = [tc("read"), tc("read"), tc("read"), tc("status")];
    const units = partitionToolCalls(calls);
    expect(units).toHaveLength(2);
    expect(units[0].kind).toBe("group");
    expect(units[0].indexes).toEqual([0, 1, 2]);
    expect(units[1].kind).toBe("single");
    expect(units[1].indexes).toEqual([3]);
  });

  it("emits two homogeneous groups when two 3+ runs are adjacent", () => {
    const calls = [
      tc("read"),
      tc("read"),
      tc("read"),
      tc("search"),
      tc("search"),
      tc("search"),
    ];
    const units = partitionToolCalls(calls);
    expect(units).toHaveLength(2);
    expect(units[0].groupName).toBe("read");
    expect(units[0].calls).toHaveLength(3);
    expect(units[1].groupName).toBe("search");
    expect(units[1].calls).toHaveLength(3);
  });

  it("coalesces singletons that wrap around homogeneous groups", () => {
    // [a, b, read×3, c, d, e] → 2 singles (below threshold), group, mixed group of 3
    const calls = [
      tc("a"),
      tc("b"),
      tc("read"),
      tc("read"),
      tc("read"),
      tc("c"),
      tc("d"),
      tc("e"),
    ];
    const units = partitionToolCalls(calls);
    expect(units).toHaveLength(4);
    expect(units[0].kind).toBe("single");
    expect(units[1].kind).toBe("single");
    expect(units[2].kind).toBe("group");
    expect(units[2].groupName).toBe("read");
    expect(units[3].kind).toBe("group");
    expect(units[3].groupName).toBe("__mixed__");
    expect(units[3].uniqueNames).toEqual(["c", "d", "e"]);
  });

  it("preserves every call exactly once across units", () => {
    const calls = [
      tc("status", "s1"),
      tc("search", "s2"),
      tc("search", "s3"),
      tc("read", "r1"),
      tc("read", "r2"),
      tc("read", "r3"),
      tc("read", "r4"),
      tc("manage", "m1"),
    ];
    const units = partitionToolCalls(calls);
    const seenIds = units.flatMap((u) => u.calls.map((c) => c.id));
    expect(seenIds).toEqual(["s1", "s2", "s3", "r1", "r2", "r3", "r4", "m1"]);
    const seenIdx = units.flatMap((u) => u.indexes);
    expect(seenIdx).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("handles a pure mixed-group scenario with more than threshold", () => {
    // All different names, 5 total → one mixed group of 5
    const calls = [tc("a"), tc("b"), tc("c"), tc("d"), tc("e")];
    const units = partitionToolCalls(calls);
    expect(units).toHaveLength(1);
    expect(units[0].groupName).toBe("__mixed__");
    expect(units[0].calls).toHaveLength(5);
  });
});
