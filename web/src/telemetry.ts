import posthog, { type CaptureResult, type PostHogConfig } from "posthog-js";
import { getConfig } from "./config";
import { isHttpUrl, withoutQuery } from "./lib/url-scrub";

// Write-only PostHog project API key, from runtime config (NB_POSTHOG_KEY via
// window.__NB_CONFIG__). Disabled when unset or explicitly turned off
// (NB_POSTHOG_ENABLED=false), mirroring the Sentry enable flag.
const posthogCfg = getConfig().posthog;
const POSTHOG_KEY = posthogCfg?.enabled === false ? "" : (posthogCfg?.key ?? "");

let initialized = false;

/**
 * Everything off except the events this client captures by name. posthog-js
 * takes any feature left unset from the PostHog project's settings, so a
 * project toggle (heatmaps, web vitals, dead clicks, exceptions, surveys)
 * would otherwise start sending data the telemetry docs say is never sent.
 * `advanced_disable_flags` stops the remote-config request altogether.
 * Exported for tests.
 */
export const INIT_OPTIONS = {
  api_host: "https://us.i.posthog.com",
  ip: false,
  autocapture: false,
  capture_pageview: false,
  capture_pageleave: false,
  capture_heatmaps: false,
  capture_performance: false,
  capture_dead_clicks: false,
  capture_exceptions: false,
  disable_scroll_properties: true,
  disable_session_recording: true,
  disable_surveys: true,
  disable_product_tours: true,
  disable_conversations: true,
  disable_web_experiments: true,
  advanced_disable_flags: true,
  persistence: "memory",
  before_send: scrubUrls,
} satisfies Partial<PostHogConfig>;

/**
 * The signed-in person, named only when the deployment identifies
 * (`telemetryIdentify` from `workspace_info`). Absent, events stay anonymous.
 */
export interface TelemetryPerson {
  userId: string;
  email?: string;
  name?: string;
  tenantId?: string;
}

let workspaceId: string | null = null;
let identified = false;

export function initTelemetry(installId?: string, person?: TelemetryPerson): void {
  if (!installId || !POSTHOG_KEY) return;

  if (!initialized) {
    // Flip the guard before posthog.init to prevent concurrent callers
    // (e.g. React StrictMode double-invoking effects) from racing into a
    // second init, which PostHog logs as "already initialized".
    initialized = true;
    posthog.init(POSTHOG_KEY, INIT_OPTIONS);
  }
  posthog.register({ installId });

  if (!person) return;
  // The same id the runtime sends under, so a person's browser and server
  // events are one person.
  identified = true;
  posthog.identify(person.userId, {
    ...(person.email ? { email: person.email } : {}),
    ...(person.name ? { name: person.name } : {}),
  });
  if (person.tenantId) posthog.group("tenant", person.tenantId);
  if (workspaceId) posthog.group("workspace", workspaceId);
}

/**
 * The focused workspace, as the `workspace` group of identified events. Kept
 * even before init, which waits on `workspace_info`.
 */
export function setTelemetryWorkspace(id: string | null): void {
  workspaceId = id;
  if (initialized && identified && id) posthog.group("workspace", id);
}

/** Forget the signed-in person, so the next sign-in starts a new one. */
export function resetTelemetry(): void {
  if (!initialized) return;
  identified = false;
  posthog.reset();
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
