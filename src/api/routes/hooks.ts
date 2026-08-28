import { Hono } from "hono";
import { serverNameFromRef } from "../../bundles/paths.ts";
import type { BundleRef } from "../../bundles/types.ts";
import { forwardDelivery } from "../../hooks/forward.ts";
import { findRegistration, isKidAdmissible } from "../../hooks/registrations.ts";
import {
  HOOKS_PATH_PREFIX,
  type HookIdentity,
  type HookTokenPayload,
  openHookToken,
  readHookIdentity,
} from "../../hooks/token.ts";
import type { HookRegistration } from "../../hooks/types.ts";
import { log } from "../../observability/log.ts";
import { clientAddressFor } from "../client-address.ts";
import { hooksForwardSeconds, hooksReceivedTotal } from "../metrics.ts";
import type { RequestRateLimiter } from "../rate-limiter.ts";
import type { AppContext } from "../types.ts";

/**
 * The hooks door — `POST /v1/hooks/:connector/:vendor/:token`.
 *
 * The one generic entry point for inbound vendor deliveries. It is mounted
 * AHEAD of auth middleware, alongside the OAuth return legs, because like them
 * it is unauthenticated by design: a vendor's HTTP POST cannot carry a platform
 * token, and the credential it does carry is the capability in the path.
 *
 * **The handler stays thin, and that is a hard constraint rather than a style
 * preference.** A tenant runtime is one pod; a delivery arriving while it is
 * busy is a 5xx the vendor has to retry. So: open, check, mint, forward. No
 * queue, no persistence, no retry, no body parsing. Durability belongs to the
 * vendor's own retry and to the receiving bundle's raw capture and reconcile
 * poll — both of which can provide it and neither of which is this process.
 *
 * **Every rejection is the same 404 with an empty body.** A bad token, a token
 * sealed under another tenant's key, path segments that disagree with the
 * sealed ones, a retired key id, an uninstalled connector — all of them take
 * one path and produce one indistinguishable answer. Distinguishing them would
 * hand a prober an oracle for which half of a guess was right, which is the
 * same reasoning that makes an RLS-denied row a 404 rather than a 403.
 */

/**
 * Largest delivery body the door will read.
 *
 * The cap is on the READ, not on `Content-Length`: a declared length is a
 * client assertion and a chunked request carries none at all, so treating the
 * header as the limit would leave the actual limit unenforced for exactly the
 * requests most likely to be hostile. The header is still checked first — as an
 * optimization that avoids reading a byte of a body already declared too large,
 * never as the limit itself.
 */
export const HOOK_MAX_BODY_BYTES = 256 * 1024;

/**
 * Pre-token bucket, per source address, per minute.
 *
 * Sized above any plausible single-vendor burst rather than tight against it:
 * a vendor delivering a campaign day's events from one egress address would
 * otherwise throttle itself, and the mistake that produces is silent (the
 * vendor's retries eventually expire). It is an anti-flood control, not a
 * capacity plan, and the ceiling that actually protects the process is the
 * post-token per-workspace bucket below.
 */
export const HOOK_ANON_BUCKET_MAX = 600;

/**
 * Post-token bucket, per `(workspace, connector)`, per minute.
 *
 * Sized BELOW the fleet edge's per-tenant ceiling, which the forwarded traffic
 * shares with the agent's own tool calls to the same bundle. A burst should
 * fail here — as a 429 the vendor retries, against one workspace — rather than
 * at the edge, where it would also starve the agent.
 */
export const HOOK_WORKSPACE_BUCKET_MAX = 120;

export const HOOK_BUCKET_WINDOW_MS = 60_000;

/**
 * The single 404 every rejection produces: no body, no headers, no hint.
 *
 * Rejections are counted (`nb_hooks_received_total{outcome="rejected"}`) but
 * deliberately not logged line by line. Nobody guesses a hook path by accident,
 * so a sustained rejected rate means someone is probing — and a per-request log
 * line would hand that prober a way to fill the log. The metric is the alert;
 * the log is for deliveries that actually happened.
 */
function notFound(): Response {
  return new Response(null, { status: 404 });
}

/**
 * Read a request body with a hard cap, or `null` when the cap is exceeded.
 *
 * Streamed and counted rather than buffered-then-measured, so an oversized body
 * costs the bytes actually read and no more.
 */
async function readCappedBody(req: Request, cap: number): Promise<Uint8Array | null> {
  const stream = req.body;
  if (!stream) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    // Sender hung up mid-body. Treat as an unreadable delivery — the vendor
    // will retry, and there is nothing to forward.
    return null;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Find an installed connector by its resolved server name. */
function findInstalledConnector(bundles: BundleRef[], connector: string): BundleRef | undefined {
  return bundles.find((ref) => serverNameFromRef(ref) === connector);
}

export interface HooksRoutesOptions {
  /** Overrides the env-resolved identity. Tests only. */
  identity?: HookIdentity;
  /** Overrides the outbound fetch. Tests only. */
  fetchImpl?: typeof fetch;
  /** Overrides the context's pre-token bucket. Tests only. */
  anonLimiter?: RequestRateLimiter;
  /** Overrides the context's post-token bucket. Tests only. */
  workspaceLimiter?: RequestRateLimiter;
}

/**
 * Build the hooks routes, or `null` when this deployment has no hooks door.
 *
 * `null` is the honest answer for a runtime with no hook key provisioned — a
 * local checkout, an OSS run, a tenant whose operator has not enabled the
 * capability. Mounting nothing means `/v1/hooks/...` 404s at the router rather
 * than reaching a handler that fails an internal config gate, which is the same
 * shape `createApp` already uses for managed-connector provider routes.
 */
export function hooksRoutes(ctx: AppContext, opts: HooksRoutesOptions = {}): Hono | null {
  const identity = opts.identity ?? readHookIdentity();
  if (!identity) return null;

  // Owned by `startServer` so `stop()` clears their sweep timers with every
  // other limiter's. A limiter constructed here would keep an interval alive
  // past the server it belongs to.
  const anonLimiter = opts.anonLimiter ?? ctx.hookAnonLimiter;
  const workspaceLimiter = opts.workspaceLimiter ?? ctx.hookWorkspaceLimiter;

  const app = new Hono();

  // `all`, not `post`: a non-POST must answer 405 rather than 404, and it must
  // do so for ANY three-segment path under the prefix. Registering POST alone
  // would make Hono answer 404 for a GET, and the difference between "405 here"
  // and "404 there" would map out which paths exist.
  app.all(`${HOOKS_PATH_PREFIX}/:connector/:vendor/:token`, async (c) => {
    const req = c.req.raw;

    // Step 0 — anonymous bucket, keyed on the client address, before the body
    // is read and before any crypto. Keyed per source because an unkeyed
    // prefix-wide counter would let one flooding host hold it empty and 429
    // every legitimate delivery: the control would become the denial.
    const source = clientAddressFor(req.headers, readPeerAddress(c.env, req));
    if (!anonLimiter.consume(source)) return rateLimited();

    if (req.method !== "POST") {
      hooksReceivedTotal.inc({ outcome: "rejected" });
      return new Response(null, { status: 405, headers: { Allow: "POST" } });
    }

    const body = await readBodyWithinCap(req);
    if (body === null) {
      hooksReceivedTotal.inc({ outcome: "rejected" });
      return new Response(null, { status: 413 });
    }

    const admitted = await admitDelivery(ctx, identity, {
      connector: c.req.param("connector"),
      vendor: c.req.param("vendor"),
      token: c.req.param("token"),
    });
    if (!admitted) {
      hooksReceivedTotal.inc({ outcome: "rejected" });
      return notFound();
    }

    if (!workspaceLimiter.consume(`${admitted.payload.wid}|${admitted.payload.connector}`)) {
      return rateLimited();
    }

    return forwardAdmitted(ctx, admitted, req, body, opts.fetchImpl);
  });

  return app;
}

/** Both buckets answer the same way: 429 with a retry hint and no body. */
function rateLimited(): Response {
  hooksReceivedTotal.inc({ outcome: "rate_limited" });
  return new Response(null, { status: 429, headers: { "Retry-After": "60" } });
}

/**
 * Read the delivery body, or `null` when it exceeds the cap or the sender hung
 * up mid-transfer.
 *
 * `Content-Length` is consulted first purely as an optimization — it avoids
 * reading a byte of a body already declared too large — and never as the limit
 * itself, which is the streamed read below. See {@link HOOK_MAX_BODY_BYTES}.
 */
async function readBodyWithinCap(req: Request): Promise<Uint8Array | null> {
  const declared = Number.parseInt(req.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > HOOK_MAX_BODY_BYTES) return null;
  return readCappedBody(req, HOOK_MAX_BODY_BYTES);
}

/** The `url:` variant of a `BundleRef` — the only shape a hook can forward to,
 *  because a forward needs a base URL and a transport to resolve against. */
type RemoteBundleRef = Extract<BundleRef, { url: string }>;

/** A delivery that passed every check, with everything the forward needs. */
interface AdmittedDelivery {
  payload: HookTokenPayload;
  registration: HookRegistration;
  ref: RemoteBundleRef;
}

/**
 * Open the token and decide whether this delivery may be forwarded.
 *
 * Returns `undefined` for every rejection reason there is — a token that will
 * not open, one sealed under another tenant's key, path segments that disagree
 * with the sealed ones, a workspace that is gone, a missing or retired key id,
 * a connector no longer installed. Collapsing them into one return value is
 * deliberate and is the whole point of the function: the caller has nothing to
 * branch on, so it cannot accidentally answer two rejections differently and
 * hand a prober an oracle for which half of a guess was right.
 */
async function admitDelivery(
  ctx: AppContext,
  identity: HookIdentity,
  path: { connector: string; vendor: string; token: string },
): Promise<AdmittedDelivery | undefined> {
  let payload: HookTokenPayload;
  try {
    payload = openHookToken(path.token, identity.key, identity.tid);
  } catch {
    return undefined;
  }

  // The runtime routes on the SEALED connector and vendor. The path segments
  // exist so an operator reading a log line or a vendor dashboard can tell what
  // a URL is for; they are cross-checked here and never trusted.
  if (payload.connector !== path.connector || payload.vendor !== path.vendor) return undefined;

  const ws = await ctx.runtime.getWorkspaceStore().get(payload.wid);
  if (!ws) return undefined;

  const registration = findRegistration(ws, payload.connector, payload.vendor);
  if (!registration || !isKidAdmissible(registration, payload.kid)) return undefined;

  // The connector must still be installed — which is also where the forward
  // target comes from, so this is a required lookup rather than an extra check.
  // An uninstall drops the registration too; this is what still holds if a
  // workspace record is edited by hand or a cleanup path is ever missed.
  const ref = findInstalledConnector(ws.bundles ?? [], payload.connector);
  if (!ref || !("url" in ref)) return undefined;

  return { payload, registration, ref };
}

/** The forward hop, plus the metric, the log line, and the vendor's answer. */
async function forwardAdmitted(
  ctx: AppContext,
  admitted: AdmittedDelivery,
  req: Request,
  body: Uint8Array,
  fetchImpl: typeof fetch | undefined,
): Promise<Response> {
  const { payload, registration, ref } = admitted;
  const startedAt = performance.now();
  try {
    const upstream = await forwardDelivery({
      baseUrl: ref.url,
      transport: ref.transport,
      route: registration.route,
      workspaceId: payload.wid,
      inboundHeaders: req.headers,
      headerRenames: registration.headerRenames,
      body,
      allowInsecure: ctx.runtime.getAllowInsecureRemotes(),
      fetchImpl,
    });
    hooksForwardSeconds.observe((performance.now() - startedAt) / 1000);
    hooksReceivedTotal.inc({ outcome: "forwarded" });
    logDelivery(payload, "forwarded", upstream.status, startedAt);
    // The connector's status is the vendor's answer: it is the party that knows
    // whether the delivery was accepted, and a runtime that rewrote it would be
    // deciding on the bundle's behalf whether a retry is wanted.
    return new Response(upstream.body, {
      status: upstream.status,
      headers: passthroughResponseHeaders(upstream.headers),
    });
  } catch (err) {
    hooksForwardSeconds.observe((performance.now() - startedAt) / 1000);
    hooksReceivedTotal.inc({ outcome: "upstream_error" });
    logDelivery(payload, "upstream_error", undefined, startedAt, err);
    // 502 so the vendor retries. A configuration problem — an interactive-OAuth
    // connector that install should have refused, a route that no longer
    // resolves inside the connector's origin — answers the same way
    // deliberately: the runtime minted this URL, so 404-ing a hook it is on the
    // hook for would be a lie, and the error log is what an operator acts on.
    return new Response(null, { status: 502 });
  }
}

/**
 * Response headers passed back to the vendor.
 *
 * The status is the connector's, and so is the content type — but three classes
 * of header describe the hop the runtime made rather than the one it is
 * answering on, and re-emitting any of them describes the wrong response.
 *
 * `content-encoding` and `content-length` are the ones that bite. `fetch`
 * transparently decodes a compressed response body but leaves both headers on
 * `upstream.headers`, so copying them tells the vendor `gzip` while handing it
 * plaintext, at a length that was the compressed one. A vendor's client then
 * fails to decode, scores the delivery failed, and redelivers — which quietly
 * inverts the contract this door gives a bundle author, that a `2xx` means the
 * delivery is durably recorded and will not be retried. The body being returned
 * here is the decoded one; neither header describes it, so neither travels.
 */
function passthroughResponseHeaders(upstream: Headers): Headers {
  const out = new Headers(upstream);
  out.delete("content-encoding");
  out.delete("content-length");
  out.delete("transfer-encoding");
  out.delete("connection");
  out.delete("keep-alive");
  return out;
}

/**
 * One log line per delivery: what it was for, what happened, how long it took.
 *
 * **This is the only place the `kid` appears.** The forward carries no header
 * for it — the edge strips the reserved `x-nb-*` namespace by rule, so one
 * would reach nothing — which makes this line the whole of kid correlation. An
 * operator matching a vendor's delivery log against a minted URL reads it here,
 * so the field is load-bearing rather than decorative: dropping it would leave
 * no way to tell which URL a delivery arrived on.
 *
 * **Never the token and never the body.** The `kid` names which minted URL was
 * used without being usable as one; the token IS one, and a live bearer
 * capability does not belong in a log. The body is the tenant's data, and the
 * runtime has no business having read it.
 */
function logDelivery(
  payload: { wid: string; connector: string; vendor: string; kid: string },
  outcome: string,
  status: number | undefined,
  startedAt: number,
  err?: unknown,
): void {
  const fields: Record<string, unknown> = {
    workspace_id: payload.wid,
    connector: payload.connector,
    vendor: payload.vendor,
    kid: payload.kid,
    outcome,
    duration_ms: Math.round(performance.now() - startedAt),
  };
  if (status !== undefined) fields.status = status;
  if (err) {
    fields.error = err instanceof Error ? err.message : String(err);
    log.error("[hooks] delivery could not be forwarded", fields);
    return;
  }
  log.info("[hooks] delivery forwarded", fields);
}

/**
 * The transport-level peer address, when the server exposes one.
 *
 * Hono's Bun adapter puts the `Bun.serve` server on `c.env`, which offers
 * `requestIP`. It is the PROXY behind a load balancer, so it is only ever the
 * fallback for a request with no usable forwarded chain — see
 * `clientAddressFor`.
 */
function readPeerAddress(env: unknown, req: Request): string | null {
  const server = env as
    | { requestIP?: (req: Request) => { address?: string } | null }
    | undefined
    | null;
  if (!server || typeof server.requestIP !== "function") return null;
  try {
    return server.requestIP(req)?.address ?? null;
  } catch {
    return null;
  }
}
