// The query and fragment of a URL the shell reports to telemetry.
//
// The shell's URL can carry what the person is looking at: `?chat=` names a
// conversation, and an app route can name the record it shows. Telemetry keeps the
// path (its ids are opaque and inside the trust boundary) and drops everything after
// it. Pure, so the Sentry and PostHog hooks and their tests share one rule.

/** `url` without its query string or fragment. A value with neither is returned unchanged. */
export function withoutQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut >= 0 ? url.slice(0, cut) : url;
}

/** Whether `value` is an absolute http(s) URL, the only kind a telemetry property reports. */
export function isHttpUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}
