import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { RemoteTransportConfig } from "../bundles/types.ts";

/**
 * Create a remote MCP transport from a URL and optional config.
 * Default transport: Streamable HTTP. Use type: "sse" for legacy SSE servers.
 *
 * Auth precedence: static header auth (`config.auth`) wins if present. An
 * `authProvider` is only attached when no static auth is configured —
 * servers using API keys in headers don't trigger OAuth flows they might
 * not support. When attached, the MCP SDK handles discovery (RFC 9728),
 * dynamic client registration (RFC 7591), PKCE, and token refresh.
 */
export function createRemoteTransport(
  url: URL,
  config?: RemoteTransportConfig,
  authProvider?: OAuthClientProvider,
): Transport {
  const headers: Record<string, string> = { ...(config?.headers ?? {}) };

  if (config?.auth?.type === "bearer") {
    headers.Authorization = `Bearer ${config.auth.token}`;
  } else if (config?.auth?.type === "header") {
    headers[config.auth.name] = config.auth.value;
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
    });
  }

  return new StreamableHTTPClientTransport(url, {
    requestInit,
    authProvider: effectiveAuthProvider,
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
