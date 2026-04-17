import posthog from "posthog-js";

// Write-only PostHog project API key. Set VITE_POSTHOG_KEY env var to enable.
// If unset, telemetry is silently disabled.
const POSTHOG_KEY = import.meta.env.VITE_POSTHOG_KEY ?? "";

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
