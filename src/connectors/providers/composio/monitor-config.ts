/**
 * The Composio revalidator kill switch. Env-driven, read once at provider
 * construction. Pure + injectable so the policy is unit-testable without
 * spinning up a server. The revalidator's sweep *interval* is a generic knob and
 * lives with the revalidator (`revalidatorIntervalMsFromEnv` in
 * `bundles/connection-revalidator.ts`); only the enable/disable is vendor-specific.
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
