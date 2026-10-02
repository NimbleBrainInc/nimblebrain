// ---------------------------------------------------------------------------
// Palette keyboard shortcut predicate (pure).
//
// Lives in lib (not the context module) so PaletteContext exports only its
// provider + hook — keeping React Fast Refresh happy — while the chord logic
// stays unit-testable on its own.
// ---------------------------------------------------------------------------

/** True for the ⌘K / Ctrl+K toggle chord (and not ⌘⇧K, which stays reserved). */
export function isPaletteToggleChord(e: {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  key: string;
}): boolean {
  const mod = e.metaKey || e.ctrlKey;
  return mod && !e.shiftKey && (e.key === "k" || e.key === "K");
}
