import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "bun:test";
import {
  classifyConnectionFailure,
  type ConnectionFailure,
} from "../../src/tools/mcp-source.ts";

/**
 * The connection-failure taxonomy (research/SPEC-mcp-source-recovery.md) as pure,
 * tested data. `classifyConnectionFailure` is OP-INDEPENDENT — it returns only
 * connection-level classes; application outcomes (resource-miss vs app-error) are
 * op-scoped and stay in `isMcpResourceMiss`, so the resource-"miss" wire codes
 * (-32002/-32601/-32602) classify as "none" here. The recovery *policy* (what to
 * do with each class) is `policyFor`, consumed by `McpSource.recover`.
 */
describe("classifyConnectionFailure — op-independent connection classes", () => {
  const sessionLost404 = {
    code: 404,
    message: 'Error POSTing to endpoint: {"code":-32001,"message":"Session not found"}',
  };

  it("classifies session loss (canonical 404 + a non-canonical -32001)", () => {
    expect(classifyConnectionFailure(sessionLost404)).toBe("session-lost");
    expect(classifyConnectionFailure(new McpError(-32001, "Session not found"))).toBe(
      "session-lost",
    );
  });

  it("classifies the REAL production session-loss shape, status-independent", () => {
    // Ground truth (mcp/server/streamable_http_manager.py): the fleet servers'
    // Python SDK returns an unknown session as HTTP 404 with a -32600 body. The
    // client wraps it as StreamableHTTPError(code=404, message="...session not
    // found..."). The -32600 is body text, NOT err.code.
    const realProd = {
      code: 404,
      message:
        'Streamable HTTP error: Error POSTing to endpoint: {"jsonrpc":"2.0","id":"server-error","error":{"code":-32600,"message":"Session not found"}}',
    };
    expect(classifyConnectionFailure(realProd)).toBe("session-lost");
    // Same loss carried as an in-body JSON-RPC error (HTTP 200) → McpError(-32600).
    // The message match must win over the `-32600 → none` branch, or we'd strand it.
    expect(classifyConnectionFailure(new McpError(-32600, "Session not found"))).toBe(
      "session-lost",
    );
    // A non-spec remote returning the loss under a different status still recovers.
    expect(classifyConnectionFailure({ code: 400, message: "Session not found" })).toBe(
      "session-lost",
    );
  });

  it("classifies transient gateway failures (status + message shapes)", () => {
    for (const code of [502, 503, 504]) {
      expect(classifyConnectionFailure({ code, message: "x" })).toBe("transient");
    }
    expect(classifyConnectionFailure({ message: '{"error":"bad_gateway"}' })).toBe("transient");
    expect(classifyConnectionFailure(new Error("Service Unavailable"))).toBe("transient");
    expect(classifyConnectionFailure(new Error("Gateway Timeout"))).toBe("transient");
  });

  it("classifies auth loss only from UnauthorizedError", () => {
    expect(classifyConnectionFailure(new UnauthorizedError("nope"))).toBe("auth-lost");
  });

  it("classifies a torn transport", () => {
    expect(classifyConnectionFailure(new McpError(-32000, "Connection closed"))).toBe(
      "transport-dead",
    );
    expect(classifyConnectionFailure(new Error("fetch failed"))).toBe("transport-dead");
    expect(classifyConnectionFailure(new Error("socket hang up"))).toBe("transport-dead");
    expect(classifyConnectionFailure(new Error("read ECONNRESET"))).toBe("transport-dead");
    expect(classifyConnectionFailure(new Error("Request timed out"))).toBe("transport-dead");
  });

  it("returns 'none' for standard JSON-RPC protocol errors the server answered with", () => {
    // The transport is fine; restarting won't change the answer. (resource-miss
    // codes are also op-scoped — isMcpResourceMiss owns them per op.)
    expect(classifyConnectionFailure(new McpError(-32700, "Parse error"))).toBe("none");
    expect(classifyConnectionFailure(new McpError(-32600, "Invalid request"))).toBe("none");
    expect(classifyConnectionFailure(new McpError(-32601, "Method not found"))).toBe("none");
    expect(classifyConnectionFailure(new McpError(-32602, "Invalid params"))).toBe("none");
    expect(classifyConnectionFailure(new McpError(-32603, "Internal error"))).toBe("none");
    expect(classifyConnectionFailure(new McpError(-32002, "Resource not found"))).toBe("none");
  });

  it("classifies recognized torn-transport shapes as transport-dead", () => {
    expect(classifyConnectionFailure(new McpError(-32000, "Connection closed"))).toBe(
      "transport-dead",
    );
    expect(classifyConnectionFailure(new Error("write EPIPE"))).toBe("transport-dead");
    expect(classifyConnectionFailure(new Error("read ECONNRESET"))).toBe("transport-dead");
  });

  it("classifies an unclassifiable throw as 'unknown' (caller decides recover vs surface)", () => {
    // Not a standard protocol error, not a recognized transport shape — e.g. a
    // 429, a server-defined code, or a malformed-result parse error. The tool
    // path recovers these; reads surface them. See recover()'s recoverUnknown.
    expect(classifyConnectionFailure({ code: 429, message: "Too Many Requests" })).toBe("unknown");
    expect(classifyConnectionFailure(new McpError(-32050, "custom server error"))).toBe("unknown");
    expect(classifyConnectionFailure(new Error("Unexpected token < in JSON"))).toBe("unknown");
  });

  it("is null/non-object safe", () => {
    expect(classifyConnectionFailure(null)).toBe("none");
    expect(classifyConnectionFailure(undefined)).toBe("none");
    expect(classifyConnectionFailure("nope")).toBe("none");
  });
});

// Type-level guard: ConnectionFailure is exported and usable.
const _exhaustive: ConnectionFailure = "none";
void _exhaustive;
