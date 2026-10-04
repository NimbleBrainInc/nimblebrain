import { describe, expect, it } from "bun:test";
import { getConnectorRefValidator } from "../../src/config/index.ts";
import type { ConnectorRef, RemoteTransportConfig } from "../../src/connectors/runtime/types.ts";

describe("Remote transport — JSON Schema validation", () => {
  const validate = getConnectorRefValidator();

  function isValid(ref: Record<string, unknown>): boolean {
    return validate(ref) as boolean;
  }

  it("accepts a url connector with a serverName and refuses one missing either", () => {
    // Every connector is a remote MCP endpoint registered under its serverName.
    expect(isValid({ url: "https://example.com/mcp", serverName: "example" })).toBe(true);
    expect(isValid({ url: "https://example.com/mcp" })).toBe(false);
    expect(isValid({ url: "https://example.com/mcp", serverName: "" })).toBe(false);
    expect(isValid({ serverName: "example" })).toBe(false);
  });
});

describe("Remote transport — TypeScript types", () => {
  it("ConnectorRef url variant type-checks", () => {
    const ref: ConnectorRef = {
      url: "https://mcp.example.com/mcp",
      serverName: "example",
      transport: {
        type: "streamable-http",
        auth: { type: "bearer", token: "tok_123" },
      },
      ui: null,
    };
    expect("url" in ref).toBe(true);
  });

  it("RemoteTransportConfig with bearer auth type-checks", () => {
    const config: RemoteTransportConfig = {
      type: "streamable-http",
      auth: { type: "bearer", token: "my-token" },
      headers: { "X-Trace-Id": "abc123" },
      reconnection: {
        maxReconnectionDelay: 30000,
        initialReconnectionDelay: 1000,
        maxRetries: 5,
      },
      sessionId: "sess_xyz",
    };
    expect(config.type).toBe("streamable-http");
    expect(config.auth?.type).toBe("bearer");
    expect(config.reconnection?.maxRetries).toBe(5);
  });

  it("RemoteTransportConfig with header auth type-checks", () => {
    const config: RemoteTransportConfig = {
      auth: { type: "header", name: "Authorization", value: "ApiKey secret" },
    };
    expect(config.auth?.type).toBe("header");
  });

  it("RemoteTransportConfig with no auth type-checks", () => {
    const config: RemoteTransportConfig = {
      auth: { type: "none" },
    };
    expect(config.auth?.type).toBe("none");
  });

  it("RemoteTransportConfig minimal (all optional)", () => {
    const config: RemoteTransportConfig = {};
    expect(config.type).toBeUndefined();
    expect(config.auth).toBeUndefined();
  });
});
