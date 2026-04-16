import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

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

/** Compute initial state synchronously to avoid flash on mobile. */
function getInitialState(): SidebarState {
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
      if ((e.metaKey || e.ctrlKey) && e.key === "b") {
        e.preventDefault();
        toggle();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [toggle]);

  const value = useMemo<SidebarContextValue>(
    () => ({ state, isDrawerOpen, toggle, setDrawerOpen }),
    [state, isDrawerOpen, toggle, setDrawerOpen],
  );

  return <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>;
}

export function useSidebar(): SidebarContextValue {
  const ctx = useContext(SidebarContext);
  if (!ctx) throw new Error("useSidebar must be used within SidebarProvider");
  return ctx;
}
