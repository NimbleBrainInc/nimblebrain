import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, spyOn } from "bun:test";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { isMcpResourceMiss, McpSource } from "../../src/tools/mcp-source.ts";

/**
 * `readResource` must distinguish a genuine "resource not here" from a transport
 * failure. The old `catch { return null }` masked every error as a 404 with no
 * log, so a degraded source was undiagnosable. The contract now: a genuine MCP
 * miss stays a silent null; a real failure is logged — but ONLY on the
 * app-surface proxy path (`logFailures`), so discovery probes against a bundle
 * that simply lacks a `skill://` / `app://instructions` resource never spam,
 * whatever non-standard error shape that bundle returns.
 */
describe("isMcpResourceMiss — allowlist of genuine misses", () => {
  it("treats resource/method/params JSON-RPC errors as misses", () => {
    expect(isMcpResourceMiss(new McpError(-32002, "Resource not found"))).toBe(true);
    expect(isMcpResourceMiss(new McpError(-32601, "Method not found"))).toBe(true);
    expect(isMcpResourceMiss(new McpError(-32602, "Invalid params"))).toBe(true);
  });

  it("treats a not-found message (no code) as a miss", () => {
    expect(isMcpResourceMiss(new Error("Unknown resource ui://x"))).toBe(true);
    expect(isMcpResourceMiss(new Error("no such resource"))).toBe(true);
  });

  it("does NOT treat transport failures as misses", () => {
    expect(isMcpResourceMiss(new Error("Connection closed"))).toBe(false);
    expect(isMcpResourceMiss(new McpError(-32000, "Connection closed"))).toBe(false);
    expect(isMcpResourceMiss(new Error("fetch failed"))).toBe(false);
    expect(isMcpResourceMiss(new Error("request timed out"))).toBe(false);
  });

  it("is null/undefined safe", () => {
    expect(isMcpResourceMiss(null)).toBe(false);
    expect(isMcpResourceMiss(undefined)).toBe(false);
    expect(isMcpResourceMiss("nope")).toBe(false);
  });
});

describe("McpSource.readResource — log scoping (no probe spam)", () => {
  function makeSourceWithThrowingClient(err: unknown): McpSource {
    const source = new McpSource(
      "stub",
      { type: "remote", url: new URL("http://localhost:0/mcp") },
      new NoopEventSink(),
    );
    (source as unknown as { client: { readResource: () => Promise<unknown> } }).client = {
      readResource: async () => {
        throw err;
      },
    };
    // A torn transport now routes through recovery; with no backoff slots it
    // exhausts immediately (no real stop()/start(), no sleeps) and surfaces —
    // exactly the terminal (logged null / silent null) these tests assert.
    (source as unknown as { recoveryDelaysMs: readonly number[] }).recoveryDelaysMs = [];
    return source;
  }

  /** Did any `log.warn` (→ console.error, pretty mode) mention readResource? */
  function loggedReadFailure(spy: ReturnType<typeof spyOn>): boolean {
    return spy.mock.calls.some((call) => String(call[0]).includes("readResource"));
  }

  it("does NOT log a transport failure on a probe read (no logFailures)", async () => {
    const source = makeSourceWithThrowingClient(new Error("Connection closed"));
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await source.readResource("skill://x/usage")).toBeNull();
      expect(loggedReadFailure(spy)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("logs a transport failure on the app-surface path (logFailures)", async () => {
    const source = makeSourceWithThrowingClient(new Error("Connection closed"));
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await source.readResource("ui://x", { logFailures: true })).toBeNull();
      expect(loggedReadFailure(spy)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("does NOT log a genuine miss even on the app-surface path", async () => {
    const source = makeSourceWithThrowingClient(new McpError(-32002, "Resource not found"));
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await source.readResource("ui://x", { logFailures: true })).toBeNull();
      expect(loggedReadFailure(spy)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  /** A source whose MCP client was torn down (or never started): client === null. */
  function makeSourceWithNoClient(): McpSource {
    return new McpSource(
      "stub",
      { type: "remote", url: new URL("http://localhost:0/mcp") },
      new NoopEventSink(),
    );
  }

  it("does NOT log a torn-down client on the probe path", async () => {
    const source = makeSourceWithNoClient();
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await source.readResource("skill://x/usage")).toBeNull();
      expect(loggedReadFailure(spy)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("logs a torn-down client on the app-surface path (the persistent-404 incident)", async () => {
    const source = makeSourceWithNoClient();
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await source.readResource("ui://x", { logFailures: true })).toBeNull();
      expect(loggedReadFailure(spy)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("never throws — the 404 (null) contract holds for every caller", async () => {
    const miss = makeSourceWithThrowingClient(new McpError(-32002, "Resource not found"));
    const transport = makeSourceWithThrowingClient(new Error("Connection closed"));
    expect(await miss.readResource("ui://x")).toBeNull();
    expect(await transport.readResource("ui://x", { logFailures: true })).toBeNull();
  });
});

/**
 * The recovery half of issue #571: a remote bundle's `ui://` read must
 * re-initialize the session and retry after the server rolls, rather than
 * returning a null that strands the sidebar until a manual runtime bounce.
 * `tryRestart` is mocked so these stay unit-level (no real network / Bun.serve);
 * the faithful end-to-end roll is exercised in integration.
 */
describe("McpSource.readResource — remote session self-heal (issue #571)", () => {
  const sessionLost = {
    code: 404,
    message: 'Error POSTing to endpoint: {"code":-32001,"message":"Session not found"}',
  };

  function makeSource(readResource: () => Promise<unknown>): McpSource {
    const source = new McpSource(
      "stub",
      { type: "remote", url: new URL("http://localhost:0/mcp") },
      new NoopEventSink(),
    );
    (source as unknown as { client: { readResource: () => Promise<unknown> } }).client = {
      readResource,
    };
    return source;
  }

  it("re-initializes the session and retries on 'Session not found', returning content", async () => {
    let calls = 0;
    const source = makeSource(async () => {
      calls++;
      if (calls === 1) throw sessionLost;
      return { contents: [{ uri: "ui://stub/main", text: "<html>ok</html>" }] };
    });
    const restart = spyOn(
      source as unknown as { tryRestart: () => Promise<boolean> },
      "tryRestart",
    ).mockResolvedValue(true);
    try {
      const result = await source.readResource("ui://stub/main", { logFailures: true });
      expect(restart).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ text: "<html>ok</html>", mimeType: undefined, meta: undefined });
    } finally {
      restart.mockRestore();
    }
  });

  it("does NOT restart on a genuine resource miss", async () => {
    const source = makeSource(async () => {
      throw new McpError(-32002, "Resource not found");
    });
    const restart = spyOn(
      source as unknown as { tryRestart: () => Promise<boolean> },
      "tryRestart",
    ).mockResolvedValue(true);
    try {
      expect(await source.readResource("ui://stub/main", { logFailures: true })).toBeNull();
      expect(restart).not.toHaveBeenCalled();
    } finally {
      restart.mockRestore();
    }
  });

  it("exhausts retries, returns null, and marks the source dead for HealthMonitor", async () => {
    const source = makeSource(async () => {
      throw sessionLost;
    });
    const restart = spyOn(
      source as unknown as { tryRestart: () => Promise<boolean> },
      "tryRestart",
    ).mockResolvedValue(false);
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await source.readResource("ui://stub/main", { logFailures: true })).toBeNull();
      // One re-establish attempt per backoff slot.
      expect(restart).toHaveBeenCalledTimes(3);
      // Escalated to HealthMonitor: emitSourceCrashed flipped `dead`, so a stale
      // session that never closed the transport is now sweepable.
      expect(
        (source as unknown as { _isDeadForTesting: () => boolean })._isDeadForTesting(),
      ).toBe(true);
    } finally {
      spy.mockRestore();
      restart.mockRestore();
    }
  });
});
