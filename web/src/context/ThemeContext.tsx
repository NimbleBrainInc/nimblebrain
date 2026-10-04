import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { matchesShortcut, SHORTCUTS } from "../lib/shortcuts";

type ThemeMode = "light" | "dark";

/** Server-side preference: "light", "dark", or "system" (follow OS). */
export type ThemePreference = "light" | "dark" | "system";

interface ThemeContextValue {
  mode: ThemeMode;
  toggle: () => void;
  setMode: (mode: ThemeMode) => void;
  /** Apply a server-side theme preference (light/dark/system). */
  applyPreference: (pref: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const LS_KEY = "nb-theme";

/** Apply or remove the .dark class on <html>. */
function applyMode(mode: ThemeMode) {
  if (mode === "dark") {
    document.documentElement.classList.add("dark");
  } else {
    document.documentElement.classList.remove("dark");
  }
}

/** Resolve a preference ("light" | "dark" | "system") to an actual mode. */
function resolvePreference(pref: ThemePreference): ThemeMode {
  if (pref === "light" || pref === "dark") return pref;
  // "system" — follow OS
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Resolve initial theme synchronously to prevent FOUC. */
function getInitialMode(): ThemeMode {
  if (typeof window === "undefined") return "light";

  const stored = localStorage.getItem(LS_KEY);
  if (stored === "dark" || stored === "light" || stored === "system") {
    const mode = resolvePreference(stored as ThemePreference);
    applyMode(mode);
    return mode;
  }

  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const mode: ThemeMode = prefersDark ? "dark" : "light";
  applyMode(mode);
  return mode;
}

export function ThemeProvider({
  children,
  savePreference,
}: {
  children: React.ReactNode;
  /**
   * Stores a theme the person chose outside Settings (the palette, the
   * shortcut) as their server preference. Without it a toggle lasts only until
   * the shell applies the stored preference again.
   */
  savePreference?: (pref: ThemePreference) => Promise<void>;
}) {
  const [mode, setModeState] = useState<ThemeMode>(getInitialMode);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const saveRef = useRef(savePreference);
  saveRef.current = savePreference;
  // Saves run one at a time so quick toggles reach the server in order.
  const saveQueue = useRef<Promise<void>>(Promise.resolve());

  const setMode = useCallback((next: ThemeMode) => {
    applyMode(next);
    localStorage.setItem(LS_KEY, next);
    setModeState(next);
  }, []);

  const toggle = useCallback(() => {
    const next: ThemeMode = modeRef.current === "dark" ? "light" : "dark";
    modeRef.current = next;
    applyMode(next);
    localStorage.setItem(LS_KEY, next);
    setModeState(next);
    const save = saveRef.current;
    if (!save) return;
    // The theme has already changed here; a failed save only means the next
    // load applies the stored preference instead.
    saveQueue.current = saveQueue.current
      .then(() => save(next))
      .catch((err) => console.warn("[theme] preference not saved", err));
  }, []);

  /** Apply a server-side preference. Stores the raw preference so "system" is preserved. */
  const applyPreference = useCallback((pref: ThemePreference) => {
    const resolved = resolvePreference(pref);
    applyMode(resolved);
    // Store the raw preference so OS-following works on reload
    localStorage.setItem(LS_KEY, pref);
    setModeState(resolved);
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");

    function handleChange(e: MediaQueryListEvent) {
      // Follow OS preference when set to "system" or no explicit choice
      const stored = localStorage.getItem(LS_KEY);
      if (!stored || stored === "system") {
        const next: ThemeMode = e.matches ? "dark" : "light";
        applyMode(next);
        setModeState(next);
      }
    }

    mq.addEventListener("change", handleChange);
    return () => mq.removeEventListener("change", handleChange);
  }, []);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (matchesShortcut(e, SHORTCUTS.theme)) {
        e.preventDefault();
        toggle();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [toggle]);

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, toggle, setMode, applyPreference }),
    [mode, toggle, setMode, applyPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}

/**
 * Theme mode with a safe default. Unlike `useTheme`, this never throws when
 * rendered outside a `ThemeProvider` — it falls back to "light". For leaf UI
 * (e.g. `ConnectorIcon`) that only needs to pick a light/dark asset and may be
 * rendered in isolation (unit tests, embeds), a missing provider should
 * degrade to the light variant, not crash the subtree.
 */
export function useThemeMode(): ThemeMode {
  return useContext(ThemeContext)?.mode ?? "light";
}
