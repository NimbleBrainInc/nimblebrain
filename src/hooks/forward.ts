import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { RemoteTransportConfig } from "../bundles/types.ts";
import { isMintedFleetSource } from "../oauth/minted-credential-provider.ts";
import { injectTraceparent } from "../observability/index.ts";
import { resolveTransportCredential } from "../tools/remote-transport.ts";
import { createSsrfGuardedFetch } from "../tools/ssrf-guarded-fetch.ts";
import { resolveForwardUrl, STRIPPED_REQUEST_HEADERS } from "./declaration.ts";

/**
 * The forward hop: the same call the runtime already makes to a connector, with
 * a vendor's bytes in the body.
 *
 * Nothing here is webhook-specific except which headers survive. The target is
 * a route on the connector's own server, the credential is the connector's own
 * credential (`resolveTransportCredential` — one owner for "how does this
 * connection authenticate", shared with the MCP transport), and the redirect
 * guard is the connector's own SSRF posture. There is no new mint path, no new
 * audience, and no new key owner: the delivery reaches the bundle exactly as a
 * tool call does, and the bundle reads identity from the edge-injected headers
 * exactly as it does for a tool call.
 *
 * The runtime does not read the body. It does not parse it, size-check it
 * beyond the transport cap, log it, or store it. If a future change here starts
 * looking at a field, the split this door exists to maintain has failed and the
 * logic belongs in the receiving server's adapter.
 */

/** Header carrying the key id the delivery's token was minted under.
 *
 *  Informational, and the receiving server must treat it that way: it names
 *  which minted URL was used, for log correlation and a raw-capture column.
 *  Nothing selects on it, because the vendor is the ROUTE the runtime forwards
 *  to, not a header — a header the caller could reach would be a second,
 *  weaker identity channel beside the one the edge injects. It is on this
 *  runtime's own strip list for the same reason, and must be on the fleet
 *  edge's, or a caller holding a valid fleet token could set it directly. */
export const HOOK_KID_HEADER = "x-nb-hook-kid";

export interface ForwardOptions {
  /** The connector's base URL, from its installed ref. */
  baseUrl: string;
  /** The connector's transport config, for credential + SSRF posture. */
  transport: RemoteTransportConfig | undefined;
  /** Absolute path on the connector, from the registration record. */
  route: string;
  /** Workspace the delivery belongs to — the dimension the credential is scoped to. */
  workspaceId: string;
  /** Key id from the opened token. */
  kid: string;
  /** Inbound request headers, as received. */
  inboundHeaders: Headers;
  /** Header renames declared for this stream, `{from: to}`, both lowercase. */
  headerRenames?: Record<string, string>;
  /** Verbatim body bytes. */
  body: Uint8Array;
  /** Dev-mode `allowInsecureRemotes`, threaded to the redirect guard so a local
   *  `http://localhost` connector still works under `bun run dev`. */
  allowInsecure?: boolean;
  /** Injectable for tests. */
  fetchImpl?: FetchLike;
}

export class HookForwardUnauthenticatedError extends Error {
  constructor(baseUrl: string) {
    super(
      `[hooks] connector at ${baseUrl} authenticates interactively (OAuth); a delivery ` +
        `cannot be forwarded with a user-bound credential`,
    );
    this.name = "HookForwardUnauthenticatedError";
  }
}

/**
 * Build the header set the forward carries.
 *
 * Pass-through is the default and the strip list is the exception, which is the
 * right way round: a vendor signs headers the runtime cannot enumerate
 * (`Stripe-Signature`, `X-Vendor-Signature`, whatever the next vendor invents),
 * and those have to reach the server's verifier or origin verification is
 * impossible by construction. Inverting this to an allowlist would silently
 * break every signing vendor we have not heard of yet.
 *
 * The exception is the identity class — the headers a caller could use to
 * assert who they are. Those are dropped before anything else happens, and the
 * only identity on the forwarded request is what the edge injects after
 * verifying the token this runtime just minted.
 *
 * A declared rename runs AFTER the strip, which is the point of the feature: a
 * vendor that authenticates on `Authorization` cannot otherwise reach its own
 * verifier, and no replay can restore a header that never arrived. The rename
 * target is validated at declaration time to be outside the stripped class, so
 * a rename can move a value out of the identity namespace but never into it.
 */
export function buildForwardHeaders(opts: {
  inbound: Headers;
  kid: string;
  renames?: Record<string, string>;
  credentialHeaders: Record<string, string>;
}): Headers {
  const headers = new Headers();
  for (const [name, value] of opts.inbound) {
    const lower = name.toLowerCase();
    const renamed = opts.renames?.[lower];
    if (renamed) {
      headers.set(renamed, value);
      continue;
    }
    if (STRIPPED_REQUEST_HEADERS.has(lower)) continue;
    headers.set(name, value);
  }
  // The connection's own credential, applied after the inbound headers so a
  // caller cannot displace it by sending a header of the same name.
  for (const [name, value] of Object.entries(opts.credentialHeaders)) {
    headers.set(name, value);
  }
  headers.set(HOOK_KID_HEADER, opts.kid);
  return headers;
}

/**
 * Forward one delivery. Single attempt, no retry, no queue, no persistence.
 *
 * Durability belongs to the two parties that can actually provide it: the
 * vendor, which retries on a 5xx for its own retry window, and the receiving
 * bundle, whose raw capture and reconcile poll are the designed backstop. A
 * retry here would duplicate the vendor's and buffer a delivery in the one
 * process that must not become the reason the runtime is busy.
 */
export async function forwardDelivery(opts: ForwardOptions): Promise<Response> {
  const target = resolveForwardUrl(opts.baseUrl, opts.route);
  const credential = resolveTransportCredential(opts.transport, opts.workspaceId);
  // No static headers and no minting fetch means this connection has no
  // credential a non-MCP caller can present: it authenticates interactively,
  // and that credential lives inside the SDK transport and is user-bound. Refuse
  // rather than send an unauthenticated request — a vendor delivery must never
  // ride a user's OAuth session, and an unauthenticated forward would only 401
  // after the fact, with the cause a hop away.
  if (!credential.fetch && Object.keys(credential.headers).length === 0) {
    throw new HookForwardUnauthenticatedError(opts.baseUrl);
  }

  const headers = buildForwardHeaders({
    inbound: opts.inboundHeaders,
    kid: opts.kid,
    renames: opts.headerRenames,
    credentialHeaders: credential.headers,
  });
  // Continue the trace onto the forward — the hop that carries the verified
  // identity, which is where P10 says the trace rides.
  injectTraceparent(headers);

  // Same redirect posture as the connector's MCP transport: every hop is
  // re-validated and same-origin only, and the fleet rail's in-cluster `.svc`
  // exception applies to a minted source and nothing else.
  const guarded = createSsrfGuardedFetch(opts.fetchImpl ?? credential.fetch, {
    allowInsecure: opts.allowInsecure ?? false,
    fleetInternal: isMintedFleetSource(opts.transport),
  });

  return (await guarded(target.toString(), {
    method: "POST",
    headers,
    body: opts.body,
  })) as Response;
}
