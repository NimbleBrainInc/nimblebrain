/**
 * The agent worker's own behavior, against fake vendor executables: the
 * arguments each backend passes, the API-key refusal, stream translation,
 * cancellation, a binary that cannot start, the worker's Host and Origin
 * check, and the bridge relaying MCP messages to the ACP client.
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk/unstable";
import { entryScript } from "../src/deps.ts";
import {
  createWorkerAgent,
  MODEL_META_KEY,
  PLAN_META_KEY,
  SESSION_META_KEY,
} from "../src/subscription/agent.ts";
import { createClaudeBackend } from "../src/subscription/backends/claude.ts";
import { createCodexBackend } from "../src/subscription/backends/codex.ts";
import {
  FAILURE_META_KEY,
  redact,
  resetOf,
  TurnFailed,
} from "../src/subscription/backends/failure.ts";
import type { Backend, TurnInput } from "../src/subscription/backends/types.ts";
import { createBridge } from "../src/subscription/bridge.ts";
import { serveWorker } from "../src/subscription/worker.ts";

const dir = mkdtempSync(join(tmpdir(), "nb-subscription-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
/** A fake vendor CLI: records its arguments and environment, then prints `lines`. */
function fakeBin(
  lines: object[],
  tail = "",
): { bin: string; args: () => string[]; env: () => string } {
  const id = n++;
  const bin = join(dir, `bin-${id}`);
  const argsFile = join(dir, `args-${id}`);
  const envFile = join(dir, `env-${id}`);
  const out = lines.map((l) => `printf '%s\\n' '${JSON.stringify(l)}'`).join("\n");
  writeFileSync(
    bin,
    `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\nenv > '${envFile}'\ncat > /dev/null\n${out}\n${tail}\n`,
  );
  chmodSync(bin, 0o755);
  return {
    bin,
    args: () => readFileSync(argsFile, "utf8").split("\n").slice(0, -1),
    env: () => readFileSync(envFile, "utf8"),
  };
}

function turn(signal = new AbortController().signal) {
  const updates: acp.SessionUpdate[] = [];
  const input: TurnInput = {
    prompt: "hello",
    system: "be brief",
    purpose: "turn",
    mcpUrl: "http://127.0.0.1:1/mcp/token",
    signal,
    emit: (u) => updates.push(u),
  };
  return { input, updates };
}

const CLAUDE_INIT = { type: "system", subtype: "init", apiKeySource: "none" };
const CLAUDE_TURN = [
  CLAUDE_INIT,
  {
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } },
  },
  {
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "t1", name: "mcp__nimblebrain__nb__status" }] },
  },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1" }] } },
  {
    type: "result",
    subtype: "success",
    usage: { input_tokens: 10, output_tokens: 3 },
    modelUsage: { "claude-x": { inputTokens: 10, outputTokens: 3 } },
  },
];

describe("the Claude Code backend", () => {
  test("runs print mode with only the session's server, never --bare, without API keys", async () => {
    const fake = fakeBin(CLAUDE_TURN);
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-test-not-for-the-child";
    try {
      const { input } = turn();
      await createClaudeBackend({ bin: fake.bin }).run(input);
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
    const args = fake.args();
    expect(args).toContain("-p");
    expect(args).not.toContain("--bare");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--system-prompt") + 1]).toBe("be brief");
    expect(JSON.parse(args[args.indexOf("--mcp-config") + 1] ?? "")).toEqual({
      mcpServers: { nimblebrain: { type: "http", url: "http://127.0.0.1:1/mcp/token" } },
    });
    expect(fake.env()).not.toContain("ANTHROPIC_API_KEY");
  });

  test("a normal turn runs on the chosen model with the session's server allowed", async () => {
    const fake = fakeBin(CLAUDE_TURN);
    await createClaudeBackend({ bin: fake.bin, model: "sonnet" }).run(turn().input);
    const args = fake.args();
    expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("mcp__nimblebrain");
  });

  test("an internal run attaches no MCP server and runs on Haiku, whatever the turn model", async () => {
    const fake = fakeBin(CLAUDE_TURN);
    const { input } = turn();
    const { mcpUrl: _, ...rest } = input;
    await createClaudeBackend({ bin: fake.bin, model: "opus" }).run({
      ...rest,
      purpose: "internal",
    });
    const args = fake.args();
    expect(JSON.parse(args[args.indexOf("--mcp-config") + 1] ?? "")).toEqual({ mcpServers: {} });
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args).not.toContain("--allowedTools");
    expect(args[args.indexOf("--model") + 1]).toBe("haiku");
    expect(args.filter((a) => a === "--model")).toHaveLength(1);
  });

  test("translates the stream into session updates and usage", async () => {
    const { input, updates } = turn();
    const result = await createClaudeBackend({ bin: fakeBin(CLAUDE_TURN).bin }).run(input);
    expect(updates).toEqual([
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi" } },
      {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "nb__status",
        kind: "other",
        status: "in_progress",
        rawInput: undefined,
      },
      { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" },
    ]);
    expect(result.stopReason).toBe("end_turn");
    expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 3 });
    expect(result.calls).toEqual([
      {
        model: "claude-code-subscription:claude-x",
        purpose: "turn",
        usage: { inputTokens: 10, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    ]);
  });

  test("stops a turn whose init line names an API key, before translating anything", async () => {
    const lines = [{ ...CLAUDE_INIT, apiKeySource: "ANTHROPIC_API_KEY" }, ...CLAUDE_TURN.slice(1)];
    const { input, updates } = turn();
    const run = createClaudeBackend({ bin: fakeBin(lines).bin }).run(input);
    const err = await run.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TurnFailed);
    expect((err as TurnFailed).code).toBe("api_key");
    expect(updates).toEqual([]);
  });

  test("answers cancelled when the turn is aborted", async () => {
    const abort = new AbortController();
    const { input } = turn(abort.signal);
    const run = createClaudeBackend({ bin: fakeBin([CLAUDE_INIT], "exec sleep 30").bin }).run(
      input,
    );
    setTimeout(() => abort.abort(), 100);
    expect((await run).stopReason).toBe("cancelled");
  });

  test("fails a turn whose binary cannot start", async () => {
    const { input } = turn();
    const run = createClaudeBackend({ bin: join(dir, "no-such-claude") }).run(input);
    await expect(run).rejects.toMatchObject({ code: "cli_missing" });
    await expect(run).rejects.toThrow("https://claude.com/claude-code");
  });
});

describe("the Codex backend", () => {
  const CODEX_TURN = [
    { type: "item.started", item: { id: "c1", type: "mcp_tool_call", tool: "nb__status" } },
    { type: "item.completed", item: { id: "c1", type: "mcp_tool_call", status: "completed" } },
    { type: "item.completed", item: { id: "m1", type: "agent_message", text: "Done" } },
    { type: "turn.completed", usage: { input_tokens: 7, output_tokens: 2 } },
  ];

  test("runs exec without the person's config, and translates its events", async () => {
    const fake = fakeBin(CODEX_TURN);
    const { input, updates } = turn();
    const result = await createCodexBackend({ bin: fake.bin }).run(input);
    const args = fake.args();
    expect(args.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(args).toContain("--ignore-user-config");
    expect(args[args.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(args).toContain(`mcp_servers.nimblebrain.url="http://127.0.0.1:1/mcp/token"`);
    expect(updates.map((u) => u.sessionUpdate)).toEqual([
      "tool_call",
      "tool_call_update",
      "agent_message_chunk",
    ]);
    expect(result).toMatchObject({
      stopReason: "end_turn",
      usage: { inputTokens: 7, outputTokens: 2 },
    });
  });

  test("an internal run names no MCP server and keeps the turn model", async () => {
    const fake = fakeBin(CODEX_TURN);
    const { mcpUrl: _, ...rest } = turn().input;
    await createCodexBackend({ bin: fake.bin, model: "gpt-x" }).run({
      ...rest,
      purpose: "internal",
    });
    const args = fake.args();
    expect(args.some((a) => a.startsWith("mcp_servers."))).toBe(false);
    expect(args[args.indexOf("-m") + 1]).toBe("gpt-x");
  });

  test("fails a turn that never completed", async () => {
    const { input } = turn();
    const run = createCodexBackend({ bin: fakeBin(CODEX_TURN.slice(0, 3)).bin }).run(input);
    await expect(run).rejects.toThrow("without finishing the turn");
    await expect(run).rejects.toMatchObject({ code: "cli_failed" });
  });

  test("fails a turn whose binary cannot start", async () => {
    const { input } = turn();
    const run = createCodexBackend({ bin: join(dir, "no-such-codex") }).run(input);
    await expect(run).rejects.toMatchObject({ code: "cli_missing" });
    await expect(run).rejects.toThrow("npm i -g @openai/codex");
  });
});

/** A GET to the worker with the given headers, answering its status. */
function get(port: number, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("the worker", () => {
  const backend: Backend = {
    id: "claude-code",
    label: "Fake",
    takesSystemPrompt: true,
    toolsAreNimbleBrainOnly: true,
    preflight: async () => ({ describe: "fake", plan: "Fake" }),
    run: async () => ({
      stopReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0 },
      calls: [],
    }),
  };

  test("answers this machine's Host names and refuses another Host or a browser Origin", async () => {
    const worker = await serveWorker(backend, 0);
    const port = Number(new URL(worker.acpUrl).port);
    try {
      expect(await get(port, "/healthz", { host: `127.0.0.1:${port}` })).toBe(200);
      expect(await get(port, "/healthz", { host: `localhost:${port}` })).toBe(200);
      expect(await get(port, "/healthz", { host: `host.docker.internal:${port}` })).toBe(200);
      expect(await get(port, "/acp", { host: `evil.example:${port}` })).toBe(403);
      expect(await get(port, "/healthz", { host: `evil.example:${port}` })).toBe(403);
      expect(
        await get(port, "/acp", { host: `127.0.0.1:${port}`, origin: "http://evil.example" }),
      ).toBe(403);
    } finally {
      await worker.stop();
    }
  });
});

describe("the bridge", () => {
  test("relays a request and a notification to the session's ACP client", async () => {
    const requests: unknown[] = [];
    const notes: unknown[] = [];
    // biome-ignore lint/plugin/double-cast: a fake with only the two methods the bridge calls, claimed as the whole ACP context
    const client = {
      request: async (method: string, params: unknown) => {
        requests.push({ method, params });
        return { result: { tools: [] } };
      },
      notify: async (method: string, params: unknown) => {
        notes.push({ method, params });
      },
    } as unknown as acp.AgentContext;
    let base = "";
    const bridge = createBridge(() => base);
    const http = createServer((req, res) => void bridge.handle(req, res));
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    const { url, release } = bridge.bind(client, "srv-1");
    try {
      const answer = await fetch(url, {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" }),
      });
      expect(await answer.json()).toEqual({ jsonrpc: "2.0", id: 4, result: { tools: [] } });
      expect(requests).toEqual([
        {
          method: "mcp/message",
          params: { serverId: "srv-1", requestId: "4", method: "tools/list" },
        },
      ]);
      const note = await fetch(url, {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      });
      expect(note.status).toBe(202);
      expect(notes).toEqual([
        {
          method: "mcp/message",
          params: { serverId: "srv-1", method: "notifications/initialized", params: undefined },
        },
      ]);
      release();
      expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(404);
    } finally {
      http.close();
    }
  });
});

/**
 * Turn failures, from what the CLIs print. The signed-out lines are what
 * `claude -p --output-format stream-json` (2.1) and `codex exec --json`
 * (0.162) print with an empty CLAUDE_CONFIG_DIR / CODEX_HOME.
 */
describe("why a turn failed", () => {
  const CLAUDE_SIGNED_OUT = [
    { type: "system", subtype: "init", apiKeySource: "none" },
    {
      type: "assistant",
      error: "authentication_failed",
      is_api_error_message: true,
      message: { content: [{ type: "text", text: "Not logged in · Please run /login" }] },
    },
    {
      type: "result",
      subtype: "success",
      is_error: true,
      terminal_reason: "api_error",
      result: "Not logged in · Please run /login",
    },
  ];
  const CODEX_401 =
    "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses";

  const failure = async (backend: Backend) => {
    const err = await backend.run(turn().input).then(
      () => undefined,
      (e: unknown) => e,
    );
    return err as { code: string; message: string };
  };

  test("Claude Code signed out is signed_out, naming claude /login", async () => {
    const f = await failure(createClaudeBackend({ bin: fakeBin(CLAUDE_SIGNED_OUT, "exit 1").bin }));
    expect(f.code).toBe("signed_out");
    expect(f.message).toContain("`claude /login`");
  });

  test("Claude Code at its plan's limit is plan_limit, with the reset time", async () => {
    const lines = [
      { type: "system", subtype: "init", apiKeySource: "none" },
      { type: "assistant", error: "rate_limit", message: { content: [] } },
      {
        type: "result",
        subtype: "success",
        is_error: true,
        result: "You’ve hit your limit · resets 3pm (Pacific/Honolulu)",
      },
    ];
    const f = await failure(createClaudeBackend({ bin: fakeBin(lines, "exit 1").bin }));
    expect(f.code).toBe("plan_limit");
    expect(f.message).toContain(
      "Your Claude plan has reached its usage limit (it resets 3pm (Pacific/Honolulu))",
    );
  });

  test("a Claude turn that would bill an API key is api_key", async () => {
    const lines = [{ type: "system", subtype: "init", apiKeySource: "ANTHROPIC_API_KEY" }];
    const f = await failure(createClaudeBackend({ bin: fakeBin(lines, "exec sleep 30").bin }));
    expect(f.code).toBe("api_key");
    expect(f.message).toContain("source: ANTHROPIC_API_KEY");
  });

  test("anything else is cli_failed: its exit, its last line without secrets, and the log", async () => {
    const tail = `echo 'starting' >&2\necho 'boom: Bearer abc.def ANTHROPIC_API_KEY=sk-ant-0123456789abcdef' >&2\nexit 3`;
    const backend = createClaudeBackend({ bin: fakeBin([], tail).bin, log: "/h/agent-worker.log" });
    const f = await failure(backend);
    expect(f.code).toBe("cli_failed");
    expect(f.message).toStartWith("Claude Code exited (3) without finishing the turn: boom:");
    expect(f.message).toContain("Check /h/agent-worker.log");
    expect(f.message).not.toContain("abc.def");
    expect(f.message).not.toContain("sk-ant-0123456789abcdef");
  });

  test("Codex signed out (401) is signed_out, naming codex login", async () => {
    const events = [
      { type: "turn.started" },
      { type: "error", message: `Reconnecting... 1/5 (${CODEX_401})` },
      { type: "turn.failed", error: { message: CODEX_401 } },
    ];
    const f = await failure(createCodexBackend({ bin: fakeBin(events, "exit 1").bin }));
    expect(f.code).toBe("signed_out");
    expect(f.message).toContain("`codex login`");
  });

  test("Codex at its plan's limit is plan_limit, with when to try again", async () => {
    const limit =
      "You’ve hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing) or try again in 2 hours 5 minutes.";
    const events = [{ type: "turn.failed", error: { message: limit } }];
    const f = await failure(createCodexBackend({ bin: fakeBin(events, "exit 1").bin }));
    expect(f.code).toBe("plan_limit");
    expect(f.message).toContain(
      "ChatGPT plan has reached its usage limit (try again in 2 hours 5 minutes)",
    );
  });

  test("a Codex turn that completes after a retried error succeeded", async () => {
    const events = [
      { type: "error", message: "Reconnecting... 1/5 (stream disconnected)" },
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
    ];
    const result = await createCodexBackend({ bin: fakeBin(events).bin }).run(turn().input);
    expect(result.stopReason).toBe("end_turn");
  });

  test("reset times read in each CLI's words, and secrets never survive", () => {
    expect(resetOf("Claude AI usage limit reached|1700000000")).toStartWith("it resets ");
    expect(resetOf("try again at 3:05 PM.")).toBe("try again at 3:05 PM");
    expect(resetOf("no time here")).toBeUndefined();
    expect(redact("token eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ4In0.sig and sk-proj-abcdefghij")).toBe(
      "token [redacted] and [redacted]",
    );
  });
});

describe("the worker's ACP agent", () => {
  const fake = (run: Backend["run"]): Backend => ({
    id: "claude-code",
    label: "Claude Code",
    takesSystemPrompt: true,
    toolsAreNimbleBrainOnly: true,
    preflight: async () => ({ describe: "fake", plan: "Claude Max" }),
    run,
  });

  async function connect(backend: Backend) {
    const agent = createWorkerAgent(
      backend,
      createBridge(() => "http://127.0.0.1:1"),
      "Claude Max",
    );
    const connection = acp.client({ name: "test" }).connect(agent);
    const init = await connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    const { sessionId } = await connection.agent.request(acp.methods.agent.session.new, {
      cwd: "/",
      mcpServers: [{ type: "acp", serverId: "s1", name: "nimblebrain" } as acp.McpServer],
    });
    return { connection, init, sessionId };
  }

  test("names its turn model at initialize, beside the plan", async () => {
    const backend = {
      ...fake(async () => ({
        stopReason: "end_turn" as const,
        usage: { inputTokens: 0, outputTokens: 0 },
        calls: [],
      })),
      modelLabel: "Sonnet",
    };
    const { connection, init } = await connect(backend);
    expect(init._meta).toEqual({ [PLAN_META_KEY]: "Claude Max", [MODEL_META_KEY]: "Sonnet" });
    connection.close();
  });

  test("an internal session gets no bridge and runs as internal; a normal one gets its server", async () => {
    const seen: TurnInput[] = [];
    const backend = fake(async (input) => {
      seen.push(input);
      return { stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, calls: [] };
    });
    const { connection, sessionId } = await connect(backend);
    const internal = await connection.agent.request(acp.methods.agent.session.new, {
      cwd: "/",
      mcpServers: [],
      _meta: { [SESSION_META_KEY]: { purpose: "internal" } },
    });
    for (const id of [sessionId, internal.sessionId])
      await connection.agent.request(acp.methods.agent.session.prompt, {
        sessionId: id,
        prompt: [{ type: "text", text: "hi" }],
      });
    expect(seen[0]?.purpose).toBe("turn");
    expect(seen[0]?.mcpUrl).toStartWith("http://127.0.0.1:1/mcp/");
    expect(seen[1]?.purpose).toBe("internal");
    expect(seen[1]?.mcpUrl).toBeUndefined();
    connection.close();
  });

  test("a normal session still needs its acp server", async () => {
    const { connection } = await connect(
      fake(async () => ({
        stopReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0 },
        calls: [],
      })),
    );
    await expect(
      connection.agent.request(acp.methods.agent.session.new, { cwd: "/", mcpServers: [] }),
    ).rejects.toBeDefined();
    connection.close();
  });

  test("names its plan at initialize", async () => {
    const { connection, init } = await connect(
      fake(async () => ({
        stopReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0 },
        calls: [],
      })),
    );
    expect(init._meta?.[PLAN_META_KEY]).toBe("Claude Max");
    expect(init.agentInfo?.name).toBe("nimblebrain-subscription-claude-code");
    connection.close();
  });

  test("a failed turn carries {code, message} for the runtime", async () => {
    const { connection, sessionId } = await connect(
      fake(async () => {
        throw new TurnFailed(
          "signed_out",
          "Claude Code is signed out. Run `claude /login` in a terminal, then send your message again.",
        );
      }),
    );
    const err = await connection.agent
      .request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "hi" }],
      })
      .then(
        () => undefined,
        (e: unknown) => e as { data?: Record<string, unknown> },
      );
    expect(err?.data?.[FAILURE_META_KEY]).toEqual({
      code: "signed_out",
      message:
        "Claude Code is signed out. Run `claude /login` in a terminal, then send your message again.",
    });
    connection.close();
  });

  test("an unexpected error is cli_failed, saying nothing of its internals", async () => {
    const { connection, sessionId } = await connect(
      fake(async () => {
        throw new Error("internal path /secret/thing");
      }),
    );
    const err = await connection.agent
      .request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "hi" }],
      })
      .then(
        () => undefined,
        (e: unknown) => e as { data?: Record<string, unknown> },
      );
    const f = err?.data?.[FAILURE_META_KEY] as { code: string; message: string };
    expect(f.code).toBe("cli_failed");
    expect(f.message).not.toContain("/secret/thing");
    connection.close();
  });
});

describe("the CLI's own file", () => {
  test("npx's .bin link resolves to the bundle it points at, which the login item copies", () => {
    const pkg = join(dir, "_npx", "9f", "node_modules");
    mkdirSync(join(pkg, "nimblebrain", "dist"), { recursive: true });
    mkdirSync(join(pkg, ".bin"), { recursive: true });
    const bundle = join(pkg, "nimblebrain", "dist", "nimblebrain.js");
    writeFileSync(bundle, "// bundle\n");
    symlinkSync("../nimblebrain/dist/nimblebrain.js", join(pkg, ".bin", "nimblebrain"));
    expect(entryScript(join(pkg, ".bin", "nimblebrain"))).toBe(realpathSync(bundle));
    expect(entryScript(join(dir, "missing.js"))).toBe(join(dir, "missing.js"));
  });
});
