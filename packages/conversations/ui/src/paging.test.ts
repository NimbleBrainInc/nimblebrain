import { describe, expect, test } from "bun:test";
import type { App } from "@nimblebrain/synapse";
import { PAGE_SIZE, readNext, readPages } from "./paging";

/** An app whose `list` serves `pages` pages of two rows, each naming the next by cursor `c<n>`. */
function pagedApp(pages: number) {
  const calls: Array<Record<string, unknown>> = [];
  const app = {
    callTool: async (_name: string, args: Record<string, unknown>) => {
      calls.push(args);
      const at = args.cursor ? Number(String(args.cursor).slice(1)) : 0;
      return {
        isError: false,
        data: {
          conversations: [
            { id: `a${at}`, active: false },
            { id: `b${at}`, active: false },
          ],
          totalCount: pages * 2,
          nextCursor: at + 1 < pages ? `c${at + 1}` : null,
        },
      };
    },
  };
  // biome-ignore lint/plugin/double-cast: a fake with only the one member the paging calls
  return { app: app as unknown as App, calls };
}

describe("paging the conversation list", () => {
  test("reads the first page, then each next page after the rows already shown", async () => {
    const { app, calls } = pagedApp(3);
    let loaded = await readPages(app, 1);
    expect(loaded.conversations.map((c) => c.id)).toEqual(["a0", "b0"]);
    expect(loaded.totalCount).toBe(6);
    loaded = await readNext(app, loaded);
    loaded = await readNext(app, loaded);
    expect(loaded.conversations.map((c) => c.id)).toEqual(["a0", "b0", "a1", "b1", "a2", "b2"]);
    expect(loaded.nextCursor).toBeNull();
    expect(calls.map((c) => c.cursor)).toEqual([undefined, "c1", "c2"]);
    expect(calls.every((c) => c.limit === PAGE_SIZE)).toBe(true);
  });

  test("a refresh reads as many pages as were shown, and stops at the last", async () => {
    const { app } = pagedApp(2);
    expect((await readPages(app, 2)).conversations).toHaveLength(4);
    expect((await readPages(app, 5)).pages).toBe(2);
  });

  test("a row already shown is not shown twice", async () => {
    const { app } = pagedApp(2);
    const first = await readPages(app, 1);
    const moved = {
      ...first,
      conversations: [...first.conversations, { id: "a1", active: false }],
    };
    const next = await readNext(app, moved);
    expect(next.conversations.map((c) => c.id)).toEqual(["a0", "b0", "a1", "b1"]);
  });
});
