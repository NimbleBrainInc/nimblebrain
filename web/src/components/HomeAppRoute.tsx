import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import type { PlacementEntry } from "../types";
import { AppWithChat } from "./AppWithChat";

/**
 * Home-route wrapper: reads the one-shot `?force=1` query param and relays
 * it to the home app as `forceRefresh`. Lives here — not in `AppWithChat`
 * or `SlotRenderer` — so this query-param code runs only while the home
 * route is mounted. App iframes are `srcdoc` and can't read the host URL
 * themselves, so the shell has to relay it.
 */
export function HomeAppRoute({
  placement,
  onNavigate,
}: {
  placement: PlacementEntry;
  onNavigate: (route: string) => void;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const forceRefreshRef = useRef(searchParams.get("force") === "1");
  // Strip `?force=1` after the first read — it's a one-shot cache-bust, not
  // a persistent mode, so it must not survive a reload or workspace switch.
  useEffect(() => {
    if (!forceRefreshRef.current) return;
    setSearchParams(
      (prev) => {
        prev.delete("force");
        return prev;
      },
      { replace: true },
    );
  }, [setSearchParams]);
  return (
    <AppWithChat
      placement={placement}
      onNavigate={onNavigate}
      forceRefresh={forceRefreshRef.current}
    />
  );
}
