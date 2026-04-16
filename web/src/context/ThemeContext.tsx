import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

type ThemeMode = "light" | "dark";

/** Server-side preference: "light", "dark", or "system" (follow OS). */
type ThemePreference = "light" | "dark" | "system";

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

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(getInitialMode);

  const setMode = useCallback((next: ThemeMode) => {
    applyMode(next);
    localStorage.setItem(LS_KEY, next);
    setModeState(next);
  }, []);

  const toggle = useCallback(() => {
    setModeState((prev) => {
      const next: ThemeMode = prev === "dark" ? "light" : "dark";
      applyMode(next);
      localStorage.setItem(LS_KEY, next);
      return next;
    });
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
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "L") {
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
