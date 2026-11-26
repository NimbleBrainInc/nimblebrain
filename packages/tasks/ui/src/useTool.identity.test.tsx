/**
 * The panel's effects list `useTool`'s result (or its `call`) as a dependency.
 * That is only safe while both keep their identity across renders: a fresh
 * object per render would re-run every such effect on every render, and an
 * effect that sets state would loop.
 */
import { beforeAll, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act, createElement, useState } from "react";
import type * as ReactDOMClient from "react-dom/client";
import type * as UseToolModule from "./useTool.ts";

type UseTool = typeof UseToolModule.useTool;
let useTool: UseTool;
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
  // `useCallTool` needs a connected host; its `call` is a `useCallback` over
  // the app and tool name, so a constant stands in for it here.
  const real = await import("@nimblebrain/synapse/react");
  const call = async () => ({ data: null, isError: false, content: [] });
  mock.module("@nimblebrain/synapse/react", () => ({
    ...real,
    useCallTool: () => ({ call, isPending: false, error: null, data: null }),
  }));
  ({ useTool } = await import("./useTool.ts"));
  ({ createRoot } = await import("react-dom/client"));
});

test("useTool keeps its result and `call` across re-renders", async () => {
  const seen: ReturnType<UseTool>[] = [];
  let rerender: () => void = () => {};
  function Probe() {
    const [, setN] = useState(0);
    rerender = () => setN((n) => n + 1);
    seen.push(useTool("status"));
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(Probe)));
  await act(async () => rerender());
  await act(async () => rerender());
  root.unmount();

  expect(seen.length).toBe(3);
  expect(seen[1]).toBe(seen[0]);
  expect(seen[2]).toBe(seen[0]);
  expect(seen[2]?.call).toBe(seen[0]?.call);
});
