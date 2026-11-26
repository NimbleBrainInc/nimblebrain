/**
 * nb-tasks: the tasks plugin's server.
 *
 *   nb-tasks --data-dir <dir>                  MCP over stdio (how mcp.json starts it)
 *   nb-tasks --data-dir <dir> --http <port>    MCP over Streamable HTTP at /mcp
 *       [--host <host>]          the address to listen on (default 127.0.0.1)
 *   [--screen <file>]            the built screen HTML (default: ui/dist/index.html here)
 *   [--retention-days <n>]       how long an ended run's data is kept (default 180)
 *
 * Every call's context is the host context at `params._meta["ai.nimblebrain/context"]`
 * (`contracts/host-context/CONTEXT.md`), believed only from an authenticated host transport:
 * - stdio: by construction. The host that started the process alone holds its pipe.
 * - HTTP: every request presents `Authorization: Bearer $NB_TASKS_TOKEN`, the credential
 *   the operator issues to the host for this server (required in HTTP mode, at least 32
 *   characters), or is refused 401 before its body is read. The token is `host` on every
 *   tool, so the server listens on loopback unless `--host` says otherwise, and warns.
 *
 * The change hint (`tasks://due/<workspaceId>`, CONTRACT.md §5.1) is the host's alone: a
 * `subscriptions/listen` naming it is checked here, at the entry, against the host context
 * in the request's `_meta` before the SDK's listen router serves it, since the router has
 * no hook of its own. `resources/read` and the 2025-era `resources/subscribe` are checked
 * by the server's handlers.
 *
 * On stdio, stdout is the protocol; diagnostics go to stderr. In HTTP mode the server prints
 * `listening <url>` once it serves.
 */

import { timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { createMcpHandler, type Server } from "@modelcontextprotocol/server";
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";
import { buildServer, DEFAULT_RETENTION_MS, hintRefusal, hintUri } from "./server.ts";
import { Store } from "./store.ts";

export const TOKEN_ENV = "NB_TASKS_TOKEN";
export const MCP_PATH = "/mcp";
/** The shortest host credential HTTP mode accepts: the token is `host` on every tool. */
export const MIN_TOKEN_LENGTH = 32;
export const DEFAULT_HOST = "127.0.0.1";
const DAY_MS = 86_400_000;

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
  process.stderr.write(`nb-tasks: ${message}\n`);
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

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: { _meta?: unknown; notifications?: { resourceSubscriptions?: unknown } };
}

/**
 * The JSON-RPC error answering a `subscriptions/listen` that names a hint URI its context
 * may not subscribe to, or null when it may proceed.
 */
export function listenRefusal(message: JsonRpcMessage): Record<string, unknown> | null {
  if (message.method !== "subscriptions/listen") return null;
  const uris = message.params?.notifications?.resourceSubscriptions;
  if (!Array.isArray(uris)) return null;
  for (const uri of uris) {
    const refused = typeof uri === "string" ? hintRefusal(uri, message.params?._meta) : null;
    if (refused) {
      return {
        jsonrpc: "2.0",
        id: message.id ?? null,
        error: { code: refused.code, message: refused.message, data: refused.data },
      };
    }
  }
  return null;
}

export interface HttpServerOptions {
  dataDir: string;
  port: number;
  hostname?: string;
  token: string;
  screenPath?: string;
  retentionMs?: number;
}

/** Serve the tasks server over Streamable HTTP at {@link MCP_PATH}. */
export function serveHttp(opts: HttpServerOptions) {
  const refused = tokenError(opts.token);
  if (refused) throw new Error(refused);
  const store = new Store(opts.dataDir);
  const serverOpts = { store, screenPath: opts.screenPath, retentionMs: opts.retentionMs };
  const handler = createMcpHandler(() => buildServer(serverOpts), {
    onerror: (err) => process.stderr.write(`nb-tasks: ${err.message}\n`),
  });
  store.onChange((workspaceId) => handler.notify.resourceUpdated(hintUri(workspaceId)));
  return Bun.serve({
    port: opts.port,
    hostname: opts.hostname ?? DEFAULT_HOST,
    idleTimeout: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== MCP_PATH) return json(404, { error: "not found" });
      if (!presentsToken(req, opts.token)) return json(401, { error: "unauthorized" });
      if (req.method === "POST") {
        const body = (await req
          .clone()
          .json()
          .catch(() => ({}))) as JsonRpcMessage;
        const answer = listenRefusal(body);
        if (answer) return json(200, answer);
      }
      return handler.fetch(req);
    },
  });
}

/** Serve one connection on stdin and stdout until stdin closes. */
export async function serveStdioConnection(opts: {
  dataDir: string;
  screenPath?: string;
  retentionMs?: number;
}) {
  const store = new Store(opts.dataDir);
  const wire = new StdioServerTransport();
  const live: { server?: Server; era?: "legacy" | "modern"; subscribed: Set<string> } = {
    subscribed: new Set(),
  };
  store.onChange((workspaceId) => {
    const uri = hintUri(workspaceId);
    if (!live.server || (live.era === "legacy" && !live.subscribed.has(uri))) return;
    live.server.sendResourceUpdated({ uri }).catch(() => {});
  });
  const gated = gateListen(wire);
  process.stdin.on("end", () => process.exit(0));
  serveStdio(
    ({ era }) => {
      const server = buildServer(
        { store, screenPath: opts.screenPath, retentionMs: opts.retentionMs },
        live.subscribed,
      );
      live.server = server;
      live.era = era;
      return server;
    },
    { transport: gated, onerror: (err) => process.stderr.write(`nb-tasks: ${err.message}\n`) },
  );
}

/** The stdio wire with a refused `subscriptions/listen` answered at the entry, never served. */
function gateListen(wire: StdioServerTransport): StdioServerTransport {
  let inbound: StdioServerTransport["onmessage"];
  Object.defineProperty(wire, "onmessage", {
    configurable: true,
    get: () => inbound,
    set: (handler: StdioServerTransport["onmessage"]) => {
      inbound = handler
        ? (message) => {
            const answer = listenRefusal(message as JsonRpcMessage);
            if (answer) void wire.send(answer as Parameters<StdioServerTransport["send"]>[0]);
            else handler(message);
          }
        : handler;
    },
  });
  return wire;
}

export async function main(argv: string[]): Promise<void> {
  const dataDir = arg(argv, "data-dir");
  if (!dataDir) fail("--data-dir <dir> is required");
  const screenPath = arg(argv, "screen") ?? resolve(import.meta.dir, "../ui/dist/index.html");
  const days = arg(argv, "retention-days");
  const retentionMs = days === undefined ? DEFAULT_RETENTION_MS : Number(days) * DAY_MS;
  if (!(retentionMs > 0)) fail("--retention-days wants a positive number of days");
  if (!argv.includes("--http")) {
    await serveStdioConnection({ dataDir, screenPath, retentionMs });
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
      `nb-tasks: warning: listening on ${hostname}, not loopback: anyone who can reach it and holds ${TOKEN_ENV} is host, with every tool, private ones included\n`,
    );
  }
  const server = serveHttp({ dataDir, port, hostname, token, screenPath, retentionMs });
  process.stdout.write(`listening http://${server.hostname}:${server.port}${MCP_PATH}\n`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      server.stop(true);
      process.exit(0);
    });
  }
}

if (import.meta.main) await main(process.argv.slice(2));
