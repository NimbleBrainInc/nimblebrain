/**
 * The fetch every call to the installation's model gateway goes through
 * (ADR-0057). The runtime holds no provider key: each call carries a model
 * credential minted for it, signed with the run key, naming the run it belongs to.
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
 * - The gateway's refusal of a call for a spent run budget is thrown as
 *   `ModelBudgetSpentError` (`src/model/gateway-refusal.ts`), before the
 *   provider client reads it as the provider's own rate limit and retries it.
 */

import { randomUUID } from "node:crypto";
import {
  isGatewayBudgetRefusal,
  ModelBudgetSpentError,
  mayBeGatewayBudgetRefusal,
} from "../model/gateway-refusal.ts";
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
  const gatewayFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
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
    const response = await base(input, { ...init, headers });
    if (
      mayBeGatewayBudgetRefusal(response.status, response.headers.get("content-type")) &&
      isGatewayBudgetRefusal(response.status, await response.clone().text())
    ) {
      await response.body?.cancel();
      throw new ModelBudgetSpentError();
    }
    return response;
  };
  return Object.assign(gatewayFetch, { preconnect: base.preconnect }) as typeof fetch;
}
