// ---------------------------------------------------------------------------
// PaletteContext — single source of truth for the command palette's open state.
//
// Owns { open, query } so the sidebar search trigger, the global ⌘P keyboard
// shortcut, and any ">open palette" action all drive the same state. The
// keyboard listener lives here (not in SidebarSearch) so the shortcut works
// even when the sidebar is collapsed or hidden — the palette is global.
//
// Trigger is ⌘P (Ctrl+P elsewhere). ⌘K is taken by the chat panel toggle
// (ChatChrome) and ⌘⇧K by fullscreen chat, so the palette uses ⌘P and
// preventDefaults to suppress the browser's print dialog.
//
// The listener runs in the CAPTURE phase. Cmd+P is a browser accelerator; a
// bubble-phase listener calls preventDefault late enough that the print dialog
// can still slip through (notably while focus is inside the palette's own
// input). Capturing at the window means we cancel the default at the very
// start of event dispatch, before the browser commits the print action — the
// standard way command palettes suppress a native shortcut.
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
      // ⌘P / Ctrl+P toggles the palette. preventDefault (in capture phase, see
      // file header) so the browser's Print dialog never steals the shortcut.
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
