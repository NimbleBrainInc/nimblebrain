/**
 * nb-conversations: the conversations plugin's server.
 *
 *   nb-conversations --data-dir <dir>                  MCP over stdio (how mcp.json starts it)
 *   nb-conversations --data-dir <dir> --http <port>    MCP over Streamable HTTP at /mcp
 *       [--host <host>]     the address to listen on (default 127.0.0.1)
 *   [--screen <file>]       the built ui://conversations/browser HTML
 *                           (default: ui/index.html in the plugin's root)
 *
 * The per-call context (scope and principal):
 * - stdio: `params._meta["ai.nimblebrain/scope"]` on each request. The host that started the
 *   process alone holds its pipe, so what a request states is the host's word.
 * - HTTP: every request presents `Authorization: Bearer $NB_CONVERSATIONS_TOKEN` (the host's
 *   credential; required to start in HTTP mode) or is refused 401 before any tool runs. The
 *   context is `params._meta["ai.nimblebrain/scope"]` when the request states one, else the
 *   `x-nb-workspace-id`, `x-nb-owner-id`, `x-nb-conversation-id` and `x-nb-principal`
 *   headers.
 *
 * On stdio, stdout is the protocol; diagnostics go to stderr. In HTTP mode the server
 * prints `listening <url>` once it serves.
 */

import { timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { callContext } from "../../plugin-sdk/src/index.ts";
import { buildServer } from "./server.ts";
import { createStore } from "./store.ts";

export const TOKEN_ENV = "NB_CONVERSATIONS_TOKEN";
export const MCP_PATH = "/mcp";

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function fail(message: string): never {
  process.stderr.write(`nb-conversations: ${message}\n`);
  process.exit(2);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Whether a request presents the host's credential. */
export function presentsToken(req: Request, token: string): boolean {
  const given = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${token}`);
  return given.length === want.length && timingSafeEqual(given, want);
}

export interface HttpServerOptions {
  dataDir: string;
  port: number;
  hostname?: string;
  token: string;
  screenPath?: string;
}

/** Serve the conversations server over Streamable HTTP at {@link MCP_PATH}. */
export function serveHttp(opts: HttpServerOptions) {
  const store = createStore(opts.dataDir);
  const handler = createMcpHandler(
    () =>
      buildServer({
        store,
        screenPath: opts.screenPath,
        // Every request reaching a handler presented the host's credential (below).
        contextOf: (meta, ctx) => callContext({ meta, headers: ctx.http?.req?.headers }),
      }),
    { onerror: (err) => process.stderr.write(`nb-conversations: ${err.message}\n`) },
  );
  return Bun.serve({
    port: opts.port,
    hostname: opts.hostname ?? "127.0.0.1",
    fetch(req) {
      if (new URL(req.url).pathname !== MCP_PATH) return json(404, { error: "not found" });
      if (!presentsToken(req, opts.token)) return json(401, { error: "unauthorized" });
      return handler.fetch(req);
    },
  });
}

/** Serve one connection on stdin and stdout until stdin closes. */
export async function serveStdio(opts: { dataDir: string; screenPath?: string }): Promise<void> {
  const server = buildServer({
    store: createStore(opts.dataDir),
    screenPath: opts.screenPath,
    contextOf: (meta) => callContext({ meta }),
  });
  const transport = new StdioServerTransport();
  transport.onclose = () => process.exit(0);
  process.stdin.on("end", () => process.exit(0));
  await server.connect(transport);
}

export async function main(argv: string[]): Promise<void> {
  const dataDir = arg(argv, "data-dir");
  if (!dataDir) fail("--data-dir <dir> is required");
  const screenPath = arg(argv, "screen") ?? resolve(import.meta.dir, "../ui/index.html");
  if (!argv.includes("--http")) {
    await serveStdio({ dataDir, screenPath });
    return;
  }
  const port = Number(arg(argv, "http"));
  if (!Number.isInteger(port) || port < 0) fail("--http wants a port (0 for any free port)");
  const token = process.env[TOKEN_ENV];
  if (!token) fail(`${TOKEN_ENV} is required with --http: it is the host's credential`);
  const server = serveHttp({ dataDir, port, hostname: arg(argv, "host"), token, screenPath });
  process.stdout.write(`listening http://${server.hostname}:${server.port}${MCP_PATH}\n`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      server.stop(true);
      process.exit(0);
    });
  }
}

if (import.meta.main) await main(process.argv.slice(2));
