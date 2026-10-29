/**
 * The fetch every call to the installation's model gateway goes through, for a
 * provider configured `gateway: true` (ADR-0057). The runtime holds no key for
 * such a provider: each call carries a model credential minted for it, signed
 * with the run key, naming the run it belongs to.
 *
 * - The subject is the run's (`RequestContext.credentialSubject`), so the
 *   gateway attributes the call and charges the run's budget. Work a run forks
 *   (a conversation's title) runs in the run's context and carries its subject.
 *   A call outside any run gets a single-use subject of its own, so it shares no
 *   budget with anything else.
 * - The credential is minted per call and lives a minute (plus the gateway's
 *   leeway): the gateway checks it when the call starts, so it needs to outlive
 *   only the request, and a long chat never holds one that runs out.
 * - Every header a provider client puts its key in is removed, so the
 *   placeholder key a client was built with never reaches the gateway, which
 *   would read it ahead of the credential.
 */

import { randomUUID } from "node:crypto";
import { getRequestContext } from "./request-context.ts";
import type { RunKey } from "./run-key.ts";

/** How long a per-call credential lasts before the gateway's leeway. */
const CALL_CREDENTIAL_MS = 60_000;

/** The headers provider clients carry a key in. */
const PROVIDER_KEY_HEADERS = ["x-api-key", "x-goog-api-key", "authorization"];

/** The workspace a call outside any workspace names. */
const NO_WORKSPACE = "none";

export function modelGatewayFetch(
  runKey: RunKey,
  base: typeof fetch = globalThis.fetch,
): typeof fetch {
  const gatewayFetch = (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const ctx = getRequestContext();
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    for (const name of PROVIDER_KEY_HEADERS) headers.delete(name);
    const credential = runKey.mintModelCredential({
      runId: ctx?.credentialSubject ?? `call_${randomUUID()}`,
      workspaceId: ctx?.workspaceId ?? NO_WORKSPACE,
      maxRunDurationMs: CALL_CREDENTIAL_MS,
    });
    headers.set("authorization", `Bearer ${credential}`);
    return base(input, { ...init, headers });
  };
  return Object.assign(gatewayFetch, { preconnect: base.preconnect }) as typeof fetch;
}
