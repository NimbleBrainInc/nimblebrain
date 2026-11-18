import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Everything the CLI does to the world goes through here, so a command is a
 * pure function of its `Deps` and the tests replace them without spawning
 * Docker, binding a port, writing a file or making a request.
 */
export interface Deps {
  /** Run a program. `missing` is true when it is not installed at all. */
  exec(cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult>;
  /** Whether nothing on this machine listens on `127.0.0.1:<port>`. */
  portFree(port: number): Promise<boolean>;
  /** A GET with a timeout; never throws, a connection failure is `undefined`. */
  getJson(url: string, timeoutMs?: number): Promise<{ status: number; body: unknown } | undefined>;
  /** A GET for a text file, with a timeout; never throws, a connection failure is `undefined`. */
  getText(url: string, timeoutMs?: number): Promise<{ status: number; body: string } | undefined>;
  readText(path: string): Promise<string | undefined>;
  /** Write a file, creating its folder (mode 700). `mode` applies to a new file and to an existing one. */
  writeText(path: string, text: string, mode?: number): Promise<void>;
  /** Remove a file, or a folder only when it is empty. Never recursive; a missing path or a non-empty folder is left as it is. */
  remove(path: string): Promise<void>;
  /** Ask a person a question on stderr; `hidden` echoes nothing (for the model key). */
  prompt(question: string, opts?: { hidden?: boolean }): Promise<string>;
  /** Whether a person is at a terminal to answer a prompt. */
  interactive: boolean;
  sleep(ms: number): Promise<void>;
  /** A progress line for a person, on stderr, so `--json` stdout stays one object. */
  say(line: string): void;
  env: NodeJS.ProcessEnv;
  home: string;
}

export interface ExecOptions {
  timeoutMs?: number;
  cwd?: string;
  /** Replaces the environment entirely; the caller passes `process.env` minus what it withholds. */
  env?: NodeJS.ProcessEnv;
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
          cwd: opts.cwd,
          env: opts.env,
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
        const res = await fetchHeld(url, timeoutMs);
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
    async getText(url, timeoutMs = 10_000) {
      try {
        const res = await fetchHeld(url, timeoutMs);
        return { status: res.status, body: await res.text() };
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
    async writeText(path, text, mode = 0o644) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, text, { mode });
      // `mode` on writeFile only applies when it creates the file.
      await chmod(path, mode);
    },
    async remove(path) {
      try {
        await rmdir(path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOTDIR") await rm(path, { force: true });
      }
    },
    prompt: (question, opts = {}) =>
      opts.hidden ? hiddenPrompt(question) : visiblePrompt(question),
    interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    say: (line) => {
      process.stderr.write(`${line}\n`);
    },
    env: process.env,
    home: homedir(),
  };
}

/**
 * A GET whose timeout holds the process open until it settles. `AbortSignal.timeout`
 * uses an unref'd timer, so while a request's connection is still being set up
 * (a container restarting behind a published port) nothing kept Node alive: the
 * event loop drained and the process exited mid-`await` with code 0, before the
 * CLI had answered. A plain `setTimeout` is ref'd; it aborts the request on time
 * and is cleared as soon as the body has arrived.
 */
async function fetchHeld(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": "nimblebrain-cli" },
    });
    // Read the body inside the window too, so a stalled body is cut off as well.
    const body = await res.text();
    return new Response(body, { status: res.status, headers: res.headers });
  } finally {
    clearTimeout(timer);
  }
}

async function visiblePrompt(question: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Reads a line with nothing echoed, so the model key never lands in the terminal's scrollback. */
function hiddenPrompt(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(question);
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const done = (fn: () => void) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stderr.write("\n");
      fn();
    };
    const onData = (chunk: string) => {
      const step = typeHidden(value, chunk);
      value = step.value;
      if (step.end === "enter") done(() => resolve(value.trim()));
      if (step.end === "cancel") done(() => reject(new Error("Cancelled.")));
    };
    stdin.on("data", onData);
  });
}

/** Applies typed characters to the hidden value: backspace deletes, Enter ends, Ctrl-C cancels. */
export function typeHidden(
  value: string,
  chunk: string,
): { value: string; end?: "enter" | "cancel" } {
  let v = value;
  for (const ch of chunk) {
    if (ch === "\r" || ch === "\n") return { value: v, end: "enter" };
    if (ch === "\u0003") return { value: v, end: "cancel" };
    v = ch === "\u007f" || ch === "\b" ? v.slice(0, -1) : v + ch;
  }
  return { value: v };
}

/**
 * Where an install keeps its Compose file, `.env` and state. Separate from
 * `~/.nimblebrain`, the work directory a source checkout's `bun run dev` uses,
 * so the two never read each other's files.
 */
export function installHome(deps: Deps, flag?: string): string {
  return flag ?? deps.env.NIMBLEBRAIN_HOME ?? join(deps.home, ".nimblebrain-local");
}
