import { createHash } from "node:crypto";
import type { FetchLike } from "@modelcontextprotocol/server";
import { log } from "../observability/log.ts";

/**
 * Refresh-aware `fetch` wrapper for remote OAuth MCP connectors.
 *
 * ## Why this exists
 *
 * The MCP SDK's `auth()` collapses three distinct token-refresh outcomes
 * into one indistinguishable `redirectToAuthorization()` call
 * (`@modelcontextprotocol/client`, the `catch` at the refresh
 * `try`): a transient failure (network throw, or a 5xx/`server_error` that
 * `parseErrorResponse` maps to `ServerError`) is **swallowed** and falls
 * through to a fresh-authorization attempt — exactly like a genuinely dead
 * refresh token. On our headless server, `WorkspaceOAuthProvider`
 * `redirectToAuthorization()` can't open a browser, so it throws
 * `UnauthorizedError`. `McpSource.execute()` then reads that as "the refresh
 * token was rejected", flips the connection to `reauth_required`, and drops
 * the connector from the run — telling the user to reconnect a connector
 * whose credential was never actually rejected.
 *
 * By the time control reaches the provider, the transient-vs-dead bit has
 * already been erased. The one seam where it is still live is the refresh
 * HTTP call itself. The SDK threads the transport's `fetch` (`opts.fetch`)
 * all the way into `executeTokenRequest` via `createFetchWithInit`, so a
 * wrapping `fetch` injected on the OAuth transport can absorb transient
 * token-endpoint failures with bounded retry *before* the swallow can
 * fabricate a fake `UnauthorizedError`. A genuine `invalid_grant` /
 * `invalid_client` is passed through unmodified on the first attempt, so the
 * SDK's existing dead-token → redirect → `UnauthorizedError` path still
 * fires and the `reauth_required` flip stays correct.
 *
 * ## Scope
 *
 * Only the OAuth refresh-token POST (`grant_type=refresh_token`) is retried
 * and shared (see `spendOnce`). Every other transport request — the MCP JSON-RPC tool calls,
 * the one-shot `authorization_code` exchange — passes straight through to a
 * single `fetch`, so tool-call semantics and the inline/task retry asymmetry
 * in `McpSource` are untouched.
 */

/**
 * OAuth error codes that mean the refresh token is genuinely dead — retrying
 * can't help and the connector must be reconnected by the user. Anything else
 * (5xx, 429, network throw, `server_error`, `temporarily_unavailable`) is
 * transient and worth a bounded retry.
 *
 * Safety note: the retry decision is an ALLOWLIST — only `TRANSIENT_REFRESH_ERRORS`
 * retry; any unrecognized 4xx code is treated as permanent by default. This set
 * is therefore an intent-documenting short-circuit, not the load-bearing guard
 * (the allowlist default is). Fail-closed: an unknown code never retries.
 */
const PERMANENT_REFRESH_ERRORS = new Set([
  "invalid_grant",
  "invalid_client",
  "unauthorized_client",
]);

/** OAuth error codes that are explicitly transient even on a 4xx response. */
const TRANSIENT_REFRESH_ERRORS = new Set([
  "server_error",
  "temporarily_unavailable",
  "too_many_requests",
]);

export interface OAuthRefreshFetchOptions {
  /** Total attempts including the first (default 3 → up to 2 retries). */
  maxAttempts?: number;
  /** Backoff base in ms; grows exponentially with full jitter (default 300). */
  baseDelayMs?: number;
  /** Underlying fetch — injectable for tests. Defaults to global `fetch`. */
  fetchImpl?: FetchLike;
  /** Sleep — injectable for tests. Defaults to real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** RNG for jitter in [0,1) — injectable for deterministic tests. */
  rng?: () => number;
}

/**
 * The form fields of a request body, whatever form it reaches this fetch in.
 * The SDK posts `URLSearchParams`, but a wrapper outside this one may already
 * have buffered it: the SSRF guard turns every non-string body into bytes so it
 * can replay it across a redirect. A body read only in the SDK's own form would
 * make every refresh look like an ordinary request.
 */
function formFields(body: RequestInit["body"]): URLSearchParams | null {
  if (body == null) return null;
  if (body instanceof URLSearchParams) return body;
  if (typeof body === "string") return new URLSearchParams(body);
  if (body instanceof ArrayBuffer) return new URLSearchParams(new TextDecoder().decode(body));
  if (ArrayBuffer.isView(body)) {
    return new URLSearchParams(
      new TextDecoder().decode(new Uint8Array(body.buffer, body.byteOffset, body.byteLength)),
    );
  }
  return null;
}

/**
 * The refresh token an OAuth refresh-token grant POST spends (the only request
 * this fetch handles), or null for any other request.
 */
function refreshGrantToken(init?: RequestInit): string | null {
  const fields = formFields(init?.body);
  if (fields?.get("grant_type") !== "refresh_token") return null;
  return fields.get("refresh_token") ?? "";
}

/**
 * Does a non-OK refresh response represent a transient failure (retry) rather
 * than a permanent credential rejection (give up, let the SDK reauth)?
 *
 * Reads a clone so the original body stays intact for the SDK's own
 * `parseErrorResponse` re-read.
 */
async function isTransientRefreshResponse(res: Response): Promise<boolean> {
  if (res.status >= 500) return true; // gateway / ServerError class
  if (res.status === 429 || res.status === 408) return true;
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    // A 4xx may still be transient if it carries a transient OAuth code.
    // Unparseable / unrecognized 4xx → treat as permanent so we never mask a
    // real `invalid_grant`.
    try {
      const data = (await res.clone().json()) as { error?: unknown };
      const code = typeof data?.error === "string" ? data.error : undefined;
      if (!code || PERMANENT_REFRESH_ERRORS.has(code)) return false;
      return TRANSIENT_REFRESH_ERRORS.has(code);
    } catch {
      return false;
    }
  }
  return false;
}

function backoffDelayMs(attempt: number, baseDelayMs: number, rng: () => number): number {
  // attempt is 1-based. Exponential with full jitter, capped — the whole retry
  // budget must stay well under McpSource's remote-connect timeout (15s) so a
  // persistently-down token endpoint still fails fast into the SDK's reauth
  // path instead of hanging the handshake.
  const exp = Math.min(baseDelayMs * 2 ** (attempt - 1), 2_000);
  return Math.floor(exp * (0.5 + rng() * 0.5));
}

/** Why a refresh attempt wants to retry — carries the data its log line needs. */
type RetryReason = { kind: "response"; status: number } | { kind: "network"; message: string };

/** Outcome of one refresh attempt: hand back the response, retry, or rethrow. */
type AttemptResult =
  | { kind: "return"; res: Response }
  | { kind: "retry"; reason: RetryReason }
  | { kind: "throw"; err: unknown };

/**
 * Build a `fetch` that retries transient OAuth refresh-token failures in place.
 * Pass as the `fetch:` option to a remote OAuth transport.
 */
export function createOAuthRefreshFetch(options: OAuthRefreshFetchOptions = {}): FetchLike {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 300;
  const doFetch: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const rng = options.rng ?? Math.random;

  /** Run one refresh POST and classify it: return the response, retry, or rethrow. */
  const runRefreshAttempt = async (
    url: string | URL,
    init: RequestInit | undefined,
    isLast: boolean,
  ): Promise<AttemptResult> => {
    try {
      const res = await doFetch(url, init);
      if (!isLast && (await isTransientRefreshResponse(res))) {
        return { kind: "retry", reason: { kind: "response", status: res.status } };
      }
      return { kind: "return", res };
    } catch (err) {
      // A thrown fetch is network-level (connection drop, TLS reset, DNS, abort).
      // Retrying is safe EXCEPT one unavoidable window: if the prior attempt
      // actually reached the server and rotated the refresh token (rotating IdPs),
      // but the response was lost on the wire, the retry re-sends the now-stale
      // token → `invalid_grant` → reauth. That is inherent to retrying a refresh
      // (not idempotent under rotation), and it is strictly NARROWER than reauth
      // on every transient blip — here only the lost-response-after-rotation case
      // does, and the same lost response would reauth without any retry.
      if (isLast) return { kind: "throw", err };
      const message = err instanceof Error ? err.message : String(err);
      return { kind: "retry", reason: { kind: "network", message } };
    }
  };

  /** Warn about the impending retry and sleep out this attempt's jittered backoff. */
  const logAndSleepBeforeRetry = async (attempt: number, reason: RetryReason): Promise<void> => {
    const delay = backoffDelayMs(attempt, baseDelayMs, rng);
    const retry = `retry ${attempt}/${maxAttempts - 1} in ${delay}ms`;
    const message =
      reason.kind === "response"
        ? `[oauth] token refresh transient failure (status=${reason.status}) — ${retry}`
        : `[oauth] token refresh network error — ${retry}: ${reason.message}`;
    log.warn(message);
    await sleep(delay);
  };

  // The (retrying) refresh POST, run once. A thrown fetch is network-level
  // (connection drop, TLS reset, DNS, abort) — always transient; a transient
  // response (5xx/429/transient OAuth code) is retried within budget. On
  // exhaustion the last response is returned / the last error re-thrown so the
  // SDK sees a real failure and its reauth path can fire.
  const refreshWithRetry = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const outcome = await runRefreshAttempt(url, init, attempt >= maxAttempts);
      if (outcome.kind === "return") return outcome.res;
      if (outcome.kind === "throw") throw outcome.err;
      await logAndSleepBeforeRetry(attempt, outcome.reason);
    }
    // Unreachable: the final attempt either returns or throws above.
    throw new Error("oauth refresh fetch: retry loop exited without result");
  };

  // Run the refresh once and snapshot the response body into a buffer, so every
  // coalesced caller can be handed an independent, fully-readable `Response`
  // (the SDK's `auth()` reads the body on each caller's own flow). Token
  // responses are small JSON, so buffering is trivial.
  const refreshOnceSnapshot = async (
    url: string | URL,
    init?: RequestInit,
  ): Promise<() => Response> => {
    const res = await refreshWithRetry(url, init);
    const body = await res.arrayBuffer();
    const responseInit: ResponseInit = {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    };
    return () => new Response(body, responseInit);
  };

  return async (url, init) => {
    const refreshToken = refreshGrantToken(init);
    if (refreshToken === null) {
      return doFetch(url, init);
    }
    // One exchange per refresh token, process-wide. The engine runs a turn's
    // tool calls in parallel, so on token expiry N calls 401 at once, and a
    // restarted or rebuilt connection runs on a transport of its own (each
    // with its own fetch). Every request spending the same token shares one
    // upstream attempt and gets an independent snapshot of its result: an IdP
    // that rotates refresh tokens revokes the one it was given, so a second
    // spend gets `invalid_grant`, and the SDK answers that by deleting the
    // credential the first spend just renewed.
    return (await spendOnce(String(url), refreshToken, () => refreshOnceSnapshot(url, init)))();
  };
}

/**
 * How long a successful exchange keeps answering for the token it spent. A
 * request that read the token before the winner saved its successor can reach
 * this fetch after the winner's POST has settled; within this window it gets the
 * winner's response, which carries the successor, instead of spending a revoked
 * token. A failed exchange is dropped at once, so a retry runs.
 */
export const REFRESH_REPLAY_MS = 60_000;

interface Exchange {
  result: Promise<() => Response>;
  /** When a successful exchange stops answering; unset while in flight. */
  expiresAt?: number;
}

/**
 * Refresh exchanges in this process, by a hash of the token endpoint and the
 * refresh token spent: never the token itself, which is a credential.
 */
const exchanges = new Map<string, Exchange>();

function exchangeKey(url: string, refreshToken: string): string {
  return createHash("sha256").update(url).update("\n").update(refreshToken).digest("hex");
}

/** Run `exchange` for this token unless one is in flight or recently succeeded, and share it. */
function spendOnce(
  url: string,
  refreshToken: string,
  exchange: () => Promise<() => Response>,
): Promise<() => Response> {
  const now = Date.now();
  for (const [key, entry] of exchanges) {
    if (entry.expiresAt !== undefined && entry.expiresAt <= now) exchanges.delete(key);
  }
  const key = exchangeKey(url, refreshToken);
  const existing = exchanges.get(key);
  if (existing) return existing.result;
  const entry: Exchange = { result: exchange() };
  exchanges.set(key, entry);
  entry.result.then(
    (makeResponse) => {
      if (makeResponse().ok) entry.expiresAt = Date.now() + REFRESH_REPLAY_MS;
      else if (exchanges.get(key) === entry) exchanges.delete(key);
    },
    () => {
      if (exchanges.get(key) === entry) exchanges.delete(key);
    },
  );
  return entry.result;
}

/** Forget every exchange. Tests only: each test spends its own tokens. */
export function resetRefreshExchanges(): void {
  exchanges.clear();
}
