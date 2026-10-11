// ---------------------------------------------------------------------------
// ResizeHandle — the chat panel can be resized from the keyboard.
//
// The handle is a focusable separator (the ARIA window splitter): Left widens
// the panel to its right, Right narrows it, within the handle's bounds.
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { ResizeHandle } = await import("../components/ResizeHandle");

async function mount(initialWidth: number, widths: number[]) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(ResizeHandle, {
        initialWidth,
        onWidthChange: (w: number) => widths.push(w),
        min: 280,
        max: 520,
      }),
    );
  });
  const handle = container.getElementsByTagName("hr")[0];
  if (!handle) throw new Error("no separator rendered");
  const press = (key: string) =>
    act(async () => {
      handle.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });
  const unmount = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return { handle, press, unmount };
}

describe("ResizeHandle — keyboard", () => {
  test("is a focusable separator that reports its width", async () => {
    const { handle, unmount } = await mount(300, []);
    expect(handle.getAttribute("tabindex")).toBe("0");
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.getAttribute("aria-valuenow")).toBe("300");
    await unmount();
  });

  test("Left widens and Right narrows, clamped to the bounds", async () => {
    const widths: number[] = [];
    const { press, unmount } = await mount(510, widths);
    await press("ArrowLeft");
    await press("ArrowLeft");
    await press("ArrowRight");
    await press("Enter");
    expect(widths).toEqual([520, 520, 504]);
    await unmount();
  });
});
