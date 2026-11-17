import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Everything the CLI does to the world goes through here, so a command is a
 * pure function of its `Deps` and the tests replace them without spawning
 * Docker, binding a port or making a request.
 */
export interface Deps {
  /** Run a program. `missing` is true when it is not installed at all. */
  exec(cmd: string, args: string[], opts?: { timeoutMs?: number }): Promise<ExecResult>;
  /** Whether nothing on this machine listens on `127.0.0.1:<port>`. */
  portFree(port: number): Promise<boolean>;
  /** A GET with a timeout; never throws, a connection failure is `undefined`. */
  getJson(url: string, timeoutMs?: number): Promise<{ status: number; body: unknown } | undefined>;
  readText(path: string): Promise<string | undefined>;
  env: NodeJS.ProcessEnv;
  home: string;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  missing: boolean;
}

export function realDeps(): Deps {
  return {
    exec(cmd, args, opts = {}) {
      return new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        let missing = false;
        const child = spawn(cmd, args, {
          stdio: ["ignore", "pipe", "pipe"],
          timeout: opts.timeoutMs ?? 30_000,
        });
        child.stdout.on("data", (d: Buffer) => {
          stdout += d.toString();
        });
        child.stderr.on("data", (d: Buffer) => {
          stderr += d.toString();
        });
        child.on("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "ENOENT") missing = true;
        });
        child.on("close", (code) => resolve({ code, stdout, stderr, missing }));
      });
    },
    portFree(port) {
      return new Promise((resolve) => {
        const server = createServer();
        server.once("error", () => resolve(false));
        server.once("listening", () => server.close(() => resolve(true)));
        server.listen(port, "127.0.0.1");
      });
    },
    async getJson(url, timeoutMs = 3_000) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        const text = await res.text();
        let body: unknown = text;
        try {
          body = JSON.parse(text);
        } catch {
          // Not JSON: hand back the text; the caller decides whether that is an answer.
        }
        return { status: res.status, body };
      } catch {
        return undefined;
      }
    },
    async readText(path) {
      try {
        return await readFile(path, "utf8");
      } catch {
        return undefined;
      }
    },
    env: process.env,
    home: homedir(),
  };
}

/**
 * Where an install keeps its Compose file, `.env` and state. Separate from
 * `~/.nimblebrain`, the work directory a source checkout's `bun run dev` uses,
 * so the two never read each other's files.
 */
export function installHome(deps: Deps, flag?: string): string {
  return flag ?? deps.env.NIMBLEBRAIN_HOME ?? join(deps.home, ".nimblebrain-local");
}
