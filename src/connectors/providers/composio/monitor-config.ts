/**
 * Operator config for the Composio connection monitor (the `ConnectionRevalidator`
 * Composio probe). Env-driven, read once at server start. Pure + injectable so
 * the wiring in `src/api/server.ts` stays trivial and the policy is unit-testable
 * without spinning up `startServer()`.
 */

type Env = Record<string, string | undefined>;

/**
 * The Composio probe runs iff Composio is configured AND the operator hasn't
 * thrown the kill switch. Default ON when configured — `COMPOSIO_MONITOR_ENABLED`
 * must be an explicit `false` (case/whitespace-insensitive) to disable, so an
 * unset or malformed value keeps detection on.
 */
export function composioMonitorEnabled(configured: boolean, env: Env = process.env): boolean {
  if (!configured) return false;
  return (env.COMPOSIO_MONITOR_ENABLED ?? "true").trim().toLowerCase() !== "false";
}

/**
 * Parse `COMPOSIO_MONITOR_INTERVAL_SECONDS` → milliseconds, or `undefined` to let
 * the revalidator use its default. Anything non-positive / unparseable falls back
 * to the default rather than producing a 0ms (hot-loop) or negative interval.
 */
export function revalidatorIntervalMsFromEnv(env: Env = process.env): number | undefined {
  const seconds = Number.parseInt((env.COMPOSIO_MONITOR_INTERVAL_SECONDS ?? "").trim(), 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}
