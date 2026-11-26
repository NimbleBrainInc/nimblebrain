/**
 * The agent worker's own behavior, against fake vendor executables: the
 * arguments each backend passes, the API-key refusal, stream translation,
 * cancellation, a binary that cannot start, the worker's Host and Origin
 * check, and the bridge relaying MCP messages to the ACP client.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk/unstable";
import { createClaudeBackend } from "../src/subscription/backends/claude.ts";
import { createCodexBackend } from "../src/subscription/backends/codex.ts";
import {
  type Backend,
  BackendRefused,
  type TurnInput,
} from "../src/subscription/backends/types.ts";
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
    expect(err).toBeInstanceOf(BackendRefused);
    expect((err as BackendRefused).reason).toBe("api_key");
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
    await expect(run).rejects.toThrow("Claude Code could not be started");
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

  test("fails a turn that never completed", async () => {
    const { input } = turn();
    const run = createCodexBackend({ bin: fakeBin(CODEX_TURN.slice(0, 3)).bin }).run(input);
    await expect(run).rejects.toThrow("without finishing the turn");
  });

  test("fails a turn whose binary cannot start", async () => {
    const { input } = turn();
    const run = createCodexBackend({ bin: join(dir, "no-such-codex") }).run(input);
    await expect(run).rejects.toThrow("Codex could not be started");
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
    preflight: async () => ({ describe: "fake" }),
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
