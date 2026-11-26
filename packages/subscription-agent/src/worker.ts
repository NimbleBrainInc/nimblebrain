/**
 * The worker: ACP over Streamable HTTP at `/acp` for the runtime, and the
 * session bridges at `/mcp/<token>` for the CLI, on one loopback port.
 *
 * Loopback only, with no connection check: this is a developer's machine, and
 * the runtime it serves runs the `dev` identity provider (ADR-0057). It must
 * never listen on another interface.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createNodeHttpHandler } from "@agentclientprotocol/sdk/experimental/node";
import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";
import { createWorkerAgent } from "./agent.ts";
import type { Backend } from "./backends/types.ts";
import { BRIDGE_PATH, createBridge } from "./bridge.ts";

export const ACP_PATH = "/acp";

export interface Worker {
  /** Where the runtime dials: `execution.runtimes.<id>.url`. */
  acpUrl: string;
  stop(): Promise<void>;
}

export async function serveWorker(backend: Backend, port: number): Promise<Worker> {
  const hostname = "127.0.0.1";
  let base = "";
  const bridge = createBridge(() => base);
  const acpServer = new AcpServer({ createAgent: () => createWorkerAgent(backend, bridge) });
  const acpHandler = createNodeHttpHandler(acpServer);

  const route = async (req: IncomingMessage, res: ServerResponse) => {
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
