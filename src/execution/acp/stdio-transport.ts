/**
 * An ACP agent as a child process speaking newline-delimited JSON-RPC on stdio.
 *
 * The child gets the environment it is given and nothing else: no variable of
 * this process leaks into it, so a credential reaches an agent only when a
 * driver names it. It is killed when the run ends, whatever the run's outcome.
 */

import * as acp from "@agentclientprotocol/sdk/unstable";
import { log } from "../../observability/log.ts";
import type { AcpConnectionTarget } from "./driver.ts";

export interface StdioAgentSpec {
  command: string;
  args: string[];
  /** The child's whole environment. */
  env: Record<string, string>;
  cwd: string;
  /** How long a child gets to exit after SIGTERM before SIGKILL. */
  killGraceMs?: number;
}

export function spawnStdioAgent(spec: StdioAgentSpec): AcpConnectionTarget {
  const child = Bun.spawn([spec.command, ...spec.args], {
    cwd: spec.cwd,
    env: spec.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  void drainStderr(child.stderr, spec.command);

  const stdin = new WritableStream<Uint8Array>({
    async write(chunk) {
      child.stdin.write(chunk);
      await child.stdin.flush();
    },
    close() {
      void child.stdin.end();
    },
    abort() {
      void child.stdin.end();
    },
  });

  return {
    target: acp.ndJsonStream(stdin, child.stdout),
    cwd: spec.cwd,
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      const exited = await Promise.race([
        child.exited.then(() => true),
        Bun.sleep(spec.killGraceMs ?? 2_000).then(() => false),
      ]);
      if (!exited) child.kill("SIGKILL");
    },
  };
}

/** An agent's stderr is its log. Keep it out of stdout, which carries the protocol. */
async function drainStderr(stream: ReadableStream<Uint8Array>, command: string): Promise<void> {
  const decoder = new TextDecoder();
  try {
    for await (const chunk of stream) {
      const text = decoder.decode(chunk).trimEnd();
      if (text) log.debug("execution", `[acp:${command}] ${text}`);
    }
  } catch {
    // The child is gone; nothing more to read.
  }
}
