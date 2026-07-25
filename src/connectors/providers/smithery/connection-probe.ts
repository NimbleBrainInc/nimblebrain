/**
 * Smithery's `ConnectionHealthProbe` — the second implementation of the kernel's
 * provider-agnostic liveness seam.
 *
 * Smithery holds the upstream credential, so the platform→Smithery hop can stay
 * healthy while the *downstream* authorization it brokers lapses. The only
 * signal is to ask the broker out of band, which is exactly what this does:
 * read the connection and map its `status.state` to a kernel verdict.
 *
 * Anti-flap discipline (the kernel counts `credential_lost` toward a flip, so a
 * false positive de-authorizes a working connector): a 404 — the connection is
 * gone at the broker — is the ONLY `credential_lost` verdict. Everything else is
 * `indeterminate`, including the two states that definitively require a human
 * (`auth_required` / `input_required`): their remedy is Smithery's hosted setup
 * page, a `ConnectionLiveness` verdict has no channel to carry a URL, and
 * flipping without one strands the user — see the note at the mapping below. A
 * generic `error` is `indeterminate` too; Smithery reports transient upstream
 * failures there. Never throws.
 */

import type {
  ConnectionHealthProbe,
  ConnectionLiveness,
  ProbeTarget,
} from "../../../bundles/connection-probe.ts";
import { log } from "../../../observability/log.ts";
import type { SmitheryClientOptions } from "./client.ts";

/**
 * Read the Smithery marker a smithery-auth install persists on its BundleRef.
 *
 * Host and namespace come from the REF, never from current config: the ref's
 * session URL bakes both in at install and keeps working if an operator later
 * repoints them, so a config-reading probe would 404 a perfectly healthy
 * connection and false-flip it. Every coordinate is required on the type and
 * the install refuses to persist without them, so there is no partially-written
 * shape to defend against.
 */
function markerFrom(
  target: ProbeTarget,
): { connectionId: string; namespace: string; baseUrl: string } | undefined {
  const ref = target.ref;
  if (!("smithery" in ref) || !ref.smithery?.connectionId) return undefined;
  return {
    connectionId: ref.smithery.connectionId,
    namespace: ref.smithery.namespace,
    baseUrl: ref.smithery.baseUrl,
  };
}

export class SmitheryConnectionProbe implements ConnectionHealthProbe {
  readonly providerId = "smithery";

  constructor(private readonly options: SmitheryClientOptions) {}

  async probe(target: ProbeTarget, signal: AbortSignal): Promise<ConnectionLiveness> {
    const marker = markerFrom(target);
    if (!marker) return "indeterminate";

    try {
      // Lazy: the probe is constructed at startup for every registered
      // provider, but the client module loads only when a sweep actually runs.
      const { getSmitheryConnection } = await import("./client.ts");
      const connection = await getSmitheryConnection(
        { ...this.options, namespace: marker.namespace, baseUrl: marker.baseUrl },
        marker.connectionId,
        signal,
      );

      // 404 — the connection no longer exists at the broker, so the credential
      // it held is definitively gone.
      if (!connection) return "credential_lost";

      const state = connection.status?.state;
      if (state === "auth_required" || state === "input_required") {
        // Semantically this IS a lost credential — but reporting it as one flips
        // the connector to `reauth_required`, and Smithery has no reconnect the
        // product can offer: the remedy is its hosted setup page, and
        // `ConnectionLiveness` has no channel to carry a URL. The user would get
        // a Reconnect button that headlessly restarts the still-valid static
        // header, reads `running`, and flips back on the next sweep — a loop
        // that looks like a broken product rather than a connector needing
        // attention. `indeterminate` is the codebase's fail-safe for "cannot
        // act", so log the remedy and change nothing. This becomes
        // `credential_lost` the moment a verdict can carry the setup URL through
        // to the connector's `statusReason`.
        log.warn(
          `[smithery-probe] ${target.serverName} in ${target.wsId} reports ${state}` +
            `${connection.status?.setupUrl ? ` — complete setup at ${connection.status.setupUrl}` : ""}`,
        );
        return "indeterminate";
      }
      if (state === "connected" || state === "disconnected") return "live";

      // `error`, or a state this runtime doesn't know: can't tell.
      return "indeterminate";
    } catch (err) {
      log.debug(
        "mcp",
        `[smithery-probe] ${target.serverName} in ${target.wsId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return "indeterminate";
    }
  }
}
