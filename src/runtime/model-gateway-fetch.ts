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
 * - A gateway that cannot be reached fails the call within seconds, as a
 *   {@link ModelGatewayUnreachableError}. Bun's fetch has no connect timeout,
 *   and a gateway that drops connections (rather than refusing them) would
 *   otherwise hold each call until the model stream's first-content watchdog,
 *   which must stay long because a large prompt's first token is legitimately
 *   slow. So when a call has no response after {@link SLOW_RESPONSE_MS}, a TCP
 *   connect to the gateway checks it is reachable: no connection within
 *   {@link CONNECT_TIMEOUT_MS} ends the call, and a connection leaves it to the
 *   watchdog. Only connecting is bounded, never the response.
 */

import { randomUUID } from "node:crypto";
import { connect as netConnect } from "node:net";
import { getRequestContext } from "./request-context.ts";
import type { RunKey } from "./run-key.ts";

/** How long a per-call credential lasts before the gateway's leeway. */
const CALL_CREDENTIAL_MS = 60_000;

/** The headers provider clients carry a key in. */
const PROVIDER_KEY_HEADERS = ["x-api-key", "x-goog-api-key", "authorization"];

/** The workspace a call outside any workspace names. */
const NO_WORKSPACE = "none";

/** How long a call waits for its response before checking the gateway is reachable. */
export const SLOW_RESPONSE_MS = 2_000;

/** How long that check waits for a TCP connection to the gateway. */
export const CONNECT_TIMEOUT_MS = 3_000;

/**
 * The proxy variables Bun's fetch honors. With one set, the call may not go to
 * the gateway directly, so a direct connect would not test the call's path, and
 * the check is skipped.
 */
const PROXY_ENV = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"];

/** Error codes of a call that failed to connect, as Bun's fetch reports them. */
const CONNECT_FAILURE_CODES = new Set([
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "ConnectionRefused",
  "FailedToOpenSocket",
]);

/**
 * A model call that could not reach the installation's model gateway. Nothing
 * reached the client before it, so it is `retryable`: the engine re-issues the
 * call with its short backoff.
 *
 * The connect failure is kept as `code`, not as `cause`: the AI SDK rewraps a
 * fetch error whose cause chain carries a network code, which would lose this
 * error's name and message.
 */
export class ModelGatewayUnreachableError extends Error {
  readonly retryable = true;
  readonly code: string | undefined;
  constructor(reason: string, code?: string) {
    super(`The model gateway is unreachable: ${reason}`);
    this.name = "ModelGatewayUnreachableError";
    this.code = code;
  }
}

/** Open a TCP connection to `host:port` and close it: resolves on connect, rejects on failure or abort. */
export type GatewayConnect = (host: string, port: number, signal: AbortSignal) => Promise<void>;

export interface ModelGatewayFetchOptions {
  /** The reachability check's connect. Default: a TCP connect (`node:net`). */
  connect?: GatewayConnect;
  slowResponseMs?: number;
  connectTimeoutMs?: number;
  /** The environment the proxy variables are read from. Default: `process.env`. */
  env?: Record<string, string | undefined>;
}

export function modelGatewayFetch(
  runKey: RunKey,
  base: typeof fetch = globalThis.fetch,
  opts: ModelGatewayFetchOptions = {},
): typeof fetch {
  const env = opts.env ?? process.env;
  const check: ReachabilityCheck | undefined = PROXY_ENV.some((name) => env[name])
    ? undefined
    : {
        connect: opts.connect ?? tcpConnect,
        slowResponseMs: opts.slowResponseMs ?? SLOW_RESPONSE_MS,
        connectTimeoutMs: opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
      };
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
    if (!check) return base(input, { ...init, headers });
    const unreachable = new AbortController();
    const signal = init?.signal
      ? AbortSignal.any([init.signal, unreachable.signal])
      : unreachable.signal;
    const response = base(input, { ...init, headers, signal });
    return reachableResponse(
      response,
      target(input),
      init?.signal ?? undefined,
      unreachable,
      check,
    );
  };
  return Object.assign(gatewayFetch, { preconnect: base.preconnect }) as typeof fetch;
}

interface ReachabilityCheck {
  connect: GatewayConnect;
  slowResponseMs: number;
  connectTimeoutMs: number;
}

/**
 * The call's response, unless the gateway proves unreachable first: a connect
 * failure the fetch reports itself, or no TCP connection to the gateway within
 * the check's bound once the response is slow. A caller's abort always wins.
 */
async function reachableResponse(
  response: Promise<Response>,
  gateway: { host: string; port: number },
  callerSignal: AbortSignal | undefined,
  unreachable: AbortController,
  check: ReachabilityCheck,
): Promise<Response> {
  const probe = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const failed = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      connectWithin(check, gateway, probe.signal).catch((err: unknown) => {
        if (!probe.signal.aborted) reject(err);
      });
    }, check.slowResponseMs);
  });
  // `failed` can settle after the race below has; that is not an unhandled rejection.
  failed.catch(() => {});
  try {
    return await Promise.race([response, failed]);
  } catch (err) {
    if (callerSignal?.aborted) throw err;
    if (err instanceof ModelGatewayUnreachableError) {
      response.catch(() => {});
      unreachable.abort(err);
      throw err;
    }
    const code = connectFailureCode(err);
    if (code) throw new ModelGatewayUnreachableError(`could not connect (${code})`, code);
    throw err;
  } finally {
    clearTimeout(timer);
    probe.abort();
  }
}

/** Connect to the gateway within the check's bound, or reject with why not. */
async function connectWithin(
  check: ReachabilityCheck,
  gateway: { host: string; port: number },
  signal: AbortSignal,
): Promise<void> {
  const attempt = new AbortController();
  const stop = () => attempt.abort();
  signal.addEventListener("abort", stop, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ModelGatewayUnreachableError(`no connection within ${check.connectTimeoutMs}ms`));
    }, check.connectTimeoutMs);
  });
  const connected = check.connect(gateway.host, gateway.port, attempt.signal);
  connected.catch(() => {});
  try {
    await Promise.race([connected, timedOut]);
  } catch (err) {
    if (err instanceof ModelGatewayUnreachableError) throw err;
    const code = connectFailureCode(err);
    throw new ModelGatewayUnreachableError(`could not connect (${code ?? "connect failed"})`, code);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
    attempt.abort();
  }
}

/** The connect failure code on an error or its causes, if it is one. */
function connectFailureCode(err: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current = err;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === "string" && CONNECT_FAILURE_CODES.has(code)) return code;
    current = cause;
  }
  return undefined;
}

/** The host and port a call to `input` connects to. */
function target(input: Parameters<typeof fetch>[0]): { host: string; port: number } {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  // An IPv6 literal's hostname keeps its brackets; a socket connect takes it bare.
  return { host: url.hostname.replace(/^\[(.*)\]$/, "$1"), port };
}

/** A TCP connect that closes as soon as it opens, fails, or is aborted. */
function tcpConnect(host: string, port: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const socket = netConnect({ host, port });
    const close = () => {
      signal.removeEventListener("abort", onAbort);
      socket.destroy();
    };
    const onAbort = () => {
      close();
      reject(signal.reason);
    };
    // Stays attached for the socket's life: an error after it settled is ignored.
    socket.on("error", (err) => {
      close();
      reject(err);
    });
    socket.once("connect", () => {
      close();
      resolve();
    });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
