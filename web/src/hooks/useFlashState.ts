import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Brief boolean state that auto-clears after `durationMs`.
 *
 * Replaces the `useState(false)` + `setTimeout(() => setX(false), 1500)`
 * pattern that turned up in three settings call sites (workspace-id copy
 * confirmation, instructions "Saved" flash, etc). Each open-coded copy
 * had two latent bugs:
 *
 *   1. Re-firing the action stacked timers — only the latest one cleared
 *      the flag, but earlier ones still ran setState on the (possibly
 *      newly-flashed) state, racing with subsequent fires.
 *   2. Unmounting within the flash window left an orphan setTimeout that
 *      called setState on an unmounted component (silent in React 19,
 *      but still a leak on the timer side).
 *
 * Both are fixed here once: the previous timer is cleared on every
 * `flash()` call, and the unmount effect clears any pending timer too.
 *
 * Returns a `[active, flash]` tuple: `flash()` sets `active = true` and
 * schedules clear-back-to-false after `durationMs`.
 */
export function useFlashState(durationMs: number): [boolean, () => void] {
  const [active, setActive] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setActive(true);
    timerRef.current = setTimeout(() => {
      setActive(false);
      timerRef.current = null;
    }, durationMs);
  }, [durationMs]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  return [active, flash];
}
