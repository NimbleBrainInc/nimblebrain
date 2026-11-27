/**
 * The tasks plugin (`packages/tasks/`) is a conformant implementation of the tasks contract.
 *
 * Starts the plugin's own command over Streamable HTTP in a temporary data directory and runs
 * the contract's black-box runner against it:
 *
 * - the whole contract, with the host context in request metadata as the host states it and
 *   the runner as the host's clock. Every case must pass.
 * - the public-only mode, the check for a host's agent-facing door. The plugin is the
 *   implementation, not such a door, so it lists its private tools: that case is the one
 *   expected failure, and every other case must pass.
 *
 * Also: the credential and address rules of HTTP mode, a request without the host's
 * credential refused before any tool runs, the stdio transport (how `mcp.json` starts the
 * server) carrying the context in `_meta`, and the screen's placement in the handshake.
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
} from "../../contracts/tasks/runner/conformance.ts";

const BIN = resolve(import.meta.dir, "../../packages/tasks/bin/nb-tasks");
const TOKEN = "conformance-token-0123456789abcdef0123";
const WORKSPACE = "ws_a1a1a1a1a1a1a1a1";
const SCRATCH = "ws_b2b2b2b2b2b2b2b2";
const OWNER = "usr_conformance";
const AUTH = { authorization: `Bearer ${TOKEN}` };
const HOST_META_KEY = "ai.nimblebrain/host";
const PANEL_URI = "ui://tasks/panel";

/** Every case of the full run: the runner's case list, all of which must pass. */
const FULL_CASES = 82;
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
    env: { PATH: process.env.PATH ?? "", NB_TASKS_TOKEN: TOKEN },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

beforeAll(async () => {
  // An empty data directory: a workspace the host stamps exists, and the plugin makes its
  // storage on first use.
  dataDir = mkdtempSync(join(tmpdir(), "tasks-plugin-"));
  proc = serve(dataDir);
  url = await readListening(proc);
}, 30_000);

afterAll(() => {
  proc?.kill();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

describe("tasks plugin: the whole contract", () => {
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
    expect(results.filter((r) => r.status === "pass")).toHaveLength(FULL_CASES);
    const names = results.map((r) => r.name);
    for (const name of [
      "tools/list as host matches the contract schemas",
      "every private tool answers a person with forbidden and changes nothing",
      "every refused public tool answers an unattended call unattended_refused",
      "every grant-marked tool without a grant is grant_missing and writes nothing",
      "a schedule's first occurrence comes from due's now, never the wall clock",
      "at most once: a higher token is answered skip with the earlier run interrupted",
      "end_run is first-wins: a repeat answers the first's notices and changes nothing",
      "a grant never appears outside begin_run's run answer",
      "delete_workspace purges every owner's tasks, runs and batches, idempotently",
      "the host's subscription is told when due changes",
    ]) {
      expect(names).toContain(name);
    }
  }, 180_000);
});

describe("tasks plugin: the public-only mode", () => {
  it("passes every case but the one that holds a host's door to hiding private tools", async () => {
    const results = await runConformance({
      server: url,
      publicOnly: true,
      headers: AUTH,
      carriage: "meta",
      workspace: WORKSPACE,
      owner: OWNER,
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

/** Start the server in HTTP mode with `token`, and read how it exits. */
function startWith(token: string | undefined, extra: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "tasks-plugin-token-"));
  const p = spawn(["bun", "--no-env-file", BIN, "--data-dir", dir, "--http", "0", ...extra], {
    env: {
      PATH: process.env.PATH ?? "",
      ...(token !== undefined ? { NB_TASKS_TOKEN: token } : {}),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return { p, dir };
}

describe("tasks plugin: HTTP mode's credential and address", () => {
  it.each([
    ["no token", undefined, "is required"],
    ["an empty token", "", "is required"],
    ["a 31-character token", "x".repeat(31), "at least 32 characters"],
  ])(
    "refuses to start with %s",
    async (_name, token, message) => {
      const { p, dir } = startWith(token);
      try {
        expect(await p.exited).toBe(2);
        expect(await new Response(p.stderr).text()).toContain(message);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it("listens on loopback by default, and warns when told to listen elsewhere", async () => {
    expect(new URL(url).hostname).toBe("127.0.0.1");
    const { p, dir } = startWith("y".repeat(32), ["--host", "0.0.0.0"]);
    try {
      expect(await readListening(p)).toContain("0.0.0.0");
      p.kill();
      await p.exited;
      expect(await new Response(p.stderr).text()).toContain("not loopback");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

/** The JSON-RPC message in a response body that is JSON or an SSE stream. */
async function rpcBody(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  const data = text.startsWith("{")
    ? text
    : (text
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice(6))
        .pop() ?? "{}");
  return JSON.parse(data) as Record<string, unknown>;
}

/** The sidebar placement of the panel in a handshake result's `_meta`. */
function panelPlacement(meta: unknown): unknown {
  const host = (
    meta as Record<string, { placements?: Array<Record<string, unknown>> }> | undefined
  )?.[HOST_META_KEY];
  return host?.placements?.find((p) => p.resourceUri === PANEL_URI);
}

describe("tasks plugin: transports and handshake", () => {
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

  it("places the panel in the sidebar from the initialize result's _meta", async () => {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...AUTH,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "handshake-test", version: "1.0.0" },
        },
      }),
    });
    const result = (await rpcBody(res)).result as { _meta?: unknown } | undefined;
    expect(panelPlacement(result?._meta)).toEqual(expect.objectContaining({ slot: "sidebar" }));
  });

  it("places the panel in the sidebar from the server/discover result's _meta", async () => {
    const client = new Client(
      { name: "handshake-test", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        fetch: (input, init) => {
          const h = new Headers(init?.headers);
          for (const [k, v] of Object.entries(AUTH)) h.set(k, v);
          return fetch(input, { ...init, headers: h });
        },
      }),
    );
    try {
      const discovered = client.getDiscoverResult() ?? (await client.discover());
      expect(panelPlacement(discovered._meta)).toEqual(
        expect.objectContaining({ slot: "sidebar" }),
      );
    } finally {
      await client.close();
    }
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
      expect(tools).toHaveLength(20);
      const meta = (principal: "host" | "person") => ({
        "ai.nimblebrain/context": { workspaceId: WORKSPACE, ownerId: "usr_stdio", principal },
      });
      const now = "2031-03-01T00:00:00.000Z";
      const args = { version: "1.0", now, until: now };
      const due = await client.callTool({ name: "due", arguments: args, _meta: meta("host") });
      expect(due.isError).toBeFalsy();
      expect(due.structuredContent).toEqual(
        expect.objectContaining({ occurrences: expect.any(Array), cancel: expect.any(Array) }),
      );
      const refused = await client.callTool({
        name: "due",
        arguments: args,
        _meta: meta("person"),
      });
      expect(JSON.parse((refused.content as Array<{ text: string }>)[0]!.text).code).toBe(
        "forbidden",
      );
    } finally {
      await client.close();
    }
  }, 30_000);
});
