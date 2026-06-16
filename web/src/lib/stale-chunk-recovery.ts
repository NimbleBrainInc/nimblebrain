import { captureEvent } from "../telemetry";

const RELOAD_KEY = "nb:last-chunk-reload";
const RELOAD_DEBOUNCE_MS = 10_000;

/**
 * Decide whether a stale-chunk reload should fire now, recording the attempt
 * when it returns true. A second failure within {@link RELOAD_DEBOUNCE_MS} is
 * suppressed — the guard that prevents a reload loop when the asset is
 * genuinely unreachable (offline, or a deploy still mid-flight with no pod
 * serving assets yet). Pure aside from the storage read/write, so the
 * loop-guard logic is unit-testable without a DOM (see stale-chunk-recovery.test.ts).
 */
export function shouldReloadForStaleChunk(now: number, storage: Storage): boolean {
  const last = Number(storage.getItem(RELOAD_KEY) ?? "0");
  if (now - last < RELOAD_DEBOUNCE_MS) return false;
  storage.setItem(RELOAD_KEY, String(now));
  return true;
}

/**
 * Wire up Vite's stale-chunk recovery. A tab open across a deploy 404s on its
 * next dynamic import (the hashed chunk — e.g. the streamdown/Shiki
 * `highlighted-body` code-block module — was deleted by the new build) and
 * throws "Failed to fetch dynamically imported module", an unhandled rejection
 * that white-screens the app. Vite dispatches `vite:preloadError` for exactly
 * this; reload once to pick up the new index.html + current chunk hashes,
 * guarded against a loop. Call once at startup.
 */
export function registerStaleChunkRecovery(): void {
  window.addEventListener("vite:preloadError", (event) => {
    if (!shouldReloadForStaleChunk(Date.now(), sessionStorage)) return;
    event.preventDefault(); // we're handling it via reload; suppress the throw
    // PostHog persists queued events to storage and flushes on the next load,
    // so this survives the reload. Sizes the deferred asset-retention work
    // (how often tabs actually hit a deploy boundary).
    captureEvent("stale_chunk_reload", { reason: event.payload?.message });
    window.location.reload();
  });
}
