/**
 * nb-files: the files plugin's server.
 *
 *   nb-files --data-dir <dir>                  MCP over stdio (how mcp.json starts it), with
 *                                              a transfer listener on 127.0.0.1
 *   nb-files --data-dir <dir> --http <port>    MCP over Streamable HTTP at /mcp, transfers at
 *                                              /t/ on the same origin
 *       [--host <host>]              the address to listen on (default 127.0.0.1)
 *       [--transfer-origin <url>]    the origin transfer URLs name (default: the listener's)
 *   [--max-file-bytes <n>]           the largest upload begin_upload accepts (default 25 MiB)
 *   [--upload-ttl <seconds>]         how long an upload URL lives (default and most 900)
 *   [--download-ttl <seconds>]       how long a download URL lives (default and most 300)
 *   [--screen <file>]                the built screen HTML (default: ui/dist/index.html here)
 *
 * Every call's context is the host context at `params._meta["ai.nimblebrain/context"]`
 * (`contracts/host-context/CONTEXT.md`), believed only from an authenticated host transport:
 * - stdio: by construction. The host that started the process alone holds its pipe.
 * - HTTP: every request to /mcp presents `Authorization: Bearer $NB_FILES_TOKEN`, the
 *   credential the operator issues to the host for this server (required in HTTP mode, at
 *   least 32 characters), or is refused 401 before its body is read. The token is `host` on
 *   every tool, so the server listens on loopback unless `--host` says otherwise, and warns.
 *
 * Transfer URLs (CONTRACT.md §7) are bearer capabilities and need no credential. Over stdio
 * they are served by a listener bound to 127.0.0.1 on a port the OS picks, started before
 * the server answers its first request; over HTTP, by the server's own origin under /t/.
 *
 * On stdio, stdout is the protocol; diagnostics go to stderr. In HTTP mode the server prints
 * `listening <url>` once it serves.
 */

import { timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { sweepUploads } from "./private.ts";
import { buildServer, type ServerOptions } from "./server.ts";
import { Store } from "./store.ts";
import { TRANSFER_PREFIX, Transfers } from "./transfer.ts";

export const TOKEN_ENV = "NB_FILES_TOKEN";
export const MCP_PATH = "/mcp";
/** The shortest host credential HTTP mode accepts: the token is `host` on every tool. */
export const MIN_TOKEN_LENGTH = 32;
export const DEFAULT_HOST = "127.0.0.1";
/** The loopback address the stdio transfer listener binds, explicitly (CONTRACT.md §7). */
export const TRANSFER_HOST = "127.0.0.1";
/**
 * The largest MCP request HTTP mode reads: `create`'s 4 MiB body, base64-encoded, with room
 * for its envelope. A larger body is answered `too_large` by the tool, not refused unread.
 */
const MAX_MCP_REQUEST_BYTES = 8 * 1024 * 1024;
/** How often expired uploads and URLs are retired. */
const SWEEP_MS = 60_000;

/** Why `token` cannot be the host's credential, or null when it can. */
export function tokenError(token: string | undefined): string | null {
  if (!token) return `${TOKEN_ENV} is required with --http: it is the host's credential`;
  if (token.length < MIN_TOKEN_LENGTH) {
    return `${TOKEN_ENV} must be at least ${MIN_TOKEN_LENGTH} characters: it is the host's credential and is host on every tool (generate one with: openssl rand -hex 32)`;
  }
  return null;
}

export function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "::1" || /^127(\.\d{1,3}){3}$/.test(hostname);
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function fail(message: string): never {
  process.stderr.write(`nb-files: ${message}\n`);
  process.exit(2);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function presentsToken(req: Request, token: string): boolean {
  const given = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${token}`);
  return given.length === want.length && timingSafeEqual(given, want);
}

/** The options every mode shares, before the transfer origin is known. */
export interface PluginOptions extends Omit<ServerOptions, "store" | "transfers"> {
  dataDir: string;
}

/** The store, the transfers it issues, and a timer retiring what expired. */
function plugin(opts: PluginOptions, origin: () => string) {
  const store = new Store(opts.dataDir);
  const now = opts.now ?? Date.now;
  const transfers = new Transfers({ store, now, origin });
  const timer = setInterval(() => {
    transfers.sweep();
    for (const ws of store.loaded()) {
      try {
        sweepUploads({ store, now }, ws);
      } catch (err) {
        process.stderr.write(`nb-files: retiring expired uploads failed: ${String(err)}\n`);
      }
    }
  }, SWEEP_MS);
  timer.unref();
  const serverOpts: ServerOptions = { ...opts, store, transfers };
  return { store, transfers, serverOpts, stop: () => clearInterval(timer) };
}

/** The largest request body a listener accepts: an upload's limit, with room to refuse it. */
const bodyLimit = (opts: PluginOptions) =>
  Math.max((opts.maxFileBytes ?? 26_214_400) + 1, MAX_MCP_REQUEST_BYTES);

/**
 * The transfer listener for a server the host starts over stdio: 127.0.0.1, a port the OS
 * picks, answering only transfer URLs (CONTRACT.md §7).
 */
export function serveTransfers(opts: PluginOptions) {
  let origin = "";
  const p = plugin(opts, () => origin);
  const listener = Bun.serve({
    hostname: TRANSFER_HOST,
    port: 0,
    idleTimeout: 0,
    maxRequestBodySize: bodyLimit(opts),
    fetch: (req) => p.transfers.handle(req),
    error: () => new Response(null, { status: 404 }),
  });
  origin = `http://${TRANSFER_HOST}:${listener.port}`;
  return { ...p, listener, origin };
}

/** Serve one connection on stdin and stdout until stdin closes. */
export async function serveStdioConnection(opts: PluginOptions) {
  const { serverOpts } = serveTransfers(opts);
  process.stdin.on("end", () => process.exit(0));
  serveStdio(() => buildServer(serverOpts), {
    onerror: (err) => process.stderr.write(`nb-files: ${err.message}\n`),
  });
}

export interface HttpServerOptions extends PluginOptions {
  port: number;
  hostname?: string;
  token: string;
  /** The origin transfer URLs name; the listener's own by default. */
  transferOrigin?: string;
}

/** Serve the files server over Streamable HTTP at {@link MCP_PATH}, transfers under /t/. */
export function serveHttp(opts: HttpServerOptions) {
  const refused = tokenError(opts.token);
  if (refused) throw new Error(refused);
  let origin = opts.transferOrigin ?? "";
  const p = plugin(opts, () => origin);
  const handler = createMcpHandler(() => buildServer(p.serverOpts), {
    maxRequestBodySize: MAX_MCP_REQUEST_BYTES,
    onerror: (err) => process.stderr.write(`nb-files: ${err.message}\n`),
  });
  const server = Bun.serve({
    port: opts.port,
    hostname: opts.hostname ?? DEFAULT_HOST,
    idleTimeout: 0,
    maxRequestBodySize: bodyLimit(opts),
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path.startsWith(TRANSFER_PREFIX)) return p.transfers.handle(req);
      if (path !== MCP_PATH) return json(404, { error: "not found" });
      if (!presentsToken(req, opts.token)) return json(401, { error: "unauthorized" });
      return handler.fetch(req);
    },
  });
  if (!origin) origin = `http://${server.hostname}:${server.port}`;
  return server;
}

function seconds(argv: string[], name: string, most: number): number | undefined {
  const raw = arg(argv, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!(n > 0 && n <= most)) fail(`--${name} wants seconds, more than 0 and at most ${most}`);
  return n * 1000;
}

export async function main(argv: string[]): Promise<void> {
  const dataDir = arg(argv, "data-dir");
  if (!dataDir) fail("--data-dir <dir> is required");
  const screenPath = arg(argv, "screen") ?? resolve(import.meta.dir, "../ui/dist/index.html");
  const maxRaw = arg(argv, "max-file-bytes");
  const maxFileBytes = maxRaw === undefined ? undefined : Number(maxRaw);
  if (maxFileBytes !== undefined && !(Number.isInteger(maxFileBytes) && maxFileBytes > 0)) {
    fail("--max-file-bytes wants a positive number of bytes");
  }
  const opts: PluginOptions = {
    dataDir,
    screenPath,
    maxFileBytes,
    uploadTtlMs: seconds(argv, "upload-ttl", 900),
    downloadTtlMs: seconds(argv, "download-ttl", 300),
  };
  if (!argv.includes("--http")) {
    await serveStdioConnection(opts);
    return;
  }
  const port = Number(arg(argv, "http"));
  if (!Number.isInteger(port) || port < 0) fail("--http wants a port (0 for any free port)");
  const token = process.env[TOKEN_ENV];
  const refused = tokenError(token);
  if (refused || !token) fail(refused ?? `${TOKEN_ENV} is required with --http`);
  const hostname = arg(argv, "host") ?? DEFAULT_HOST;
  if (!isLoopback(hostname)) {
    process.stderr.write(
      `nb-files: warning: listening on ${hostname}, not loopback: anyone who can reach it and holds ${TOKEN_ENV} is host, with every tool, private ones included\n`,
    );
  }
  const server = serveHttp({
    ...opts,
    port,
    hostname,
    token,
    transferOrigin: arg(argv, "transfer-origin"),
  });
  process.stdout.write(`listening http://${server.hostname}:${server.port}${MCP_PATH}\n`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      server.stop(true);
      process.exit(0);
    });
  }
}

if (import.meta.main) await main(process.argv.slice(2));
