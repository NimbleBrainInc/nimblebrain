import { useEffect, useRef, useState } from "react";
import { getConfig } from "../config";

/** Default poll cadence. */
const DEFAULT_INTERVAL_MS = 90_000;

/**
 * Extract the `release` value from the body Caddy serves at `/config.js`:
 *
 *   window.__NB_CONFIG__ = {"tenantId":"…","release":"abc1234",…};
 *
 * Returns the release string, or `undefined` if it's absent/empty/unparseable.
 * Pure and exported so the parse is unit-testable without a DOM or network.
 */
export function parseReleaseFromConfigJs(body: string): string | undefined {
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const obj = JSON.parse(body.slice(start, end + 1)) as { release?: string };
    return obj.release || undefined;
  } catch {
    return undefined;
  }
}

export interface ReleaseCheckResult {
  /** A newer web build is deployed than the one this tab loaded. */
  updateReady: boolean;
  /** The newer release tag, once detected (else null). */
  latestRelease: string | null;
}

/**
 * Detect when a newer web build has been deployed than the one this tab is
 * running, so the UI can offer a reload (see {@link ReleaseUpdateBanner}).
 *
 * This tab's own version is `getConfig().release` — the value Caddy rendered
 * into `/config.js` (= the deployed web image tag) at the page load that booted
 * this tab. `/config.js` is served `Cache-Control: no-store`, so re-fetching it
 * always reflects the *currently deployed* build. When the two diverge, a newer
 * build is live and a reload will pick it up.
 *
 * Checks on an interval AND whenever the tab regains focus / becomes visible,
 * so a user returning to a long-backgrounded tab learns immediately instead of
 * waiting a full interval. Latches once an update is detected — nothing changes
 * until the user reloads, so there's no reason to keep polling.
 *
 * No-ops when the boot release is absent (local dev / unconfigured): it never
 * polls and never fires.
 */
export function useReleaseCheck(opts?: { intervalMs?: number }): ReleaseCheckResult {
  const intervalMs = opts?.intervalMs ?? DEFAULT_INTERVAL_MS;
  // The release this tab booted with — captured once, never re-read.
  const bootReleaseRef = useRef<string | undefined>(undefined);
  if (bootReleaseRef.current === undefined) {
    bootReleaseRef.current = getConfig().release;
  }
  const [latestRelease, setLatestRelease] = useState<string | null>(null);

  useEffect(() => {
    const boot = bootReleaseRef.current;
    // Nothing to compare against (dev / unconfigured) — never poll.
    if (!boot) return;

    let destroyed = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    const stop = () => {
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", check);
    };

    const check = async () => {
      if (destroyed) return;
      try {
        const res = await fetch("/config.js", { cache: "no-store" });
        if (!res.ok) return;
        const deployed = parseReleaseFromConfigJs(await res.text());
        if (destroyed || !deployed || deployed === boot) return;
        setLatestRelease(deployed);
        stop(); // latch — the banner stays until the user reloads
      } catch {
        // Transient network/offline — ignore; the next tick retries.
      }
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };

    timer = setInterval(check, intervalMs);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", check);

    return () => {
      destroyed = true;
      stop();
    };
  }, [intervalMs]);

  return { updateReady: latestRelease !== null, latestRelease };
}
