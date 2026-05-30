// ---------------------------------------------------------------------------
// Palette keyboard shortcut predicate (pure).
//
// Lives in lib (not the context module) so PaletteContext exports only its
// provider + hook — keeping React Fast Refresh happy — while the chord logic
// stays unit-testable on its own.
// ---------------------------------------------------------------------------

/** True for the ⌘P / Ctrl+P toggle chord (and not ⌘⇧P, which stays reserved). */
export function isPaletteToggleChord(e: {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  key: string;
}): boolean {
  const mod = e.metaKey || e.ctrlKey;
  return mod && !e.shiftKey && (e.key === "p" || e.key === "P");
}
