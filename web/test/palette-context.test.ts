// ---------------------------------------------------------------------------
// Palette toggle chord predicate.
//
// Pins the ⌘K / Ctrl+K contract (and that ⌘⇧K is NOT it — ⇧ is reserved so the
// chord can't collide with future shifted shortcuts). The listener using this
// runs in capture phase to suppress the browser's own Ctrl+K binding.
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";
import { isPaletteToggleChord } from "../src/lib/palette-shortcut";

const base = { metaKey: false, ctrlKey: false, shiftKey: false, key: "k" };

describe("isPaletteToggleChord", () => {
  test("⌘K matches", () => {
    expect(isPaletteToggleChord({ ...base, metaKey: true })).toBe(true);
  });

  test("Ctrl+K matches (non-Mac)", () => {
    expect(isPaletteToggleChord({ ...base, ctrlKey: true })).toBe(true);
  });

  test("uppercase K matches (caps lock / shift handling by browser)", () => {
    expect(isPaletteToggleChord({ ...base, metaKey: true, key: "K" })).toBe(true);
  });

  test("⌘⇧K does NOT match", () => {
    expect(isPaletteToggleChord({ ...base, metaKey: true, shiftKey: true })).toBe(false);
  });

  test("plain K does NOT match", () => {
    expect(isPaletteToggleChord(base)).toBe(false);
  });

  test("⌘J does NOT match (chat)", () => {
    expect(isPaletteToggleChord({ ...base, metaKey: true, key: "j" })).toBe(false);
  });
});
