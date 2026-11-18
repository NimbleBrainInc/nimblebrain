import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

/**
 * Everything the CLI does to the world goes through here, so a command is a
 * pure function of its `Deps` and the tests replace them without spawning
 * Docker, binding a port, writing a file or making a request.
 */
export interface Deps {
  /** Run a program. `missing` is true when it is not installed at all. */
  exec(cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult>;
  /** Whether a program is on `PATH`, found without running it. */
  which(cmd: string): Promise<boolean>;
  /** Whether nothing on this machine listens on `127.0.0.1:<port>`. */
  portFree(port: number): Promise<boolean>;
  /** A GET with a timeout; never throws, a connection failure is `undefined`. */
  getJson(url: string, timeoutMs?: number): Promise<{ status: number; body: unknown } | undefined>;
  /** A GET for a text file, with a timeout; never throws, a connection failure is `undefined`. */
  getText(url: string, timeoutMs?: number): Promise<{ status: number; body: string } | undefined>;
  /** A JSON POST with a timeout; never throws, a connection failure is `undefined`. */
  postJson(
    url: string,
    body: unknown,
    timeoutMs?: number,
  ): Promise<{ status: number; body: unknown } | undefined>;
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
  platform: NodeJS.Platform;
  home: string;
  /** The working directory a relative `--home` is taken from. */
  cwd: string;
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
    async which(cmd) {
      const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE").split(";") : [""];
      for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
        for (const ext of exts) {
          try {
            await access(join(dir, cmd + ext), constants.X_OK);
            return true;
          } catch {
            // Not in this folder; try the next.
          }
        }
      }
      return false;
    },
    portFree(port) {
      return new Promise((resolve) => {
        const server = createServer();
        server.once("error", () => resolve(false));
        server.once("listening", () => server.close(() => resolve(true)));
        server.listen(port, "127.0.0.1");
      });
    },
    getJson: async (url, timeoutMs = 3_000) =>
      asJson(await request(url, { headers: { "user-agent": "nimblebrain-cli" } }, timeoutMs)),
    getText: (url, timeoutMs = 10_000) =>
      request(url, { headers: { "user-agent": "nimblebrain-cli" } }, timeoutMs),
    postJson: async (url, body, timeoutMs = 5_000) =>
      asJson(
        await request(
          url,
          {
            method: "POST",
            headers: { "user-agent": "nimblebrain-cli", "content-type": "application/json" },
            body: JSON.stringify(body),
          },
          timeoutMs,
        ),
      ),
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
    platform: process.platform,
    home: homedir(),
    cwd: process.cwd(),
  };
}

/**
 * One request with a deadline, its body read inside the deadline too; never
 * throws, a failure or a timeout is `undefined`. The deadline is a plain timer,
 * not `AbortSignal.timeout`: that one is unref'd, so a request that stalls
 * without a live socket (a container restarting behind a published port)
 * leaves Node nothing to wait on, and it exits mid-command, with no answer.
 */
async function request(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ status: number; body: string } | undefined> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: abort.signal });
    return { status: res.status, body: await res.text() };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** A body parsed as JSON; text that is not JSON is handed back as it is, for the caller to judge. */
function asJson(
  res: { status: number; body: string } | undefined,
): { status: number; body: unknown } | undefined {
  if (!res) return undefined;
  try {
    return { status: res.status, body: JSON.parse(res.body) };
  } catch {
    return res;
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
 * so the two never read each other's files. Always absolute: the Compose
 * project follows the folder's name (`projectFor`), which `.` would not give.
 */
export function installHome(deps: Deps, flag?: string): string {
  return resolve(
    deps.cwd,
    flag ?? deps.env.NIMBLEBRAIN_HOME ?? join(deps.home, ".nimblebrain-local"),
  );
}

/**
 * How a person runs this CLI against `home`, for every command it prints. Bare
 * only when a bare command lands on the same install: `home` is the default and
 * `NIMBLEBRAIN_HOME` does not point elsewhere. Otherwise it names the home,
 * however this run chose it, because the printed command may run in a shell
 * without that flag or variable, and another home is another install. Quoted
 * for a POSIX shell.
 */
export const BARE_CLI = "npx nimblebrain";

export function invocation(deps: Deps, home: string): string {
  const fallback = resolve(deps.cwd, join(deps.home, ".nimblebrain-local"));
  if (home === fallback && installHome(deps) === fallback) return BARE_CLI;
  return `${BARE_CLI} --home ${shellQuote(home)}`;
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./,:@%+=-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * Text that names commands, pointed at the install that `cli` (`invocation`)
 * runs against. Identity for the default home. A function replacer, so `$` in
 * a home is never read as a replacement pattern.
 */
export function forInstall(text: string, cli: string): string {
  return text.replaceAll(BARE_CLI, () => cli);
}
