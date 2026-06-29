import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "bun:test";
import {
  classifyConnectionFailure,
  type ConnectionFailure,
  isSessionLost,
  isTransientTransport,
} from "../../src/tools/mcp-source.ts";

/**
 * Phase 1 of the recovery redesign (research/SPEC-mcp-source-recovery.md): the
 * connection-failure taxonomy as pure, tested data. Two invariants:
 *  1. classifyConnectionFailure is OP-INDEPENDENT — it returns only
 *     connection-level classes; application outcomes (resource-miss vs app-error)
 *     are op-scoped and stay in isMcpResourceMiss. So the resource-"miss" wire
 *     codes (-32002/-32601/-32602) classify as "none" here.
 *  2. isSessionLost / isTransientTransport are now thin views of the classifier
 *     and MUST stay byte-identical to their pre-extraction behavior (the
 *     readResource contract in mcp-source-resource-errors.test.ts depends on it).
 *
 * The recovery *policy* (what to do with each class) lands in Phase 2 with the
 * `withRecovery` wrapper that consumes it — abstractions ship with their caller.
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

describe("isSessionLost / isTransientTransport — thin views, behavior preserved", () => {
  it("isSessionLost is exactly the session-lost class", () => {
    expect(isSessionLost({ code: 404, message: "Session not found" })).toBe(true);
    expect(isSessionLost(new McpError(-32001, "Session not found"))).toBe(true);
    expect(isSessionLost({ code: 404, message: "Not Found" })).toBe(false);
    expect(isSessionLost(new McpError(-32002, "Resource not found"))).toBe(false);
    expect(isSessionLost(new Error("Connection closed"))).toBe(false);
    expect(isSessionLost(null)).toBe(false);
  });

  it("isTransientTransport is exactly the transient class", () => {
    for (const code of [502, 503, 504]) expect(isTransientTransport({ code, message: "x" })).toBe(true);
    expect(isTransientTransport({ message: '{"error":"bad_gateway"}' })).toBe(true);
    expect(isTransientTransport({ code: 404, message: "Session not found" })).toBe(false);
    expect(isTransientTransport(new Error("Connection closed"))).toBe(false);
    expect(isTransientTransport(null)).toBe(false);
  });
});

// Type-level guard: ConnectionFailure is exported and usable.
const _exhaustive: ConnectionFailure = "none";
void _exhaustive;
