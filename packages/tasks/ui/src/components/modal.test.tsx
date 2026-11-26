/**
 * A click outside the panel closes the dialog; a click inside it does not.
 * The outside is a backdrop button behind the panel, so a press inside the
 * panel never reaches it.
 */
import { beforeAll, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import type * as ReactDOMClient from "react-dom/client";
import type * as ModalModule from "./Modal.tsx";

let Modal: typeof ModalModule.Modal;
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
  ({ Modal } = await import("./Modal.tsx"));
  ({ createRoot } = await import("react-dom/client"));
});

test("the backdrop closes the dialog and the panel does not", async () => {
  let closed = 0;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <Modal title="Run task" onClose={() => closed++}>
        <p id="body">Input</p>
      </Modal>,
    ),
  );

  await act(async () => document.getElementById("body")?.click());
  expect(closed).toBe(0);

  const backdrop = Array.from(container.getElementsByTagName("button")).find(
    (b) => b.getAttribute("aria-label") === "Close dialog",
  );
  expect(backdrop?.tabIndex).toBe(-1);
  await act(async () => backdrop?.click());
  expect(closed).toBe(1);

  await act(async () => root.unmount());
  container.remove();
});
