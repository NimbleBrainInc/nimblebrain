import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { describe, expect, it, mock } from "bun:test";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";
import type { McpTransportMode } from "../../src/tools/mcp-source.ts";
import type { WorkspaceOAuthProvider } from "../../src/tools/workspace-oauth-provider.ts";

// Detect-on-use: a remote tool call that throws UnauthorizedError means the
// connection's refresh token was rejected (expired / revoked). The execute()
// catch must treat that as "needs reconnection" — NOT a crash. It flips the
// connection to reauth_required via the provider's notifyAuthLost, returns a
// structured reauth error, and does NOT route through the crash/restart path
// (a restart can't fix a dead credential, and would escalate toward `dead`).

function startedRemoteSource(opts: {
  callTool: () => Promise<unknown>;
  notifyAuthLost: () => void;
}): McpSource {
  const authProvider = {
    notifyAuthLost: opts.notifyAuthLost,
  } as unknown as WorkspaceOAuthProvider;

  const mode: McpTransportMode = {
    type: "remote",
    url: new URL("https://teams.example.com/mcp"),
    authProvider,
  };
  const source = new McpSource("teams", mode, new NoopEventSink());

  // Drive execute() down callToolInline with a client that fails on auth.
  // No real transport — we exercise the catch branch in isolation. `close`
  // is stubbed so the non-auth crash path's stop() doesn't blow up, and
  // `start` is neutralized so tryRestart never reaches the network.
  const internal = source as unknown as {
    client: { callTool: () => Promise<unknown>; close: () => Promise<void> };
    dead: boolean;
    start: () => Promise<void>;
  };
  internal.client = { callTool: opts.callTool, close: () => Promise.resolve() };
  internal.dead = false;
  internal.start = () => Promise.resolve();
  return source;
}

describe("McpSource — auth loss on a tool call (detect-on-use)", () => {
  it("UnauthorizedError → structured reauth_required result + notifyAuthLost", async () => {
    const notifyAuthLost = mock(() => {});
    const source = startedRemoteSource({
      callTool: () => Promise.reject(new UnauthorizedError("token rejected")),
      notifyAuthLost,
    });

    const result = await source.execute("send_message", { text: "hi" });

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.reason).toBe("reauth_required");
    expect(result.structuredContent?.error).toBe("auth_required");
    expect(notifyAuthLost).toHaveBeenCalledTimes(1);
    // Must NOT have fallen through to the crash/restart copy.
    const text = result.content.map((c) => ("text" in c ? c.text : "")).join(" ");
    expect(text).not.toMatch(/crashed|restart/i);
    expect(text).toMatch(/reconnect/i);
  });

  it("a non-auth tool-call error still goes through the crash path (not reauth)", async () => {
    const notifyAuthLost = mock(() => {});
    const source = startedRemoteSource({
      callTool: () => Promise.reject(new Error("some transport blip")),
      notifyAuthLost,
    });

    const result = await source.execute("send_message", {});

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.reason).not.toBe("reauth_required");
    expect(notifyAuthLost).not.toHaveBeenCalled();
  });
});
