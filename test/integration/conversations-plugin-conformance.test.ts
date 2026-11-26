/**
 * The conversations plugin (`packages/conversations/`) is a conformant implementation of
 * the conversations contract.
 *
 * Starts the plugin's own command over Streamable HTTP in a temporary data directory and
 * runs the contract's black-box runner against it:
 *
 * - the whole contract, with the host context in request metadata as the host states it:
 *   every tool, the walls, `forbidden` for every private tool as a person and for a call
 *   that names no principal, `forbidden` before input and scope, and `delete_workspace` in
 *   a scratch workspace. Every case must pass.
 * - the public-only mode, the check for a host's agent-facing surface. The plugin is the
 *   implementation, not such a surface, so it lists its private tools: that case is the
 *   one expected failure, and every other case must pass.
 *
 * Also: a request without the host's credential is refused before any tool runs, and the
 * stdio transport (how `mcp.json` starts the server) carries the context in `_meta`.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { type Subprocess, spawn } from "bun";
import {
  type CaseResult,
  PRIVATE_TOOLS,
  PUBLIC_TOOLS,
  runConformance,
} from "../../contracts/conversations/runner/conformance.ts";

const BIN = resolve(import.meta.dir, "../../packages/conversations/bin/nb-conversations");
const TOKEN = "conformance-token";
const WORKSPACE = "ws_a1a1a1a1a1a1a1a1";
const SCRATCH = "ws_b2b2b2b2b2b2b2b2";
const OWNER = "usr_conformance";
const AUTH = { authorization: `Bearer ${TOKEN}` };

/** Public-only mode against an implementation: it serves the private tools it implements. */
const PUBLIC_ONLY_EXPECTED_FAILURE = "no private tool is listed";

let dataDir: string;
let proc: Subprocess<"ignore", "pipe", "pipe">;
let url: string;

async function readListening(p: Subprocess<"ignore", "pipe", "pipe">): Promise<string> {
  const reader = p.stdout.getReader();
  let text = "";
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
    const m = /listening (\S+)/.exec(text);
    if (m) {
      reader.releaseLock();
      return m[1] as string;
    }
  }
  throw new Error(`the server never said it was listening: ${text}`);
}

const failures = (results: CaseResult[]) =>
  results.filter((r) => r.status === "fail").map((r) => `${r.name}: ${r.detail}`);

function serve(dir: string): Subprocess<"ignore", "pipe", "pipe"> {
  return spawn(["bun", "--no-env-file", BIN, "--data-dir", dir, "--http", "0"], {
    env: { PATH: process.env.PATH ?? "", NB_CONVERSATIONS_TOKEN: TOKEN },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

beforeAll(async () => {
  // An empty data directory: a workspace the host stamps exists, and the plugin makes its
  // storage on first use.
  dataDir = mkdtempSync(join(tmpdir(), "conversations-plugin-"));
  proc = serve(dataDir);
  url = await readListening(proc);
}, 30_000);

afterAll(() => {
  proc?.kill();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

describe("conversations plugin: the whole contract", () => {
  it("passes every case with the host context in _meta", async () => {
    const results = await runConformance({
      server: url,
      headers: AUTH,
      carriage: "meta",
      workspace: WORKSPACE,
      owner: OWNER,
      scratchWorkspace: SCRATCH,
    });
    expect(failures(results)).toEqual([]);
    expect(results.filter((r) => r.status === "skip")).toEqual([]);
    expect(results.filter((r) => r.status === "pass")).toHaveLength(38);
    const names = results.map((r) => r.name);
    for (const name of [
      "every private tool answers a person with forbidden and changes nothing",
      "a call that names no principal is not host",
      "forbidden comes before the input and the scope",
      "delete_workspace answers a person with forbidden and deletes nothing",
      "delete_workspace removes every owner's conversations",
      "tools/list as host matches the contract schemas",
    ]) {
      expect(names).toContain(name);
    }
  }, 60_000);
});

/** A host client: the host's credential on every request. */
async function connectTo(server: string): Promise<Client> {
  const client = new Client({ name: "conformance-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server), {
      fetch: (input, init) => {
        const h = new Headers(init?.headers);
        for (const [k, v] of Object.entries(AUTH)) h.set(k, v);
        return fetch(input, { ...init, headers: h });
      },
    }),
  );
  return client;
}

type HostContext = {
  principal: "host" | "person";
  workspaceId?: string;
  ownerId?: string;
};

/** A tool call carrying the host context. */
function callAs(client: Client, ctx: HostContext, name: string, args: Record<string, unknown>) {
  return client.callTool({
    name,
    arguments: args,
    _meta: { "ai.nimblebrain/context": ctx },
  });
}

async function connectAs(ownerId: string, principal: "host" | "person") {
  const client = await connectTo(url);
  const ctx = { principal, workspaceId: WORKSPACE, ownerId };
  return {
    callTool: (r: { name: string; arguments: Record<string, unknown> }) =>
      callAs(client, ctx, r.name, r.arguments),
    close: () => client.close(),
  };
}

describe("conversations plugin: the public-only mode", () => {
  it("passes every case but the one that holds a host's door to hiding private tools", async () => {
    const owner = `${OWNER}_fixture`;
    const host = await connectAs(owner, "host");
    let fixture: string;
    try {
      const created = await host.callTool({
        name: "create",
        arguments: { model: "anthropic:claude-sonnet-5-5" },
      });
      fixture = (created.structuredContent as { conversation: { id: string } }).conversation.id;
      await host.callTool({
        name: "append_events",
        arguments: {
          id: fixture,
          events: [
            {
              ts: "2030-01-01T00:00:00.000Z",
              type: "user.message",
              content: [{ type: "text", text: "tell me about otters" }],
            },
          ],
        },
      });
    } finally {
      await host.close();
    }

    const results = await runConformance({
      server: url,
      publicOnly: true,
      headers: AUTH,
      carriage: "meta",
      workspace: WORKSPACE,
      owner,
      fixture,
    });
    expect(failures(results).map((f) => f.split(" (")[0]!.split(":")[0])).toEqual([
      PUBLIC_ONLY_EXPECTED_FAILURE,
    ]);
    expect(results.find((r) => r.name === "a private tool called here is refused")?.status).toBe(
      "pass",
    );
    expect(results.filter((r) => r.status === "skip")).toEqual([]);
  }, 60_000);
});

describe("conversations plugin: transports", () => {
  it("refuses an HTTP request without the host's credential before any tool runs", async () => {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(401);
    const wrong = await fetch(url, {
      method: "POST",
      headers: { authorization: "Bearer nope", "content-type": "application/json" },
      body: "{}",
    });
    expect(wrong.status).toBe(401);
  });

  it("serves stdio with the context in _meta, as mcp.json starts it", async () => {
    const client = new Client({ name: "stdio-host", version: "1.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: "bun",
        args: ["--no-env-file", BIN, "--data-dir", dataDir],
        env: { PATH: process.env.PATH ?? "" },
      }),
    );
    try {
      const tools = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(tools).toEqual([...PUBLIC_TOOLS, ...PRIVATE_TOOLS].sort());
      const meta = (principal: "host" | "person") => ({
        "ai.nimblebrain/context": { workspaceId: WORKSPACE, ownerId: "usr_stdio", principal },
      });
      const created = await client.callTool({
        name: "create",
        arguments: { model: "anthropic:claude-sonnet-5-5" },
        _meta: meta("host"),
      });
      expect(created.isError).toBeFalsy();
      const refused = await client.callTool({
        name: "create",
        arguments: { model: "anthropic:claude-sonnet-5-5" },
        _meta: meta("person"),
      });
      expect(JSON.parse((refused.content as Array<{ text: string }>)[0]!.text).code).toBe(
        "forbidden",
      );
      const listed = await client.callTool({ name: "list", arguments: {}, _meta: meta("person") });
      expect((listed.structuredContent as { totalCount: number }).totalCount).toBe(1);
    } finally {
      await client.close();
    }
  }, 30_000);
});
