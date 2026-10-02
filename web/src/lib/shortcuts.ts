// ---------------------------------------------------------------------------
// Keyboard shortcuts — the one definition of each shell chord.
//
// Every place a shortcut appears reads it from here: the listener that acts on
// it (`matchesShortcut`), the tooltip and hint that show it (`shortcutLabel`,
// `shortcutKeys`), and the trigger's `aria-keyshortcuts`. So a rebinding is a
// one-line change, and a label can never name a chord the handler ignores.
//
// Every chord is the platform modifier (⌘ on Apple, Ctrl elsewhere) plus a key,
// optionally with Shift. Pure: no React, no DOM beyond reading the platform.
// ---------------------------------------------------------------------------

export interface Shortcut {
  /** The key, lowercase, as `KeyboardEvent.key` reports it without Shift. */
  key: string;
  shift?: boolean;
}

export const SHORTCUTS = {
  /** The command palette. */
  search: { key: "k" },
  /** Open or close the chat panel. */
  chat: { key: "j" },
  /** Expand or collapse the chat panel to full screen. */
  chatFullscreen: { key: "j", shift: true },
  /** Open or close the sidebar. */
  sidebar: { key: "b" },
} as const satisfies Record<string, Shortcut>;

/** True when the event is this chord: the platform modifier, Shift as declared, and the key. */
export function matchesShortcut(
  e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; key: string },
  shortcut: Shortcut,
): boolean {
  return (
    (e.metaKey || e.ctrlKey) &&
    e.shiftKey === Boolean(shortcut.shift) &&
    e.key.toLowerCase() === shortcut.key
  );
}

/** True on macOS and iOS, where the modifier is ⌘. */
export function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return true;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** The chord as separate keys, for keycap rows: `["⇧", "⌘", "J"]` or `["Ctrl", "Shift", "J"]`. */
export function shortcutKeys(shortcut: Shortcut, apple = isApplePlatform()): string[] {
  const key = shortcut.key.toUpperCase();
  if (apple) return [...(shortcut.shift ? ["⇧"] : []), "⌘", key];
  return ["Ctrl", ...(shortcut.shift ? ["Shift"] : []), key];
}

/** The chord as one label, for a tooltip chip or an inline hint: `⇧⌘J` or `Ctrl+Shift+J`. */
export function shortcutLabel(shortcut: Shortcut, apple = isApplePlatform()): string {
  return shortcutKeys(shortcut, apple).join(apple ? "" : "+");
}

/** The `aria-keyshortcuts` value, naming both platform forms. */
export function ariaKeyShortcuts(shortcut: Shortcut): string {
  const key = shortcut.key.toUpperCase();
  const shift = shortcut.shift ? "+Shift" : "";
  return `Meta${shift}+${key} Control${shift}+${key}`;
}
