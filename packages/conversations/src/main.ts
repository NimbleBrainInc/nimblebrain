/**
 * nb-conversations: the conversations plugin's server.
 *
 *   nb-conversations --data-dir <dir>                  MCP over stdio (how mcp.json starts it)
 *   nb-conversations --data-dir <dir> --http <port>    MCP over Streamable HTTP at /mcp
 *       [--host <host>]     the address to listen on (default 127.0.0.1)
 *       [--edge]            behind an edge that verifies the tenant and workspace (fleet mode)
 *   [--screen <file>]       the built ui://conversations/browser HTML
 *                           (default: ui/index.html in the plugin's root)
 *
 * Every call's context is the host context at `params._meta["ai.nimblebrain/context"]`
 * (`contracts/host-context/CONTEXT.md`), believed only from an authenticated host transport:
 * - stdio: by construction. The host that started the process alone holds its pipe.
 * - HTTP: every request presents `Authorization: Bearer $NB_CONVERSATIONS_TOKEN`, the
 *   credential the operator issues to the host for this server (required to start in HTTP
 *   mode), or is refused 401 before its body is read.
 * - HTTP with `--edge`: the edge in front of the server verifies the host and sets
 *   `x-tenant-id` and `x-workspace-id`, and admits nothing else to it. Those are verified
 *   dimensions: the tenant walls every call (its own data under `<data>/tenants/<tenantId>`),
 *   and a context whose `workspaceId` differs from the verified one is `context_mismatch`. A
 *   request with no verified tenant is refused 400.
 *
 * On stdio, stdout is the protocol; diagnostics go to stderr. In HTTP mode the server
 * prints `listening <url>` once it serves.
 */

import { timingSafeEqual } from "node:crypto";
import { join, resolve } from "node:path";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { buildServer } from "./server.ts";
import { type ConversationStore, createStore, isPathSegment } from "./store.ts";

export const TOKEN_ENV = "NB_CONVERSATIONS_TOKEN";
export const MCP_PATH = "/mcp";
/** The headers an edge sets from what it verified. */
export const EDGE_HEADERS = { tenantId: "x-tenant-id", workspaceId: "x-workspace-id" } as const;

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
  /** Fleet mode: believe the edge's verified tenant and workspace headers. */
  edge?: boolean;
  screenPath?: string;
}

/** One store per verified tenant, each under its own directory. */
function tenantStores(dataDir: string): (tenantId: string) => ConversationStore {
  const stores = new Map<string, ConversationStore>();
  return (tenantId) => {
    let store = stores.get(tenantId);
    if (!store) {
      store = createStore(join(dataDir, "tenants", tenantId));
      stores.set(tenantId, store);
    }
    return store;
  };
}

/** Serve the conversations server over Streamable HTTP at {@link MCP_PATH}. */
export function serveHttp(opts: HttpServerOptions) {
  const store = opts.edge ? tenantStores(opts.dataDir) : createStore(opts.dataDir);
  const handler = createMcpHandler(
    () =>
      buildServer({
        store,
        screenPath: opts.screenPath,
        ...(opts.edge
          ? {
              verifiedOf: (ctx) => {
                const h = ctx.http?.req?.headers;
                const workspaceId = h?.get(EDGE_HEADERS.workspaceId) || undefined;
                return {
                  tenantId: h?.get(EDGE_HEADERS.tenantId) || undefined,
                  ...(workspaceId ? { workspaceId } : {}),
                };
              },
            }
          : {}),
      }),
    { onerror: (err) => process.stderr.write(`nb-conversations: ${err.message}\n`) },
  );
  return Bun.serve({
    port: opts.port,
    hostname: opts.hostname ?? "127.0.0.1",
    fetch(req) {
      if (new URL(req.url).pathname !== MCP_PATH) return json(404, { error: "not found" });
      if (!presentsToken(req, opts.token)) return json(401, { error: "unauthorized" });
      if (opts.edge && !isPathSegment(req.headers.get(EDGE_HEADERS.tenantId) ?? "")) {
        return json(400, { error: `no verified tenant (${EDGE_HEADERS.tenantId})` });
      }
      return handler.fetch(req);
    },
  });
}

/** Serve one connection on stdin and stdout until stdin closes. */
export async function serveStdio(opts: { dataDir: string; screenPath?: string }): Promise<void> {
  const server = buildServer({ store: createStore(opts.dataDir), screenPath: opts.screenPath });
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
  const server = serveHttp({
    dataDir,
    port,
    hostname: arg(argv, "host"),
    token,
    edge: argv.includes("--edge"),
    screenPath,
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
