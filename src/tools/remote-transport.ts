import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { RemoteTransportConfig } from "../bundles/types.ts";
import { isMintedFleetSource } from "../oauth/minted-credential-provider.ts";
import { getCredentialProvider } from "./credential-provider.ts";
import { type CredentialValue, isCredentialRef } from "./credential-ref.ts";
import { type CredentialScope, resolveCredentialValue } from "./credential-store.ts";
import { createOAuthRefreshFetch } from "./oauth-refresh-fetch.ts";
import { createSsrfGuardedFetch } from "./ssrf-guarded-fetch.ts";

/**
 * Build the outgoing header map (arbitrary + static auth), dereferencing any
 * `{ ref: "credential", key }` against the connection's own workspace.
 *
 * Workspace scope is not a parameter: a connection belongs to exactly one
 * workspace, and that is the only scope a tenant-editable `workspace.json` may
 * reach. A reference with no workspace in scope is refused rather than resolved
 * somewhere else — the alternative is a header silently filled from another
 * tenant's key.
 *
 * Resolution happens per transport build, so rotating a key is a `put` and the
 * next connection carries the new value with no config edit and no restart.
 */
async function buildRequestHeaders(
  config?: RemoteTransportConfig,
  workspaceId?: string,
): Promise<Record<string, string>> {
  const scope: CredentialScope | undefined = workspaceId
    ? { kind: "workspace", wsId: workspaceId }
    : undefined;

  /** Dereference one header value, naming the header in the audit trail. */
  const resolve = async (value: CredentialValue, headerName: string): Promise<string> => {
    if (!isCredentialRef(value)) return value;
    if (!scope) {
      throw new Error(
        `[remote-transport] header "${headerName}" references credential ` +
          `"${value.key}" but the connection has no workspace; a credential ` +
          "reference resolves only at the connection's own workspace scope",
      );
    }
    return resolveCredentialValue(value, scope, {
      caller: "transport:header",
      purpose: `outbound MCP request header ${headerName}`,
    });
  };

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(config?.headers ?? {})) {
    headers[name] = await resolve(value, name);
  }

  if (config?.auth?.type === "bearer") {
    headers.Authorization = `Bearer ${await resolve(config.auth.token, "Authorization")}`;
  } else if (config?.auth?.type === "header") {
    headers[config.auth.name] = await resolve(config.auth.value, config.auth.name);
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

/**
 * The credential one connection presents, resolved from its transport config:
 * static headers plus, for `provider` auth, the fetch wrapper that mints and
 * re-mints a token per request.
 *
 * Exported because the MCP transport is no longer the only thing that calls a
 * connector's server. The hooks door forwards an inbound vendor delivery to a
 * route the SAME connector declared, and it must present the SAME credential —
 * resolving it a second way is how the two drift into disagreeing about how a
 * connection authenticates.
 *
 * `authProvider` (interactive OAuth) is deliberately NOT part of this: it lives
 * inside the SDK transport and is user-bound, so there is nothing here to hand
 * a non-MCP caller. A caller that needs a credential and gets neither `headers`
 * nor `fetch` back is looking at an interactive-OAuth connection and must
 * refuse rather than send an unauthenticated request.
 */
export async function resolveTransportCredential(
  config: RemoteTransportConfig | undefined,
  workspaceId?: string,
): Promise<{ headers: Record<string, string>; fetch?: FetchLike }> {
  const headers = await buildRequestHeaders(config, workspaceId);
  const fetch = applyProviderAuth(config, headers, workspaceId);
  return fetch ? { headers, fetch } : { headers };
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
 * **Credential references** apply to every value in the outgoing header map —
 * `config.auth`'s bearer token / header value AND arbitrary entries in
 * `config.headers`. A value may be the secret itself or
 * `{ ref: "credential", key }`, dereferenced from the connection's workspace
 * scope on each build. A reference whose key is unset throws with the key and
 * scope named, rather than sending a blank header and reading the vendor's 401
 * a hop later.
 */
export async function createRemoteTransport(
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
): Promise<Transport> {
  const headers = await buildRequestHeaders(config, opts?.workspaceId);
  const mintingFetch = applyProviderAuth(config, headers, opts?.workspaceId);
  const effectiveAuthProvider = selectAuthProvider(config, authProvider);
  const transportFetch = selectTransportFetch(mintingFetch, effectiveAuthProvider);

  // SSRF redirect guard: the SDK transports follow redirects automatically
  // (fetch default `redirect: "follow"`). For a tenant-supplied remote URL,
  // that would let a hostile server 30x our fetch into the cluster network or
  // cloud metadata. Interpose manual, per-hop-validated redirect handling over
  // whatever fetch the transport would otherwise use (minting / OAuth-refresh /
  // global). A `minted` source is the operator-vetted fleet rail and may point at
  // an in-cluster `http://*.svc` endpoint, so its configured URL is validated
  // with `fleetInternal`. Redirect targets inherit it too — deliberately: hops
  // are same-origin only (`resolveRedirect`), which is the primary control, and
  // the per-hop `validateBundleUrl` is its backstop. Other credential providers
  // (brokered connectors) get no such exception at all.
  const guardedFetch: FetchLike = createSsrfGuardedFetch(transportFetch, {
    allowInsecure: opts?.allowInsecure ?? false,
    fleetInternal: isMintedFleetSource(config),
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
