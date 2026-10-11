// ---------------------------------------------------------------------------
// FileAttachmentChips — removing one chip leaves the others mounted.
//
// A chip owns its image preview (an object URL made on mount, revoked on
// unmount), so a chip keyed by position would remount, and rebuild its
// preview, whenever a file before it is removed. Chips are keyed per file.
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { FileAttachmentChips } = await import("../components/FileAttachmentChips");

function chips(root: Element): Element[] {
  const wrapper = root.firstElementChild;
  return wrapper ? Array.from(wrapper.children) : [];
}

describe("FileAttachmentChips", () => {
  test("removing a file keeps the remaining chips' elements", async () => {
    const a = new File(["a"], "notes.txt", { type: "text/plain" });
    const b = new File(["bb"], "notes.txt", { type: "text/plain" });
    const c = new File(["ccc"], "plan.md", { type: "text/markdown" });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = ReactDOMClient.createRoot(container);
    const render = (files: File[]) =>
      act(async () => {
        root.render(React.createElement(FileAttachmentChips, { files, onRemove: () => {} }));
      });

    await render([a, b, c]);
    const [, chipB, chipC] = chips(container);
    await render([b, c]);
    const after = chips(container);

    expect(after.length).toBe(2);
    expect(after[0]).toBe(chipB);
    expect(after[1]).toBe(chipC);

    await act(async () => root.unmount());
    container.remove();
  });
});
