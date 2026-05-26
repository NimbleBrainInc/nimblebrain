import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { cn } from "../lib/utils";

/**
 * Thin top progress bar that flashes on every route change — the SPA
 * "something's happening" cue.
 *
 * Data on these routes is fast (single-digit ms), so this is intentionally a
 * fixed, short pseudo-progress (fill → complete → fade), NOT bound to a
 * specific request. Its job is to confirm the navigation registered, so a
 * fast-but-silent content swap never reads as a hang. Slower per-surface waits
 * (the briefing) have their own skeletons.
 */
export function NavProgress() {
  const { pathname } = useLocation();
  const [phase, setPhase] = useState<"idle" | "fill" | "complete">("idle");

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on pathname — each navigation restarts the bar
  useEffect(() => {
    setPhase("fill");
    const toComplete = setTimeout(() => setPhase("complete"), 280);
    const toIdle = setTimeout(() => setPhase("idle"), 600);
    return () => {
      clearTimeout(toComplete);
      clearTimeout(toIdle);
    };
  }, [pathname]);

  if (phase === "idle") return null;

  return (
    <div className="fixed inset-x-0 top-0 z-50 h-0.5 pointer-events-none" aria-hidden="true">
      <div
        className={cn(
          "h-full bg-primary ease-out",
          phase === "fill"
            ? "w-3/4 transition-[width] duration-300"
            : "w-full opacity-0 transition-all duration-300",
        )}
      />
    </div>
  );
}
