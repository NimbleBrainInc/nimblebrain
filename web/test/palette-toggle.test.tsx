// ---------------------------------------------------------------------------
// PaletteProvider ⌘P toggle — repeated-press behavior + default suppression.
//
// Reproduces the "press ⌘P twice" path: the capture-phase window listener must
// fire AND call preventDefault on BOTH presses (open and close), toggling the
// open state each time. If defaultPrevented is ever false, the browser's print
// dialog leaks through — which is the reported bug.
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";
import { act, render } from "@testing-library/react";
import { PaletteProvider, usePalette } from "../src/context/PaletteContext";

// Capture the latest `open` value out of React via a ref-like sink, avoiding
// testing-library DOM queries (happy-dom's querySelectorAll throws in this
// preload setup).
let latestOpen = false;
function Probe() {
  const { open } = usePalette();
  latestOpen = open;
  return null;
}

function pressCmdP(): KeyboardEvent {
  let ev!: KeyboardEvent;
  act(() => {
    ev = new KeyboardEvent("keydown", {
      key: "p",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(ev);
  });
  return ev;
}

describe("PaletteProvider ⌘P toggle", () => {
  test("toggles open/closed and preventDefaults on each successive press", () => {
    render(
      <PaletteProvider>
        <Probe />
      </PaletteProvider>,
    );

    expect(latestOpen).toBe(false);

    const first = pressCmdP();
    expect(first.defaultPrevented).toBe(true);
    expect(latestOpen).toBe(true);

    const second = pressCmdP();
    expect(second.defaultPrevented).toBe(true);
    expect(latestOpen).toBe(false);

    const third = pressCmdP();
    expect(third.defaultPrevented).toBe(true);
    expect(latestOpen).toBe(true);
  });
});
