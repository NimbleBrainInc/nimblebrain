import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, mock, spyOn } from "bun:test";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import type { EngineEvent, EventSink } from "../../src/engine/types.ts";
import { McpSource, type McpTransportMode, policyFor } from "../../src/tools/mcp-source.ts";
import type { WorkspaceOAuthProvider } from "../../src/tools/workspace-oauth-provider.ts";

/**
 * Phase 2 of the recovery redesign (research/SPEC-mcp-source-recovery.md): the
 * single `recover` path that both `execute` (tools/call) and `readResource` route
 * their catch through, driven by `classifyConnectionFailure` + `policyFor`. These
 * lock the intentional behavior CONVERGENCES that the unification introduces:
 *   - app/protocol errors on tools/call surface WITHOUT a futile restart
 *   - readResource now handles auth-loss (flips reauth_required) and recovers a
 *     torn transport — previously a silent null
 *   - the task-augmented no-retry invariant survives (policy-level)
 */

function remoteSource(opts: {
  callTool?: () => Promise<unknown>;
  readResource?: () => Promise<unknown>;
  notifyAuthLost?: () => void;
  delays?: readonly number[];
  sink?: EventSink;
}): McpSource {
  const authProvider =
    opts.notifyAuthLost === undefined
      ? undefined
      : ({ notifyAuthLost: opts.notifyAuthLost } as unknown as WorkspaceOAuthProvider);
  const mode: McpTransportMode = {
    type: "remote",
    url: new URL("https://svc.example.com/mcp"),
    ...(authProvider ? { authProvider } : {}),
  };
  const source = new McpSource("svc", mode, opts.sink ?? new NoopEventSink());
  const internal = source as unknown as {
    client: { callTool?: unknown; readResource?: unknown; close: () => Promise<void> };
    dead: boolean;
    start: () => Promise<void>;
    recoveryDelaysMs: readonly number[];
  };
  internal.client = {
    callTool: opts.callTool,
    readResource: opts.readResource,
    close: () => Promise.resolve(),
  };
  internal.dead = false;
  internal.start = () => Promise.resolve(); // neutralize real network on tryRestart
  // Only override the per-call-site budget when a test asks — otherwise exercise
  // the real production schedule (tool calls = one immediate retry).
  if (opts.delays !== undefined) internal.recoveryDelaysMs = opts.delays;
  return source;
}

function spyRestart(source: McpSource, result: boolean) {
  return spyOn(
    source as unknown as { tryRestart: () => Promise<boolean> },
    "tryRestart",
  ).mockResolvedValue(result);
}

describe("policyFor — recovery policy", () => {
  const reauthable = { idempotent: true, hasReauthableProvider: true };
  const idem = { idempotent: true, hasReauthableProvider: false };
  const task = { idempotent: false, hasReauthableProvider: false };

  it("re-establishes idempotent connection failures", () => {
    for (const k of ["session-lost", "transient", "transport-dead"] as const) {
      expect(policyFor(k, idem)).toBe("recover");
    }
  });

  it("surfaces every failure on a non-idempotent (task) op — the no-retry invariant", () => {
    for (const k of ["session-lost", "transient", "transport-dead"] as const) {
      expect(policyFor(k, task)).toBe("surface");
    }
  });

  it("auth-lost reauths only with a reauthable provider, else surfaces", () => {
    expect(policyFor("auth-lost", reauthable)).toBe("reauth");
    expect(policyFor("auth-lost", { idempotent: false, hasReauthableProvider: true })).toBe("reauth");
    expect(policyFor("auth-lost", idem)).toBe("surface");
    expect(policyFor("auth-lost", task)).toBe("surface");
  });
});

describe("execute (tools/call) — unified recovery", () => {
  it("surfaces an app/protocol error WITHOUT restarting (no futile crash-restart)", async () => {
    const source = remoteSource({
      callTool: () => Promise.reject(new McpError(-32601, "Method not found")),
    });
    const restart = spyRestart(source, true);
    try {
      const result = await source.execute("do_thing", {});
      expect(result.isError).toBe(true);
      expect(restart).not.toHaveBeenCalled(); // -32601 is "none" → surface, never restart
    } finally {
      restart.mockRestore();
    }
  });

  it("surfaces a request timeout WITHOUT restarting the source (no #581 cascade)", async () => {
    // A slow tool that times out must NOT restart the bundle — that would tear it
    // down for its sibling tools. Surface a clean error; source stays alive + no crash.
    const events: EngineEvent[] = [];
    const sink: EventSink = { emit: (e) => events.push(e) };
    const source = remoteSource({
      callTool: () => Promise.reject(new McpError(-32001, "Request timed out")),
      sink,
    });
    const restart = spyRestart(source, true);
    try {
      const result = await source.execute("web_fetch", {});
      expect(result.isError).toBe(true);
      expect(restart).not.toHaveBeenCalled(); // timeout → surface, never restart
      expect(events.filter((e) => (e.data as { event?: string }).event === "source.crashed")).toHaveLength(
        0,
      );
    } finally {
      restart.mockRestore();
    }
  });

  it("recovers a torn transport: re-establish + retry returns the result", async () => {
    let calls = 0;
    const source = remoteSource({
      callTool: () => {
        calls++;
        if (calls === 1) return Promise.reject(new Error("Connection closed"));
        return Promise.resolve({ content: [{ type: "text", text: "ok" }], isError: false });
      },
    });
    const restart = spyRestart(source, true);
    try {
      const result = await source.execute("do_thing", {});
      expect(result.isError).toBe(false);
      expect(result.content.map((c) => ("text" in c ? c.text : "")).join("")).toBe("ok");
      expect(restart).toHaveBeenCalledTimes(1);
    } finally {
      restart.mockRestore();
    }
  });

  it("retries a persistently-failing inline call at most ONCE (no replay tripling)", async () => {
    // A mutating tool that keeps failing must not be replayed N times — the
    // historical budget is one retry. No `delays` override → production
    // TOOL_CALL_RECOVERY_DELAYS ([0]) applies.
    let calls = 0;
    const source = remoteSource({
      callTool: () => {
        calls++;
        return Promise.reject(new Error("Connection closed"));
      },
    });
    const restart = spyRestart(source, true);
    try {
      const result = await source.execute("send_email", {});
      expect(result.isError).toBe(true);
      expect(calls).toBe(2); // 1 initial + exactly 1 retry
      expect(restart).toHaveBeenCalledTimes(1);
    } finally {
      restart.mockRestore();
    }
  });
});

describe("readResource — unified recovery (new behaviors)", () => {
  it("flips reauth_required on auth loss (was a silent null before)", async () => {
    const notifyAuthLost = mock(() => {});
    const source = remoteSource({
      readResource: () => Promise.reject(new UnauthorizedError("token rejected")),
      notifyAuthLost,
    });
    const restart = spyRestart(source, true);
    try {
      expect(await source.readResource("ui://svc/main", { logFailures: true })).toBeNull();
      expect(notifyAuthLost).toHaveBeenCalledTimes(1);
      expect(restart).not.toHaveBeenCalled(); // reauth, not restart
    } finally {
      restart.mockRestore();
    }
  });

  it("recovers a torn transport on a ui:// read (was a silent null before)", async () => {
    let calls = 0;
    const source = remoteSource({
      readResource: () => {
        calls++;
        if (calls === 1) return Promise.reject(new Error("fetch failed"));
        return Promise.resolve({ contents: [{ uri: "ui://svc/main", text: "<html>ok</html>" }] });
      },
    });
    const restart = spyRestart(source, true);
    try {
      const result = await source.readResource("ui://svc/main", { logFailures: true });
      expect(result?.text).toBe("<html>ok</html>");
      expect(restart).toHaveBeenCalledTimes(1);
    } finally {
      restart.mockRestore();
    }
  });

  it("a genuine miss discovered AFTER recovery stays a silent null (no spurious log)", async () => {
    // session lost → restart succeeds → the retry finds the resource genuinely
    // absent (-32002). That's a clean miss, not a failure: null, no warn log —
    // parity with the pre-unification readResourceWithRecovery.
    let calls = 0;
    const sessionLost = {
      code: 404,
      message: 'Error POSTing to endpoint: {"code":-32001,"message":"Session not found"}',
    };
    const source = remoteSource({
      readResource: () => {
        calls++;
        if (calls === 1) return Promise.reject(sessionLost);
        return Promise.reject(new McpError(-32002, "Resource not found"));
      },
    });
    const restart = spyRestart(source, true);
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await source.readResource("ui://svc/main", { logFailures: true })).toBeNull();
      expect(restart).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls.some((c) => String(c[0]).includes("readResource failed"))).toBe(false);
    } finally {
      spy.mockRestore();
      restart.mockRestore();
    }
  });

  it("does NOT restart or crash the source on an unclassifiable read error (no restart-storm)", async () => {
    // A malformed result / 429 / server-defined code is `unknown`; a read must
    // surface it as null — never tear down + re-init or mark the whole source
    // crashed (which would make HealthMonitor restart it on a per-read error).
    const spy = spyOn(console, "error").mockImplementation(() => {});
    for (const err of [{ code: 429, message: "Too Many Requests" }, new Error("Unexpected token < in JSON")]) {
      const events: EngineEvent[] = [];
      const sink: EventSink = { emit: (e) => events.push(e) };
      const source = remoteSource({ readResource: () => Promise.reject(err), sink });
      const restart = spyRestart(source, true);
      try {
        expect(await source.readResource("ui://svc/main", { logFailures: true })).toBeNull();
        expect(restart).not.toHaveBeenCalled();
        const crashed = events.filter(
          (e) => (e.data as { event?: string }).event === "source.crashed",
        );
        expect(crashed).toHaveLength(0);
      } finally {
        restart.mockRestore();
      }
    }
    spy.mockRestore();
  });
});
