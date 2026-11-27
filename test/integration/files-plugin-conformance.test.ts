/**
 * The files plugin (`packages/files/`) is a conformant implementation of the files contract.
 *
 * Starts the plugin's own command and runs the contract's black-box runner against it:
 *
 * - the whole contract over stdio, as `mcp.json` starts it, with short URL lifetimes so the
 *   expiry cases run. Every case passes but the one that waits 300 s past an upload's
 *   expiry, which the runner skips unless asked to wait.
 * - the whole contract over Streamable HTTP, transfers on the server's own origin.
 * - the whole contract through a wrap whose upload grants require a returned header, as a
 *   presigned object store's signed headers do: a PUT without it is refused 403.
 * - the public-only mode, the check for a host's agent-facing door. The plugin is the
 *   implementation, not such a door, so it lists its private tools: that case is the one
 *   expected failure.
 *
 * Also: the credential and address rules of HTTP mode, a request without the host's
 * credential refused before any tool runs, the transfer listener bound to 127.0.0.1, and the
 * screen's placement in the handshake.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { type Subprocess, spawn } from "bun";
import { type CaseResult, runConformance } from "../../contracts/files/runner/conformance.ts";

const BIN = resolve(import.meta.dir, "../../packages/files/bin/nb-files");
const TOKEN = "conformance-token-0123456789abcdef0123";
const AUTH = { authorization: `Bearer ${TOKEN}` };
const OWNER = "usr_conformance";
const HOST_META_KEY = "ai.nimblebrain/host";
const SCREEN_URI = "ui://files/browser";

/** Every case of the full run that can pass without waiting 300 s. */
const FULL_PASSES = 78;
const WAITS_FOR_GRACE = "complete_upload past the 300 s window is upload_not_found";
const PUBLIC_ONLY_EXPECTED_FAILURE = "no private tool is listed";
const SHORT_TTLS = ["--upload-ttl", "3", "--download-ttl", "3"];

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

/** The header the wrap adds to every upload grant and requires on the PUT. */
const GRANT_HEADER = "x-upload-grant";
const GRANT_VALUE = "signed-0123456789";

/**
 * Serve the plugin behind a wrap that adds a required header to each `begin_upload` grant and
 * moves its URL onto the wrap, which refuses a PUT without the header and forwards the rest.
 */
function requireGrantHeader(upstream: string): { url: string; stop: () => void } {
  const base = new URL(upstream);
  let origin = "";
  const rewrite = (msg: unknown): unknown => {
    const result = (msg as { result?: { structuredContent?: Record<string, unknown> } }).result;
    const out = result?.structuredContent;
    if (!out || typeof out.uploadId !== "string" || typeof out.url !== "string") return msg;
    const url = `${origin}/up/${Buffer.from(out.url).toString("base64url")}`;
    const grant = {
      ...out,
      url,
      headers: { ...(out.headers as object), [GRANT_HEADER]: GRANT_VALUE },
    };
    const content = [{ type: "text", text: JSON.stringify(grant) }];
    return { ...(msg as object), result: { ...result, structuredContent: grant, content } };
  };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname.startsWith("/up/")) {
        const target = Buffer.from(u.pathname.slice(4), "base64url").toString();
        if (req.method === "PUT" && req.headers.get(GRANT_HEADER) !== GRANT_VALUE) {
          return new Response("missing the granted header", { status: 403 });
        }
        const headers = new Headers(req.headers);
        headers.delete(GRANT_HEADER);
        headers.delete("host");
        const body = req.method === "PUT" ? await req.arrayBuffer() : undefined;
        return fetch(target, { method: req.method, headers, body, redirect: "manual" });
      }
      const headers = new Headers(req.headers);
      headers.delete("host");
      const res = await fetch(new URL(u.pathname + u.search, base), {
        method: req.method,
        headers,
        body: req.method === "POST" ? await req.text() : undefined,
      });
      if (req.method !== "POST") return res;
      const type = res.headers.get("content-type") ?? "";
      const text = await res.text();
      const body = type.includes("text/event-stream")
        ? text
            .split("\n")
            .map((l) =>
              l.startsWith("data: ")
                ? `data: ${JSON.stringify(rewrite(JSON.parse(l.slice(6))))}`
                : l,
            )
            .join("\n")
        : text && type.includes("json")
          ? JSON.stringify(rewrite(JSON.parse(text)))
          : text;
      const out = new Headers(res.headers);
      out.delete("content-length");
      out.delete("content-encoding");
      return new Response(body, { status: res.status, headers: out });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  return { url: `${origin}${base.pathname}`, stop: () => server.stop(true) };
}

const failures = (results: CaseResult[]) =>
  results.filter((r) => r.status === "fail").map((r) => `${r.name}: ${r.detail}`);

function serve(dir: string, extra: string[], token: string | undefined) {
  return spawn(["bun", "--no-env-file", BIN, "--data-dir", dir, "--http", "0", ...extra], {
    env: {
      PATH: process.env.PATH ?? "",
      ...(token !== undefined ? { NB_FILES_TOKEN: token } : {}),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "files-plugin-"));
  proc = serve(dataDir, SHORT_TTLS, TOKEN);
  url = await readListening(proc);
}, 30_000);

afterAll(() => {
  proc?.kill();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

function expectFull(results: CaseResult[]): void {
  expect(failures(results)).toEqual([]);
  expect(results.filter((r) => r.status === "skip").map((r) => r.name)).toEqual([WAITS_FOR_GRACE]);
  expect(results.filter((r) => r.status === "pass")).toHaveLength(FULL_PASSES);
  const names = results.map((r) => r.name);
  for (const name of [
    "every private tool answers a person with forbidden, before input and scope",
    "an upload end to end: begin_upload, PUT, complete_upload, resolve, GET",
    "complete_upload succeeds within 300 s past expiresAt for a PUT begun in time",
    "a single Range is answered 206 with Content-Range and that range's length",
    "resolve called as host with a runId in the context succeeds",
    "delete_workspace purges every owner's files, folders and uploads, idempotently",
    "no public output or error carries a transfer URL or a body",
  ]) {
    expect(names).toContain(name);
  }
}

describe("files plugin: the whole contract", () => {
  it("passes over stdio, as mcp.json starts it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "files-plugin-stdio-"));
    try {
      expectFull(
        await runConformance({
          command: "bun",
          args: ["--no-env-file", BIN, "--data-dir", dir, ...SHORT_TTLS],
          workspace: "ws_a1a1a1a1a1a1a1a1",
          owner: OWNER,
        }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it("passes over Streamable HTTP, transfers on the server's own origin", async () => {
    expectFull(
      await runConformance({
        server: url,
        headers: AUTH,
        carriage: "meta",
        workspace: "ws_b2b2b2b2b2b2b2b2",
        owner: OWNER,
      }),
    );
  }, 180_000);
});

describe("files plugin: an upload grant that requires a returned header", () => {
  it("passes the whole contract with every upload PUT carrying the grant's headers", async () => {
    const wrap = requireGrantHeader(url);
    try {
      expectFull(
        await runConformance({
          server: wrap.url,
          headers: AUTH,
          carriage: "meta",
          workspace: "ws_e5e5e5e5e5e5e5e5",
          owner: OWNER,
        }),
      );
    } finally {
      wrap.stop();
    }
  }, 180_000);
});

describe("files plugin: the public-only mode", () => {
  it("passes every case but the one that holds a host's door to hiding private tools", async () => {
    const results = await runConformance({
      server: url,
      publicOnly: true,
      headers: AUTH,
      carriage: "meta",
      workspace: "ws_c3c3c3c3c3c3c3c3",
      owner: OWNER,
    });
    expect(failures(results).map((f) => f.split(":")[0])).toEqual([PUBLIC_ONLY_EXPECTED_FAILURE]);
    expect(results.find((r) => r.name === "a private tool called here is refused")?.status).toBe(
      "pass",
    );
  }, 60_000);
});

describe("files plugin: HTTP mode's credential and address", () => {
  it.each([
    ["no token", undefined, "is required"],
    ["an empty token", "", "is required"],
    ["a 31-character token", "x".repeat(31), "at least 32 characters"],
  ])(
    "refuses to start with %s",
    async (_name, token, message) => {
      const dir = mkdtempSync(join(tmpdir(), "files-plugin-token-"));
      const p = serve(dir, [], token);
      try {
        expect(await p.exited).toBe(2);
        expect(await new Response(p.stderr).text()).toContain(message);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it("listens on loopback by default and refuses a request without the credential", async () => {
    expect(new URL(url).hostname).toBe("127.0.0.1");
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(401);
    expect((await fetch(new URL("/t/nothing.here", url))).status).toBe(404);
  });

  it("places the screen in the sidebar from the initialize result's _meta", async () => {
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
    const text = await res.text();
    const data = text.startsWith("{")
      ? text
      : (text
          .split("\n")
          .filter((l) => l.startsWith("data: "))
          .pop()
          ?.slice(6) ?? "{}");
    const result = (JSON.parse(data) as { result?: { _meta?: Record<string, unknown> } }).result;
    const hostMeta = result?._meta?.[HOST_META_KEY] as
      | { placements?: Array<Record<string, unknown>> }
      | undefined;
    expect(hostMeta?.placements?.find((p) => p.resourceUri === SCREEN_URI)).toEqual(
      expect.objectContaining({ slot: "sidebar", label: "Files" }),
    );
  });
});

describe("files plugin: the stdio transfer listener", () => {
  it("issues URLs on 127.0.0.1 and answers anything else 404", async () => {
    const dir = mkdtempSync(join(tmpdir(), "files-plugin-listener-"));
    const client = new Client({ name: "stdio-host", version: "1.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: "bun",
        args: ["--no-env-file", BIN, "--data-dir", dir],
        env: { PATH: process.env.PATH ?? "" },
      }),
    );
    try {
      const _meta = {
        "ai.nimblebrain/context": { principal: "host", workspaceId: "ws_d4", ownerId: OWNER },
      };
      const begun = await client.callTool({
        name: "begin_upload",
        arguments: {
          version: "1.0",
          filename: "a.txt",
          mimeType: "text/plain",
          size: 1,
          source: "app",
        },
        _meta,
      });
      const upload = new URL(String((begun.structuredContent as { url: string }).url));
      expect(upload.hostname).toBe("127.0.0.1");
      expect(upload.port).not.toBe("");
      for (const path of ["/", "/mcp", "/t/", `${upload.pathname}x`]) {
        expect((await fetch(new URL(path, upload.origin))).status).toBe(404);
      }
      expect((await fetch(upload, { method: "GET" })).status).toBe(404);
    } finally {
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
