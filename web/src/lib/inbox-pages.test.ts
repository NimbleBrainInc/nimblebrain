import { describe, expect, test } from "bun:test";
import type { NotificationView } from "../api/notifications";
import { appendOlderPage, EMPTY_PAGES, mergeFirstPage, oldestSeq } from "./inbox-pages";

function item(seq: number, over: Partial<NotificationView> = {}): NotificationView {
  return {
    id: `acme:e${seq}`,
    seq,
    source: "acme",
    name: "domain.active",
    level: "info",
    title: `item ${seq}`,
    timestamp: "2026-09-01T18:42:10.000Z",
    receivedAt: "2026-09-01T18:43:00.000Z",
    data: {},
    ...over,
  };
}
const range = (from: number, to: number) =>
  Array.from({ length: from - to + 1 }, (_, i) => item(from - i));
const seqs = (pages: { items: NotificationView[] }) => pages.items.map((i) => i.seq);
const none = new Set<string>();

describe("mergeFirstPage", () => {
  test("the first read is the first page", () => {
    const pages = mergeFirstPage(EMPTY_PAGES, range(10, 8), true, none);
    expect(seqs(pages)).toEqual([10, 9, 8]);
    expect(pages.hasMore).toBe(true);
  });

  test("a fresh first page that reaches the loaded pages keeps them, and their hasMore", () => {
    const loaded = { items: range(10, 5), hasMore: true };
    const pages = mergeFirstPage(loaded, range(11, 9), true, none);
    expect(seqs(pages)).toEqual([11, 10, 9, 8, 7, 6, 5]);
    expect(pages.hasMore).toBe(true);
  });

  test("a fresh first page past a hole starts paging again from it", () => {
    const loaded = { items: range(10, 5), hasMore: false };
    const pages = mergeFirstPage(loaded, range(20, 18), true, none);
    expect(seqs(pages)).toEqual([20, 19, 18]);
    expect(pages.hasMore).toBe(true);
  });

  test("a first page with nothing beyond it is the whole list", () => {
    const loaded = { items: range(10, 5), hasMore: true };
    const pages = mergeFirstPage(loaded, range(10, 9), false, none);
    expect(seqs(pages)).toEqual([10, 9]);
    expect(pages.hasMore).toBe(false);
  });

  test("held rows stay whatever the read says", () => {
    const loaded = { items: [item(10), item(9)], hasMore: false };
    const pages = mergeFirstPage(loaded, [item(9)], false, new Set(["acme:e10"]));
    expect(seqs(pages)).toEqual([10, 9]);
  });

  test("the fresher copy of a row wins", () => {
    const loaded = { items: [item(10)], hasMore: false };
    const read = item(10, { readAt: "2026-09-01T19:00:00.000Z" });
    const pages = mergeFirstPage(loaded, [read], false, none);
    expect(pages.items[0]?.readAt).toBe(read.readAt);
  });
});

describe("appendOlderPage", () => {
  test("continues the run below its oldest row", () => {
    const loaded = { items: range(10, 8), hasMore: true };
    const pages = appendOlderPage(loaded, 8, range(7, 5), false);
    expect(seqs(pages)).toEqual([10, 9, 8, 7, 6, 5]);
    expect(pages.hasMore).toBe(false);
    expect(oldestSeq(pages)).toBe(5);
  });

  test("is dropped when the run was reset while it was in flight", () => {
    const reset = { items: range(20, 18), hasMore: true };
    expect(appendOlderPage(reset, 8, range(7, 5), false)).toBe(reset);
  });
});
