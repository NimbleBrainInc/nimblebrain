import posthog, { type CaptureResult } from "posthog-js";
import { getConfig } from "./config";
import { isHttpUrl, withoutQuery } from "./lib/url-scrub";

// Write-only PostHog project API key, from runtime config (NB_POSTHOG_KEY via
// window.__NB_CONFIG__). Disabled when unset or explicitly turned off
// (NB_POSTHOG_ENABLED=false), mirroring the Sentry enable flag.
const posthogCfg = getConfig().posthog;
const POSTHOG_KEY = posthogCfg?.enabled === false ? "" : (posthogCfg?.key ?? "");

let initialized = false;

export function initTelemetry(installId?: string): void {
  if (initialized || !installId || !POSTHOG_KEY) return;

  // Flip the guard before posthog.init to prevent concurrent callers
  // (e.g. React StrictMode double-invoking effects) from racing into a
  // second init, which PostHog logs as "already initialized".
  initialized = true;

  posthog.init(POSTHOG_KEY, {
    api_host: "https://us.i.posthog.com",
    ip: false,
    autocapture: false,
    capture_pageview: false,
    disable_session_recording: true,
    persistence: "memory",
    before_send: scrubUrls,
  });

  posthog.register({ installId });
}

export function captureEvent(name: string, properties?: Record<string, unknown>): void {
  if (!initialized) return;
  posthog.capture(name, properties);
}

/**
 * Strip the query and fragment from every URL-valued property before an event leaves
 * the browser: `$current_url`, `$referrer`, the `$initial_*` pair PostHog sets once,
 * and any other. The shell's URL can name what the person is looking at (`?chat=`, an
 * app's record), and none of that is product analytics. Exported for tests.
 */
export function scrubUrls(event: CaptureResult | null): CaptureResult | null {
  if (!event) return event;
  for (const bag of [event.properties, event.$set, event.$set_once]) {
    if (!bag) continue;
    for (const [key, value] of Object.entries(bag)) {
      if (isHttpUrl(value)) bag[key] = withoutQuery(value);
    }
  }
  return event;
}
