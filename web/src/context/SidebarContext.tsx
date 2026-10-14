import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation } from "react-router-dom";
import { matchesShortcut, SHORTCUTS } from "../lib/shortcuts";

type SidebarState = "expanded" | "collapsed" | "hidden";

interface SidebarContextValue {
  state: SidebarState;
  isDrawerOpen: boolean;
  toggle: () => void;
  setDrawerOpen: (open: boolean) => void;
}

const SidebarContext = createContext<SidebarContextValue | null>(null);

const LS_KEY = "nb:sidebarState";
const BREAKPOINT_LG = "(min-width: 1024px)";
const BREAKPOINT_MD = "(min-width: 768px)";

function readPreference(): "expanded" | "collapsed" {
  const stored = localStorage.getItem(LS_KEY);
  return stored === "collapsed" ? "collapsed" : "expanded";
}

/**
 * Compute initial state synchronously to avoid flash on mobile. Exported for
 * the app's loading frame, which draws the sidebar at the width it will open at.
 */
export function getInitialState(): SidebarState {
  if (typeof window === "undefined") return "expanded";
  if (window.matchMedia(BREAKPOINT_LG).matches) return readPreference();
  if (window.matchMedia(BREAKPOINT_MD).matches) return "collapsed";
  return "hidden";
}

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<SidebarState>(getInitialState);
  const [isDrawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    const lgMq = window.matchMedia(BREAKPOINT_LG);
    const mdMq = window.matchMedia(BREAKPOINT_MD);

    function update() {
      if (lgMq.matches) {
        setState(readPreference());
        setDrawerOpen(false);
      } else if (mdMq.matches) {
        setState("collapsed");
        setDrawerOpen(false);
      } else {
        setState("hidden");
      }
    }

    update();
    lgMq.addEventListener("change", update);
    mdMq.addEventListener("change", update);
    return () => {
      lgMq.removeEventListener("change", update);
      mdMq.removeEventListener("change", update);
    };
  }, []);

  // Every navigation closes the drawer, whatever caused it: a nav link, the
  // workspace switcher, the bottom tray, the user menu, the palette, browser
  // back. The drawer is modal, so a navigation while it is open is the user
  // choosing where to go, and the destination must not stay covered. Keyed on
  // `location.key`, which changes on every navigation — a tap on the page
  // already open (a same-URL replace) and a search-only change included —
  // and not on the first render.
  const location = useLocation();
  const lastKeyRef = useRef(location.key);
  useEffect(() => {
    if (location.key === lastKeyRef.current) return;
    lastKeyRef.current = location.key;
    setDrawerOpen(false);
  }, [location.key]);

  const toggle = useCallback(() => {
    if (state === "hidden") {
      setDrawerOpen((open) => !open);
    } else {
      const next = state === "expanded" ? "collapsed" : "expanded";
      localStorage.setItem(LS_KEY, next);
      setState(next);
    }
  }, [state]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (matchesShortcut(e, SHORTCUTS.sidebar)) {
        e.preventDefault();
        toggle();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [toggle]);

  const value = useMemo<SidebarContextValue>(
    () => ({ state, isDrawerOpen, toggle, setDrawerOpen }),
    [state, isDrawerOpen, toggle],
  );

  return <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>;
}

export function useSidebar(): SidebarContextValue {
  const ctx = useContext(SidebarContext);
  if (!ctx) throw new Error("useSidebar must be used within SidebarProvider");
  return ctx;
}
