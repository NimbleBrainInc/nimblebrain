import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { RemoteTransportConfig } from "../bundles/types.ts";
import { getCredentialProvider } from "./credential-provider.ts";
import { createOAuthRefreshFetch } from "./oauth-refresh-fetch.ts";
import { createSsrfGuardedFetch } from "./ssrf-guarded-fetch.ts";

/**
 * Resolve `${ENV_VAR}` placeholders against `process.env`.
 *
 * Used so catalog entries (and runtime BundleRef values) can carry
 * secret references like `${COMPOSIO_API_KEY}` without persisting the
 * actual secret to `workspace.json`. Substitution happens at transport
 * construction time so the resolved string is held only on the in-
 * memory `Transport` instance.
 *
 * Variables are matched against `[A-Z_][A-Z0-9_]*` — the conventional
 * shell env-var shape. Unknown / unset variables collapse to empty
 * string (mirrors `substituteUserConfigFromEnv` in
 * `src/bundles/startup.ts`); the underlying transport will surface a
 * concrete auth error from the vendor rather than a generic host
 * error, which is more actionable.
 */
export function resolveEnvTemplate(value: string): string {
  return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, key: string) => process.env[key] ?? "");
}

/** Build the outgoing header map (arbitrary + static auth) with `${ENV_VAR}` resolved in one pass. */
function buildRequestHeaders(config?: RemoteTransportConfig): Record<string, string> {
  const headers: Record<string, string> = { ...(config?.headers ?? {}) };

  if (config?.auth?.type === "bearer") {
    headers.Authorization = `Bearer ${config.auth.token}`;
  } else if (config?.auth?.type === "header") {
    headers[config.auth.name] = config.auth.value;
  }

  // Single resolution pass over all headers (auth-derived + arbitrary): the
  // regex is narrow enough that literal `${...}` strings outside the env-var
  // shape pass through unchanged.
  for (const [k, v] of Object.entries(headers)) {
    headers[k] = resolveEnvTemplate(v);
  }

  return headers;
}

/** Resolve a `provider`-auth credential: merge its headers into `headers` and return its minting fetch. */
function applyProviderAuth(
  config: RemoteTransportConfig | undefined,
  headers: Record<string, string>,
  workspaceId?: string,
): FetchLike | undefined {
  // Provider-backed machine-plane auth: a named credential provider produces a
  // `fetch` (or headers) for this connection. NOT a static header (the built-in
  // `minted` provider re-mints a short-lived token on expiry / 401) and NOT
  // OAuth (no interactive flow). The provider + its `config` are opaque here;
  // the kernel just asks for a credential. Fail loud if the named provider isn't
  // registered — a downstream 401 would not name the cause.
  if (config?.auth?.type !== "provider") return undefined;

  const provider = getCredentialProvider(config.auth.provider);
  if (!provider) {
    throw new Error(
      `transport auth provider "${config.auth.provider}" is not registered ` +
        "(call registerBuiltinCredentialProviders() at the composition root)",
    );
  }

  const credential = provider.credentialFor(workspaceId, config.auth.config);
  if (credential.headers) {
    for (const [k, v] of Object.entries(credential.headers)) headers[k] = v;
  }
  return credential.fetch;
}

/** OAuth provider applies only when no static auth is configured — static auth is the explicit contract. */
function selectAuthProvider(
  config: RemoteTransportConfig | undefined,
  authProvider?: OAuthClientProvider,
): OAuthClientProvider | undefined {
  return config?.auth && config.auth.type !== "none" ? undefined : authProvider;
}

/** Transport fetch: the minting fetch, else an OAuth-refresh fetch for an OAuth connector, else none. */
function selectTransportFetch(
  mintingFetch: FetchLike | undefined,
  effectiveAuthProvider: OAuthClientProvider | undefined,
): FetchLike | undefined {
  // For an OAuth connector (no static auth, no minting provider), wrap the
  // transport's `fetch` so transient token-endpoint refresh failures are
  // retried in place instead of bubbling up as a fabricated `UnauthorizedError`
  // that wrongly flips the connection to `reauth_required`. The SDK threads
  // this `fetch` into its refresh POST, the one seam where the
  // transient-vs-dead-token distinction is still recoverable — see
  // `oauth-refresh-fetch.ts`. `mintingFetch` and OAuth are mutually exclusive
  // (a `provider` auth is not `none`, so `effectiveAuthProvider` is unset when
  // `mintingFetch` is set), so the `??` never drops a minting fetch.
  return mintingFetch ?? (effectiveAuthProvider ? createOAuthRefreshFetch() : undefined);
}

/** Streamable-HTTP reconnection options derived from config, or undefined when not configured. */
function buildReconnectionOptions(config?: RemoteTransportConfig) {
  if (!config?.reconnection) return undefined;
  return {
    maxReconnectionDelay: config.reconnection.maxReconnectionDelay ?? 30_000,
    initialReconnectionDelay: config.reconnection.initialReconnectionDelay ?? 1_000,
    reconnectionDelayGrowFactor: 1.5,
    maxRetries: config.reconnection.maxRetries ?? 5,
  };
}

/**
 * Create a remote MCP transport from a URL and optional config.
 * Default transport: Streamable HTTP. Use type: "sse" for legacy SSE servers.
 *
 * Auth precedence: static header auth (`config.auth`) wins if present. An
 * `authProvider` is only attached when no static auth is configured —
 * servers using API keys in headers don't trigger OAuth flows they might
 * not support. When attached, the MCP SDK handles discovery (RFC 9728),
 * dynamic client registration (RFC 7591), PKCE, and token refresh.
 *
 * **`${ENV_VAR}` template substitution** applies to every value in the
 * outgoing header map — both `config.auth` (bearer token / header
 * value) AND arbitrary entries in `config.headers`. Broad-scope by
 * design: a Composio-style connector might want a custom header like
 * `X-Vendor-Trace: ${NB_TENANT_ID}` resolved at transport build time,
 * not just the API-key auth value. The regex (`[A-Z_][A-Z0-9_]*`)
 * is narrow enough that literal `${...}` strings outside that shape
 * pass through unchanged. Unset variables collapse to empty string;
 * the underlying vendor surfaces a concrete error rather than a
 * generic platform 500.
 */
export function createRemoteTransport(
  url: URL,
  config?: RemoteTransportConfig,
  authProvider?: OAuthClientProvider,
  opts?: {
    /** Workspace of the connection — passed to a credential provider (e.g. the
     *  dimension a `provider`-auth token is scoped to). Threaded from the
     *  McpSource's `BundleMcpContext`. */
    workspaceId?: string;
    /** Dev-mode flag (`allowInsecureRemotes`) threaded to the SSRF redirect
     *  guard so http://localhost endpoints still work under local development.
     *  Defaults to false (production posture). */
    allowInsecure?: boolean;
  },
): Transport {
  const headers = buildRequestHeaders(config);
  const mintingFetch = applyProviderAuth(config, headers, opts?.workspaceId);
  const effectiveAuthProvider = selectAuthProvider(config, authProvider);
  const transportFetch = selectTransportFetch(mintingFetch, effectiveAuthProvider);

  // SSRF redirect guard: the SDK transports follow redirects automatically
  // (fetch default `redirect: "follow"`). For a tenant-supplied remote URL,
  // that would let a hostile server 30x our fetch into the cluster network or
  // cloud metadata. Interpose manual, per-hop-validated redirect handling over
  // whatever fetch the transport would otherwise use (minting / OAuth-refresh /
  // global). A `provider`-auth source is the operator-vetted fleet rail and may
  // point at an in-cluster `http://*.svc` endpoint, so its configured URL is
  // validated with `fleetInternal` — redirect targets never are.
  const guardedFetch: FetchLike = createSsrfGuardedFetch(transportFetch, {
    allowInsecure: opts?.allowInsecure ?? false,
    fleetInternal: config?.auth?.type === "provider",
  });

  const requestInit: RequestInit = Object.keys(headers).length > 0 ? { headers } : {};

  if (config?.type === "sse") {
    return new SSEClientTransport(url, {
      requestInit,
      authProvider: effectiveAuthProvider,
      fetch: guardedFetch,
    });
  }

  return new StreamableHTTPClientTransport(url, {
    requestInit,
    authProvider: effectiveAuthProvider,
    fetch: guardedFetch,
    reconnectionOptions: buildReconnectionOptions(config),
    sessionId: config?.sessionId,
  });
}
