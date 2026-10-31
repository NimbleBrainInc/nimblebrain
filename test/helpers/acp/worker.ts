/**
 * The pinned nimblebrain-agent served as a network worker (`nimblebrain-agent
 * serve`) on loopback, for tests that dial it over Streamable HTTP.
 */

import { realpathSync } from "node:fs";
import { PINNED_AGENT_BIN } from "./nimblebrain-agent-driver.ts";

export interface ServedWorker {
  proc: ReturnType<typeof Bun.spawn>;
  /** The worker's ACP endpoint. */
  url: string;
  port: number;
}

/** A port nothing listens on, for a worker to take. */
export function freePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const { port } = probe;
  probe.stop(true);
  return port;
}

/** Start a worker with `env` (beside its host and port) and wait for the address it serves at. */
export async function startWorker(env: Record<string, string>): Promise<ServedWorker> {
  const port = freePort();
  const proc = Bun.spawn(
    [process.execPath, "--no-env-file", realpathSync(PINNED_AGENT_BIN), "serve"],
    {
      env: {
        PATH: "/usr/bin:/bin",
        NB_AGENT_HOST: "127.0.0.1",
        NB_AGENT_PORT: String(port),
        ...env,
      },
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
  let seen = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`worker exited before serving: ${seen}`);
    seen += new TextDecoder().decode(value);
    // The log line is coloured: break it at each escape so the URL ends where the colour starts.
    const plain = seen.split(String.fromCharCode(27)).join(" ");
    const match = plain.match(/serving ACP at (http:\/\/\S+)/);
    if (match?.[1]) {
      reader.releaseLock();
      // Keep draining the worker's log, so a full pipe never stalls it.
      void (proc.stderr as ReadableStream<Uint8Array>).pipeTo(new WritableStream()).catch(() => {});
      return { proc, url: match[1], port };
    }
  }
}
