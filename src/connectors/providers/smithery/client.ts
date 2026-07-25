/**
 * Thin HTTP adapter over Smithery's Connect REST API.
 *
 * Deliberately plain `fetch` rather than Smithery's npm SDK: the brokered
 * surface the seam needs is four REST calls, and an OSS runtime should not link
 * a vendor SDK (and its transitive tree) to make them. That also means the
 * "lazy vendor" discipline costs nothing here — there is no vendor module to
 * link. The provider still imports THIS module dynamically, so an unconfigured
 * deployment carries none of it in its boot graph.
 *
 * The wire shapes below are transcribed from Smithery's published OpenAPI
 * (`smithery.ai/docs/openapi.json`, `PUT/GET/DELETE /connect/{namespace}/{connectionId}`).
 * Only the fields the runtime actually consumes are modelled, so the type is a
 * standing answer to "what does the platform depend on?" rather than a mirror of
 * the vendor's schema — an unknown `status.state` is treated conservatively, and
 * request fields land here when a caller needs them (`headers`, for instance,
 * returns with `connectApiKey`, which the seam cannot address yet).
 */

import { createHash } from "node:crypto";
import { SMITHERY_TIMEOUT_MS } from "./config.ts";

/** A connection's last-known state at the broker. */
export type SmitheryConnectionState =
  | "connected"
  | "disconnected"
  | "auth_required"
  | "input_required"
  | "error";

export interface SmitheryConnectionStatus {
  state: SmitheryConnectionState;
  /** Hosted Smithery page that completes OAuth (`auth_required`) or config (`input_required`). */
  setupUrl?: string;
  /** Present on `error`. */
  message?: string;
}

export interface SmitheryConnection {
  connectionId: string;
  status?: SmitheryConnectionStatus;
}

/** A non-2xx answer from the Connect API. `status` is the HTTP code. */
export class SmitheryApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SmitheryApiError";
  }
}

/**
 * The broker answered, but the connection needs a human before it can serve MCP
 * — OAuth (`auth_required`) or missing config (`input_required`). Carries the
 * hosted `setupUrl` so the caller can surface it verbatim.
 *
 * This is thrown rather than returned because `ManagedSession` has no way to
 * express "not ready yet" — see the seam's interface notes.
 */
export class SmitheryConnectionNotReadyError extends Error {
  constructor(
    readonly state: SmitheryConnectionState,
    readonly setupUrl: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "SmitheryConnectionNotReadyError";
  }
}

export interface SmitheryClientOptions {
  apiKey: string;
  baseUrl: string;
  namespace: string;
}

/**
 * Derive the connection id for one (owner, server) pair.
 *
 * Must be deterministic — the runtime re-derives it on probe and re-install
 * rather than persisting a broker-assigned id — path-safe, and collision-free
 * after slugification. The readable slug keeps the Smithery dashboard
 * intelligible; the digest is what actually guarantees uniqueness once
 * lossy character folding has run.
 */
export function smitheryConnectionId(userId: string, server: string): string {
  // Length-prefixed so the two inputs can never be confused for one another,
  // whatever characters they contain — a plain separator would have to be a
  // byte neither field can hold, and neither field is constrained.
  const digest = createHash("sha256")
    .update(`${userId.length}:${userId}:${server}`)
    .digest("hex")
    .slice(0, 12);
  const slug = `${userId}-${server}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug ? `nb-${slug}-${digest}` : `nb-${digest}`;
}

/** The MCP endpoint Smithery hosts for one brokered connection. */
export function smitheryMcpUrl(opts: SmitheryClientOptions, connectionId: string): string {
  return `${opts.baseUrl}/connect/${encodeURIComponent(opts.namespace)}/${encodeURIComponent(connectionId)}/mcp`;
}

function connectionUrl(opts: SmitheryClientOptions, connectionId: string): string {
  return `${opts.baseUrl}/connect/${encodeURIComponent(opts.namespace)}/${encodeURIComponent(connectionId)}`;
}

/**
 * One Connect API round-trip with a bounded timeout. Composes the caller's
 * abort signal (the revalidator sweep is cancellable) with our own deadline.
 */
async function request(
  opts: SmitheryClientOptions,
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  const timeout = AbortSignal.timeout(SMITHERY_TIMEOUT_MS);
  const composed = signal ? AbortSignal.any([signal, timeout]) : timeout;
  return fetch(url, {
    ...init,
    signal: composed,
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

async function readJson(res: Response, what: string): Promise<SmitheryConnection> {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new SmitheryApiError(
      res.status,
      `Smithery ${what} failed: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 400)}` : ""}`,
    );
  }
  return (await res.json()) as SmitheryConnection;
}

/**
 * Create-or-update the connection (`PUT` is an upsert). `server` is a Smithery
 * registry qualified name (`nimblebrain/bassethound`); `headers` carries any
 * config credentials, which Smithery stores write-only and never returns.
 *
 * Idempotent by design: re-running with the same target returns the existing
 * connection. A different target URL for an existing id is a 409 at the broker.
 */
export async function upsertSmitheryConnection(
  opts: SmitheryClientOptions,
  connectionId: string,
  body: {
    server: string;
    name?: string;
    metadata?: Record<string, unknown>;
  },
  signal?: AbortSignal,
): Promise<SmitheryConnection> {
  const res = await request(
    opts,
    connectionUrl(opts, connectionId),
    { method: "PUT", body: JSON.stringify(body) },
    signal,
  );
  return readJson(res, "connection upsert");
}

/** Fetch a connection's current state. Returns null on 404 (no such connection). */
export async function getSmitheryConnection(
  opts: SmitheryClientOptions,
  connectionId: string,
  signal?: AbortSignal,
): Promise<SmitheryConnection | null> {
  const res = await request(opts, connectionUrl(opts, connectionId), { method: "GET" }, signal);
  if (res.status === 404) return null;
  return readJson(res, "connection read");
}

/**
 * Delete a connection and terminate its MCP session.
 *
 * Returns nothing: success is "did not throw". A boolean would have exactly one
 * reachable value, and asserting it invites a tautological test.
 */
export async function deleteSmitheryConnection(
  opts: SmitheryClientOptions,
  connectionId: string,
  signal?: AbortSignal,
): Promise<void> {
  const res = await request(opts, connectionUrl(opts, connectionId), { method: "DELETE" }, signal);
  // 404 means it is already gone — the desired end state, so success.
  if (res.ok || res.status === 404) return;
  // Anything else (a revoked platform key → 403, a broker outage → 5xx) must
  // surface. Returning false here would leave the connection, and any upstream
  // grant behind it, alive at the broker with no log line anywhere — exactly
  // what this teardown exists to prevent.
  const body = await res.text().catch(() => "");
  throw new SmitheryApiError(
    res.status,
    `Smithery connection delete failed: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 400)}` : ""}`,
  );
}
