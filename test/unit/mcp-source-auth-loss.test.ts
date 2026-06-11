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
  // Omit to model a static-auth remote (e.g. a Composio x-api-key bundle)
  // that has no OAuth provider — the reauth branch must NOT fire for it.
  notifyAuthLost?: () => void;
}): McpSource {
  const authProvider =
    opts.notifyAuthLost === undefined
      ? undefined
      : ({ notifyAuthLost: opts.notifyAuthLost } as unknown as WorkspaceOAuthProvider);

  const mode: McpTransportMode = {
    type: "remote",
    url: new URL("https://teams.example.com/mcp"),
    ...(authProvider ? { authProvider } : {}),
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

  it("UnauthorizedError on a static-auth remote (no provider) does NOT show reauth", async () => {
    // A Composio bundle authenticates with a static x-api-key header — no
    // OAuth provider. A 401 there is a bad operator credential, not a
    // user-reconnectable token: the branch is gated on authProvider, so it
    // falls through to the normal error path instead of a misleading
    // "Reconnect" message.
    const source = startedRemoteSource({
      callTool: () => Promise.reject(new UnauthorizedError("bad api key")),
      // no notifyAuthLost → no authProvider on the mode
    });

    const result = await source.execute("send_message", {});

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.reason).not.toBe("reauth_required");
    const text = result.content.map((c) => ("text" in c ? c.text : "")).join(" ");
    expect(text).not.toMatch(/reconnect/i);
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
