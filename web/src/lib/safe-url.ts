/**
 * Display a URL's hostname for the eye, falling back to the raw string
 * if parsing fails. Matches the catalog loader's safety posture: the
 * server-side validator rejects bad URLs at load, but a defensive UI
 * never crashes on display when something gets through (e.g. an
 * operator hand-edited the catalog file at runtime, or a future
 * registry returns a malformed entry).
 */
export function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
