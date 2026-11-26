/**
 * The worker: ACP over Streamable HTTP at `/acp` for the runtime, and the
 * session bridges at `/mcp/<token>` for the CLI, on one loopback port.
 *
 * Loopback only, with no credential: this is a developer's machine, and the
 * runtime it serves runs the `dev` identity provider (ADR-0057). It must never
 * listen on another interface. A browser page can still reach loopback by
 * rebinding its own hostname to 127.0.0.1, so a request is served only when
 * its Host names this machine (`HOSTS`) and it carries no `Origin`: the
 * runtime and the vendor CLIs are not browsers and send none.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createNodeHttpHandler } from "@agentclientprotocol/sdk/experimental/node";
import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";
import { createWorkerAgent } from "./agent.ts";
import type { Backend } from "./backends/types.ts";
import { BRIDGE_PATH, createBridge } from "./bridge.ts";

export const ACP_PATH = "/acp";

/** The Host names the worker answers: itself, and Docker's name for this machine, which the runtime dials. */
const HOSTS = new Set(["127.0.0.1", "localhost", "host.docker.internal"]);

/** Whether a request came from this machine's runtime or CLIs, not a browser page. */
function fromThisMachine(req: IncomingMessage): boolean {
  if (req.headers.origin !== undefined) return false;
  const host = req.headers.host;
  if (!host) return false;
  try {
    return HOSTS.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

export interface Worker {
  /** Where the runtime dials: `execution.runtimes.<id>.url`. */
  acpUrl: string;
  stop(): Promise<void>;
}

/** `plan` is what the sign-in check named, which the worker reports at `initialize`. */
export async function serveWorker(backend: Backend, port: number, plan?: string): Promise<Worker> {
  const hostname = "127.0.0.1";
  let base = "";
  const bridge = createBridge(() => base);
  const acpServer = new AcpServer({ createAgent: () => createWorkerAgent(backend, bridge, plan) });
  const acpHandler = createNodeHttpHandler(acpServer);

  const route = async (req: IncomingMessage, res: ServerResponse) => {
    if (!fromThisMachine(req)) {
      res.writeHead(403);
      return void res.end();
    }
    const pathname = new URL(req.url ?? "/", "http://worker").pathname;
    if (pathname === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      return void res.end("ok");
    }
    if (pathname === ACP_PATH) return acpHandler(req, res);
    if (pathname.startsWith(BRIDGE_PATH)) return bridge.handle(req, res);
    res.writeHead(404);
    res.end();
  };
  const http = createServer((req, res) => {
    route(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, hostname, () => resolve());
  });
  const address = http.address();
  const bound = typeof address === "object" && address ? address.port : port;
  base = `http://${hostname}:${bound}`;
  return {
    acpUrl: `${base}${ACP_PATH}`,
    async stop() {
      await acpServer.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
