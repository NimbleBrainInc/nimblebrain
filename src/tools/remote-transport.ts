import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { RemoteTransportConfig } from "../bundles/types.ts";
import { createMintingFetch, getDefaultServiceTokenCache } from "../oauth/tenant-key-mint.ts";

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
    /** Workspace of the connection — required for `auth.type: "tenant-key"`, the
     *  dimension the minted token is scoped to. Threaded from the McpSource's
     *  `BundleMcpContext`. */
    workspaceId?: string;
  },
): Transport {
  const headers: Record<string, string> = { ...(config?.headers ?? {}) };

  if (config?.auth?.type === "bearer") {
    headers.Authorization = `Bearer ${config.auth.token}`;
  } else if (config?.auth?.type === "header") {
    headers[config.auth.name] = config.auth.value;
  }
  // Single resolution pass over all headers (auth-derived + arbitrary).
  // Drops the previous double-pass — the explicit auth-branch resolves
  // above were just doing what this loop already does.
  for (const [k, v] of Object.entries(headers)) {
    headers[k] = resolveEnvTemplate(v);
  }

  // Machine-plane auth: mint a workspace-scoped service token on demand and
  // attach it as the transport's `fetch`. This is NOT a static header (the
  // token is short-lived and re-minted on expiry / 401) and it is NOT OAuth
  // (no interactive flow). Fail loud here if the connection's workspace or the
  // authorizer issuer is missing — a tenant-key bundle is unreachable without
  // both, and a downstream 401 would not name the cause.
  let mintingFetch: FetchLike | undefined;
  if (config?.auth?.type === "tenant-key") {
    const workspaceId = opts?.workspaceId;
    if (!workspaceId) {
      throw new Error(
        "tenant-key transport auth requires a workspaceId (the connection's workspace dimension)",
      );
    }
    const issuer = process.env.NB_FLEET_AUTHORIZER_ISSUER;
    if (!issuer) {
      throw new Error(
        "tenant-key transport auth requires NB_FLEET_AUTHORIZER_ISSUER (the mcp-authorizer issuer)",
      );
    }
    mintingFetch = createMintingFetch({
      cache: getDefaultServiceTokenCache(),
      issuer,
      workspace: workspaceId,
      audience: config.auth.audience,
      scope: config.auth.scope,
    }) as FetchLike;
  }

  // Only wire the OAuth provider if no static auth is configured. Static
  // auth is the simpler, explicit contract — don't second-guess it.
  const effectiveAuthProvider =
    config?.auth && config.auth.type !== "none" ? undefined : authProvider;

  const requestInit: RequestInit = Object.keys(headers).length > 0 ? { headers } : {};

  if (config?.type === "sse") {
    return new SSEClientTransport(url, {
      requestInit,
      authProvider: effectiveAuthProvider,
      fetch: mintingFetch,
    });
  }

  return new StreamableHTTPClientTransport(url, {
    requestInit,
    authProvider: effectiveAuthProvider,
    fetch: mintingFetch,
    reconnectionOptions: config?.reconnection
      ? {
          maxReconnectionDelay: config.reconnection.maxReconnectionDelay ?? 30_000,
          initialReconnectionDelay: config.reconnection.initialReconnectionDelay ?? 1_000,
          reconnectionDelayGrowFactor: 1.5,
          maxRetries: config.reconnection.maxRetries ?? 5,
        }
      : undefined,
    sessionId: config?.sessionId,
  });
}
