import { describe, expect, test } from "bun:test";
import type { App } from "@nimblebrain/synapse";
import { fetchPage, PAGE_SIZE } from "./useFileList";

/** An app whose `list` serves `pages` pages, each naming the next by cursor `c<n>`. */
function pagedApp(pages: number) {
  const calls: Array<Record<string, unknown>> = [];
  const app = {
    callTool: async (_name: string, args: Record<string, unknown>) => {
      calls.push(args);
      const at = args.cursor ? Number(String(args.cursor).slice(1)) : 0;
      return {
        isError: false,
        data: {
          files: [{ id: `f${at}` }],
          total: pages * PAGE_SIZE,
          folders: [],
          breadcrumb: [],
          facets: {},
          nextCursor: at + 1 < pages ? `c${at + 1}` : null,
        },
      };
    },
  };
  // biome-ignore lint/plugin/double-cast: a fake with only the one member fetchPage calls
  return { app: app as unknown as App, calls };
}

describe("fetchPage", () => {
  test("follows cursors to a page, keeping each, and reuses them going back", async () => {
    const { app, calls } = pagedApp(4);
    const cursors: Array<string | undefined> = [undefined];
    const third = await fetchPage(app, "{}", 2, cursors);
    expect(third.files[0]?.id).toBe("f2");
    expect(calls.map((c) => c.cursor)).toEqual([undefined, "c1", "c2"]);
    expect(cursors).toEqual([undefined, "c1", "c2", "c3"]);
    calls.length = 0;
    expect((await fetchPage(app, "{}", 1, cursors)).files[0]?.id).toBe("f1");
    expect(calls.map((c) => c.cursor)).toEqual(["c1"]);
    expect(calls.every((c) => c.offset === undefined && c.limit === PAGE_SIZE)).toBe(true);
  });

  test("a page past the end answers the last page there is", async () => {
    const { app } = pagedApp(2);
    expect((await fetchPage(app, "{}", 5, [undefined])).files[0]?.id).toBe("f1");
  });
});
