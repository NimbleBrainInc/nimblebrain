// ---------------------------------------------------------------------------
// Keyboard shortcut registry — chord matching and display.
//
// Pins the shell's chords (⌘K search, ⌘J chat, ⇧⌘J full-screen chat, ⌘B
// sidebar) and that Shift is exact: ⇧⌘K is NOT search and ⌘J is NOT full
// screen, so a shifted chord never fires its unshifted sibling. Display is
// ⌘-first glyphs on Apple and Ctrl+ words elsewhere.
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";
import {
  ariaKeyShortcuts,
  matchesShortcut,
  SHORTCUTS,
  shortcutKeys,
  shortcutLabel,
} from "../src/lib/shortcuts";

const press = (key: string, mods: { meta?: boolean; ctrl?: boolean; shift?: boolean } = {}) => ({
  key,
  metaKey: mods.meta ?? false,
  ctrlKey: mods.ctrl ?? false,
  shiftKey: mods.shift ?? false,
});

describe("matchesShortcut", () => {
  test("⌘K and Ctrl+K are search", () => {
    expect(matchesShortcut(press("k", { meta: true }), SHORTCUTS.search)).toBe(true);
    expect(matchesShortcut(press("k", { ctrl: true }), SHORTCUTS.search)).toBe(true);
  });

  test("an uppercase key still matches (caps lock)", () => {
    expect(matchesShortcut(press("K", { meta: true }), SHORTCUTS.search)).toBe(true);
  });

  test("the key alone does not match", () => {
    expect(matchesShortcut(press("k"), SHORTCUTS.search)).toBe(false);
  });

  test("Shift is exact: ⇧⌘K is not search, ⌘J is not full screen", () => {
    expect(matchesShortcut(press("K", { meta: true, shift: true }), SHORTCUTS.search)).toBe(false);
    expect(matchesShortcut(press("j", { meta: true }), SHORTCUTS.chatFullscreen)).toBe(false);
    expect(matchesShortcut(press("J", { meta: true, shift: true }), SHORTCUTS.chatFullscreen)).toBe(
      true,
    );
  });

  test("each chord is distinct", () => {
    expect(matchesShortcut(press("j", { meta: true }), SHORTCUTS.search)).toBe(false);
    expect(matchesShortcut(press("b", { meta: true }), SHORTCUTS.sidebar)).toBe(true);
  });
});

describe("display", () => {
  test("Apple: modifier glyphs, Shift before ⌘", () => {
    expect(shortcutKeys(SHORTCUTS.chatFullscreen, true)).toEqual(["⇧", "⌘", "J"]);
    expect(shortcutLabel(SHORTCUTS.chatFullscreen, true)).toBe("⇧⌘J");
    expect(shortcutLabel(SHORTCUTS.search, true)).toBe("⌘K");
  });

  test("elsewhere: Ctrl words joined by +", () => {
    expect(shortcutKeys(SHORTCUTS.chatFullscreen, false)).toEqual(["Ctrl", "Shift", "J"]);
    expect(shortcutLabel(SHORTCUTS.search, false)).toBe("Ctrl+K");
  });

  test("aria-keyshortcuts names both platform forms", () => {
    expect(ariaKeyShortcuts(SHORTCUTS.search)).toBe("Meta+K Control+K");
    expect(ariaKeyShortcuts(SHORTCUTS.chatFullscreen)).toBe("Meta+Shift+J Control+Shift+J");
  });
});
