import posthog from "posthog-js";
import { getConfig } from "./config";

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
  });

  posthog.register({ installId });
}

export function captureEvent(name: string, properties?: Record<string, unknown>): void {
  if (!initialized) return;
  posthog.capture(name, properties);
}

export function capturePageView(route: string): void {
  if (!initialized) return;
  posthog.capture("web.page_view", { route });
}
