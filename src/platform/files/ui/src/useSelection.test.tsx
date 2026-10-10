/**
 * A selection belongs to the rows it was made on. When `resetKey` names new
 * rows (another folder, query, or page), the very render that shows them must
 * already have an empty selection: a frame with the old selection would paint
 * the bulk-action bar for rows no longer on screen.
 */
import { beforeAll, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act, createElement, useLayoutEffect } from "react";
import type * as ReactDOMClient from "react-dom/client";
import type * as UseSelectionModule from "./useSelection";

type UseSelection = typeof UseSelectionModule.useSelection;
let useSelection: UseSelection;
let createRoot: typeof ReactDOMClient.createRoot;

beforeAll(async () => {
  const { window } = new JSDOM("", { url: "http://localhost" });
  Object.assign(globalThis, {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  ({ useSelection } = await import("./useSelection"));
  ({ createRoot } = await import("react-dom/client"));
});

test("a new resetKey renders with nothing selected", async () => {
  const renders: { key: string; size: number }[] = [];
  let api: ReturnType<UseSelection> | undefined;
  function Probe({ rows, resetKey }: { rows: string[]; resetKey: string }) {
    const selection = useSelection(rows, resetKey);
    api = selection;
    // Committed renders only, before paint: what the user could see.
    useLayoutEffect(() => {
      renders.push({ key: resetKey, size: selection.selected.size });
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(Probe, { rows: ["a", "b"], resetKey: "p0" })));
  await act(async () => api?.toggle("a", false));
  expect(api?.selected.size).toBe(1);

  await act(async () => root.render(createElement(Probe, { rows: ["c", "d"], resetKey: "p1" })));
  root.unmount();

  const onNewRows = renders.filter((r) => r.key === "p1");
  expect(onNewRows.length).toBeGreaterThan(0);
  expect(onNewRows.every((r) => r.size === 0)).toBe(true);
});
