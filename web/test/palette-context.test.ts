// ---------------------------------------------------------------------------
// Palette toggle chord predicate.
//
// Pins the ⌘P / Ctrl+P contract (and that ⌘⇧P is NOT it — ⇧ is reserved so the
// chord can't collide with future shifted shortcuts). The listener using this
// runs in capture phase to suppress the browser's print accelerator.
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";
import { isPaletteToggleChord } from "../src/lib/palette-shortcut";

const base = { metaKey: false, ctrlKey: false, shiftKey: false, key: "p" };

describe("isPaletteToggleChord", () => {
  test("⌘P matches", () => {
    expect(isPaletteToggleChord({ ...base, metaKey: true })).toBe(true);
  });

  test("Ctrl+P matches (non-Mac)", () => {
    expect(isPaletteToggleChord({ ...base, ctrlKey: true })).toBe(true);
  });

  test("uppercase P matches (caps lock / shift handling by browser)", () => {
    expect(isPaletteToggleChord({ ...base, metaKey: true, key: "P" })).toBe(true);
  });

  test("⌘⇧P does NOT match", () => {
    expect(isPaletteToggleChord({ ...base, metaKey: true, shiftKey: true })).toBe(false);
  });

  test("plain P does NOT match", () => {
    expect(isPaletteToggleChord(base)).toBe(false);
  });

  test("⌘K does NOT match (reserved for chat)", () => {
    expect(isPaletteToggleChord({ ...base, metaKey: true, key: "k" })).toBe(false);
  });
});
