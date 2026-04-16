import posthog from "posthog-js";

// Write-only PostHog project API key. Set VITE_POSTHOG_KEY env var to enable.
// If unset, telemetry is silently disabled.
const POSTHOG_KEY = import.meta.env.VITE_POSTHOG_KEY ?? "";

let initialized = false;

export function initTelemetry(installId?: string): void {
  if (!installId || !POSTHOG_KEY) return;

  posthog.init(POSTHOG_KEY, {
    api_host: "https://us.i.posthog.com",
    ip: false,
    autocapture: false,
    capture_pageview: false,
    disable_session_recording: true,
    persistence: "memory",
  });

  posthog.register({ installId });
  initialized = true;
}

export function captureEvent(name: string, properties?: Record<string, unknown>): void {
  if (!initialized) return;
  posthog.capture(name, properties);
}

export function capturePageView(route: string): void {
  if (!initialized) return;
  posthog.capture("web.page_view", { route });
}
