// A notice raised for an app names the app, so it never passes for one from
// NimbleBrain itself; one the shell raises carries no such line.

import { afterEach, expect, test } from "bun:test";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { NoticeProvider, NoticeViewport, useNotice } = await import("../components/notices");

let raise: ReturnType<typeof useNotice> = () => {};
function Probe() {
  raise = useNotice();
  return null;
}

let unmount: (() => void) | null = null;
afterEach(async () => {
  await act(async () => unmount?.());
  unmount = null;
});

async function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(
        NoticeProvider,
        null,
        React.createElement(NoticeViewport),
        React.createElement(Probe),
      ),
    );
  });
  unmount = () => {
    root.unmount();
    container.remove();
  };
  return container;
}

const notice = () => document.body.querySelector("[data-testid='notice']");

test("an app's notice says which app sent it", async () => {
  await mount();
  await act(async () => raise({ level: "success", title: "Report exported", source: "CRM" }));
  expect(notice()?.textContent).toContain("From CRM");
  expect(notice()?.textContent).toContain("Report exported");
});

test("the shell's own notice carries no source line", async () => {
  await mount();
  await act(async () => raise({ level: "success", title: "Routes saved" }));
  expect(notice()?.textContent).not.toContain("From ");
});
