import { log } from "../cli/log.ts";

/**
 * TEMPORARY diagnostic: log outbound OAuth **token-endpoint** requests and
 * raw responses, gated behind `NB_DEBUG_OAUTH_EXCHANGE`.
 *
 * Why this exists: a remote-OAuth connector's token exchange fails in the
 * agent with the vendor returning `invalid_code`, even though the identical
 * exchange (same code, PKCE, redirect, client) succeeds from a clean `fetch`
 * on the same host. The MCP SDK collapses the vendor's error into an opaque
 * `ServerError` and discards the request/response detail, so we can't see
 * what the agent sends differently — or whether the code is POSTed more than
 * once. This wrapper captures exactly that, for token endpoints only, then is
 * removed once the cause is identified.
 *
 * Off by default. Set `NB_DEBUG_OAUTH_EXCHANGE=1` to enable. Logs are
 * sequence-numbered so a double-exchange of the same code is obvious.
 */
let installed = false;

function isTokenEndpoint(rawUrl: string): boolean {
  try {
    const { pathname } = new URL(rawUrl);
    // `/token`, `/oauth2/token`, `/oauth/token`, … — the OAuth token endpoint.
    return /\/token\/?$/.test(pathname);
  } catch {
    return false;
  }
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return (input as Request).url;
}

/** Wrap a fetch implementation to log token-endpoint traffic. Pure — returns a new fn. */
export function wrapFetchForOAuthDebug(orig: typeof fetch): typeof fetch {
  let seq = 0;
  const wrapped = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url = requestUrl(input);
    if (!isTokenEndpoint(url)) return orig(input, init);

    const n = ++seq;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    let body = "";
    try {
      body = init?.body != null ? String(init.body) : "";
    } catch {
      body = "<unstringifiable body>";
    }
    let headers = "";
    try {
      headers = JSON.stringify(Object.fromEntries(new Headers(init?.headers)));
    } catch {
      /* ignore */
    }
    log.warn(`[oauth-debug] #${n} TOKEN ${method} ${url}`);
    log.warn(`[oauth-debug] #${n} req-headers ${headers}`);
    log.warn(`[oauth-debug] #${n} req-body ${body}`);

    const res = await orig(input, init);
    let respText = "";
    try {
      respText = await res.clone().text();
    } catch {
      respText = "<unreadable response body>";
    }
    log.warn(`[oauth-debug] #${n} resp ${res.status} ${respText.slice(0, 800)}`);
    return res;
  };
  return wrapped as typeof fetch;
}

/**
 * Install the token-exchange logger on `globalThis.fetch` when
 * `NB_DEBUG_OAUTH_EXCHANGE` is set. Idempotent. No-op otherwise.
 */
export function installOAuthFetchDebug(env: NodeJS.ProcessEnv = process.env): void {
  if (installed || !env.NB_DEBUG_OAUTH_EXCHANGE) return;
  installed = true;
  globalThis.fetch = wrapFetchForOAuthDebug(globalThis.fetch);
  log.warn(
    "[oauth-debug] token-exchange fetch logging ENABLED (NB_DEBUG_OAUTH_EXCHANGE) — temporary diagnostic",
  );
}
