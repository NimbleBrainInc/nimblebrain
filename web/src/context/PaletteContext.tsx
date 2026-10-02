// ---------------------------------------------------------------------------
// PaletteContext — single source of truth for the command palette's open state.
//
// Owns { open, query } so the sidebar search button, the global ⌘K keyboard
// shortcut, and any ">open palette" action all drive the same state. The
// keyboard listener lives here (not in the sidebar) so the shortcut works
// even when the sidebar is collapsed or hidden — the palette is global.
//
// Trigger is ⌘K (Ctrl+K elsewhere), the command-palette convention. Chat
// takes ⌘J (ChatChrome).
//
// The listener runs in the CAPTURE phase. Ctrl+K is a browser accelerator
// (it focuses the search bar in Firefox and Chrome on Windows/Linux); a
// bubble-phase listener calls preventDefault late enough that the browser can
// still act (notably while focus is inside the palette's own input).
// Capturing at the window cancels the default at the very start of event
// dispatch — the standard way command palettes suppress a native shortcut.
// ---------------------------------------------------------------------------

import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { isPaletteToggleChord } from "../lib/palette-shortcut";

export interface PaletteContextValue {
  open: boolean;
  query: string;
  /** Open the palette, optionally seeding the query (e.g. with a prefix). */
  openPalette: (initialQuery?: string) => void;
  closePalette: () => void;
  setQuery: (query: string) => void;
}

const PaletteContext = createContext<PaletteContextValue | null>(null);

export function PaletteProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const openPalette = useCallback((initialQuery?: string) => {
    setQuery(initialQuery ?? "");
    setOpen(true);
  }, []);

  const closePalette = useCallback(() => {
    setOpen(false);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // ⌘K / Ctrl+K toggles the palette. preventDefault (in capture phase, see
      // file header) so the browser's own binding never steals the shortcut.
      if (isPaletteToggleChord(e)) {
        e.preventDefault();
        e.stopPropagation();
        setOpen((prev) => {
          if (!prev) setQuery("");
          return !prev;
        });
      }
    }
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  const value = useMemo<PaletteContextValue>(
    () => ({ open, query, openPalette, closePalette, setQuery }),
    [open, query, openPalette, closePalette],
  );

  return <PaletteContext.Provider value={value}>{children}</PaletteContext.Provider>;
}

export function usePalette(): PaletteContextValue {
  const ctx = useContext(PaletteContext);
  if (!ctx) throw new Error("usePalette must be used within a PaletteProvider");
  return ctx;
}
