import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { RemoteTransportConfig } from "../bundles/types.ts";

/**
 * Create a remote MCP transport from a URL and optional config.
 * Default transport: Streamable HTTP. Use type: "sse" for legacy SSE servers.
 */
export function createRemoteTransport(url: URL, config?: RemoteTransportConfig): Transport {
  const headers: Record<string, string> = { ...(config?.headers ?? {}) };

  if (config?.auth?.type === "bearer") {
    headers.Authorization = `Bearer ${config.auth.token}`;
  } else if (config?.auth?.type === "header") {
    headers[config.auth.name] = config.auth.value;
  }

  const requestInit: RequestInit = Object.keys(headers).length > 0 ? { headers } : {};

  if (config?.type === "sse") {
    return new SSEClientTransport(url, { requestInit });
  }

  return new StreamableHTTPClientTransport(url, {
    requestInit,
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
