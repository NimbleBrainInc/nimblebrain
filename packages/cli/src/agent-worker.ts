import { join } from "node:path";
import { paths, setEnvLines } from "./compose.ts";
import type { Deps } from "./deps.ts";
import { CliError, type ErrorCode } from "./result.ts";
import { CLAUDE_STATUS, claudeAccount } from "./subscription/backends/claude.ts";
import { CODEX_STATUS, codexAccount } from "./subscription/backends/codex.ts";
import {
  type Account,
  BackendRefused,
  type Refusal,
  subscriptionEnv,
} from "./subscription/backends/types.ts";
import { type SubscriptionRuntime, WORKER_COMMAND, WORKER_PORTS } from "./subscription/command.ts";

/**
 * The agent worker on this machine: the process that runs NimbleBrain's turns
 * on the person's own Claude Code or Codex, signed in to their subscription
 * (`src/subscription/`). `use` starts it detached, as this CLI's own file run
 * by this Node with `WORKER_COMMAND`; `up` starts it again when it is not
 * running; `down`, `use native` and `uninstall` stop it.
 *
 * It listens on 127.0.0.1 only. The runtime's container dials it at
 * `host.docker.internal`, which Docker Desktop forwards to this machine's
 * loopback, from `NB_AGENT_RUNTIME_URL` in `.env`, the only channel from the
 * CLI to the runtime (ADR-0065).
 */

/** The `.env` names the runtime reads its agent runtime from. */
export const AGENT_RUNTIME_ENV = {
  runtime: "NB_AGENT_RUNTIME",
  url: "NB_AGENT_RUNTIME_URL",
} as const;

export type AgentRuntimeName = "native" | SubscriptionRuntime;

/** `<home>/agent-worker.json`: the running worker, so a later run can find and stop it. */
interface WorkerRecord {
  pid: number;
  port: number;
  agent: SubscriptionRuntime;
}

/** The worker as an answer reports it. */
export interface WorkerState {
  running: boolean;
  /** Its process id while it runs, else null. */
  pid: number | null;
  /** Its ACP endpoint on this machine. */
  url: string;
  log: string;
}

export interface AgentRuntimeState {
  name: AgentRuntimeName;
  /** The worker that serves it; null for native, which needs none. */
  worker: WorkerState | null;
}

export const workerPaths = (home: string) => ({
  record: join(home, "agent-worker.json"),
  log: join(home, "agent-worker.log"),
});

/** Each subscription runtime: its vendor CLI, the command that says how it is signed in, and how to read that. */
export const SUBSCRIPTION_RUNTIMES: Record<
  SubscriptionRuntime,
  {
    label: string;
    /** The worker's argument and `use`'s: `claude`, `codex`. */
    arg: string;
    bin: string;
    status: string[];
    /** Whether the status command's stderr is part of its answer (Codex prints it there). */
    readsStderr: boolean;
    account(out: string | undefined): Account;
    variant: "claude" | "codex";
  }
> = {
  "claude-code": {
    label: "Claude Code",
    arg: "claude",
    bin: "claude",
    status: CLAUDE_STATUS,
    readsStderr: false,
    account: claudeAccount,
    variant: "claude",
  },
  codex: {
    label: "Codex",
    arg: "codex",
    bin: "codex",
    status: CODEX_STATUS,
    readsStderr: true,
    account: codexAccount,
    variant: "codex",
  },
};

/** How long a started worker may take to check its sign-in and listen. */
const WORKER_START_MS = 20_000;
/** How long a stopped worker may take to end before it is killed. */
const WORKER_STOP_MS = 5_000;
const POLL_MS = 250;

/** The agent runtime `.env` names, and the worker port its URL dials. */
export function agentRuntimeOf(envText: string): { name: AgentRuntimeName; port?: number } {
  const name = envText.match(/^NB_AGENT_RUNTIME=(\S*)\r?$/m)?.[1];
  if (name !== "claude-code" && name !== "codex") return { name: "native" };
  const url = envText.match(/^NB_AGENT_RUNTIME_URL=(\S*)\r?$/m)?.[1] ?? "";
  const port = Number(url.match(/^https?:\/\/[^/]+:(\d+)\//)?.[1]);
  return Number.isInteger(port) && port > 0 ? { name, port } : { name };
}

/** The worker's ACP URL as the runtime's container dials it. */
export function dialedUrl(port: number): string {
  return `http://host.docker.internal:${port}/acp`;
}

const localUrl = (port: number) => `http://127.0.0.1:${port}/acp`;

/** The agent runtime the install's `.env` names, and whether its worker runs. */
export async function agentRuntimeState(deps: Deps, home: string): Promise<AgentRuntimeState> {
  const { name, port } = agentRuntimeOf((await deps.readText(paths(home).env)) ?? "");
  if (name === "native") return { name, worker: null };
  const running = await runningWorker(deps, home);
  const at = running?.port ?? port;
  return {
    name,
    worker: {
      running: running !== undefined,
      pid: running?.pid ?? null,
      url: at === undefined ? "" : localUrl(at),
      log: workerPaths(home).log,
    },
  };
}

/**
 * Confirms the vendor CLI is installed and signed in to a subscription, the
 * same check the worker makes before it listens, so a refusal is a coded error
 * here rather than a line in its log. Its environment holds no API key, as the
 * worker's children never do.
 */
export async function preflight(deps: Deps, runtime: SubscriptionRuntime): Promise<Account> {
  const spec = SUBSCRIPTION_RUNTIMES[runtime];
  const res = await deps.exec(spec.bin, spec.status, { env: subscriptionEnv(deps.env) });
  const out = res.missing
    ? undefined
    : spec.readsStderr
      ? `${res.stdout}\n${res.stderr}`
      : res.stdout;
  try {
    return spec.account(out);
  } catch (err) {
    if (!(err instanceof BackendRefused)) throw err;
    throw new CliError(REFUSAL_CODES[err.reason], err.message, {}, spec.variant);
  }
}

const REFUSAL_CODES = {
  not_installed: "AGENT_CLI_MISSING",
  unreadable: "AGENT_CLI_MISSING",
  not_signed_in: "AGENT_NOT_SIGNED_IN",
  api_key: "AGENT_BILLS_API_KEY",
} as const satisfies Record<Refusal, ErrorCode>;

async function readRecord(deps: Deps, home: string): Promise<WorkerRecord | undefined> {
  const text = await deps.readText(workerPaths(home).record);
  if (text === undefined) return undefined;
  try {
    const r = JSON.parse(text) as Partial<WorkerRecord> | null;
    if (
      typeof r?.pid !== "number" ||
      typeof r.port !== "number" ||
      (r.agent !== "claude-code" && r.agent !== "codex")
    ) {
      return undefined;
    }
    return r as WorkerRecord;
  } catch {
    return undefined;
  }
}

/**
 * Whether `pid` is a worker this CLI started: its command line carries
 * `WORKER_COMMAND`. A recorded pid alone is not enough, since the system
 * reuses it once the worker has ended.
 */
async function isWorker(deps: Deps, pid: number): Promise<boolean> {
  const res = await deps.exec("ps", ["-p", String(pid), "-o", "command="]);
  return res.code === 0 && res.stdout.includes(WORKER_COMMAND);
}

/** The recorded worker, when it is still running. */
async function runningWorker(deps: Deps, home: string): Promise<WorkerRecord | undefined> {
  const record = await readRecord(deps, home);
  return record && (await isWorker(deps, record.pid)) ? record : undefined;
}

/** Stops the recorded worker, if it runs, and removes its record. True when one was running. */
export async function stopWorker(deps: Deps, home: string): Promise<boolean> {
  const running = await runningWorker(deps, home);
  if (running) {
    await deps.exec("kill", ["-TERM", String(running.pid)]);
    let gone = false;
    for (let waited = 0; waited < WORKER_STOP_MS && !gone; waited += POLL_MS) {
      await deps.sleep(POLL_MS);
      gone = !(await isWorker(deps, running.pid));
    }
    if (!gone) await deps.exec("kill", ["-KILL", String(running.pid)]);
  }
  await deps.remove(workerPaths(home).record);
  return running !== undefined;
}

/**
 * Starts a worker for `runtime` on `port` and waits until it answers, which
 * it does only once its own sign-in check passed. Records it (mode 600).
 */
export async function startWorker(
  deps: Deps,
  home: string,
  runtime: SubscriptionRuntime,
  port: number,
): Promise<WorkerState> {
  if (!(await deps.portFree(port))) {
    throw new CliError(
      "PORT_IN_USE",
      `Port ${port} on 127.0.0.1 is in use, so the agent worker cannot listen there.`,
    );
  }
  const log = workerPaths(home).log;
  const pid = await deps.spawnDetached(
    deps.self.node,
    [deps.self.script, WORKER_COMMAND, SUBSCRIPTION_RUNTIMES[runtime].arg, "--port", String(port)],
    { logPath: log, env: deps.env },
  );
  if (pid === undefined) {
    throw new CliError("AGENT_WORKER_FAILED", "The agent worker could not be started.", { log });
  }
  for (let waited = 0; waited <= WORKER_START_MS; waited += POLL_MS) {
    const health = await deps.getText(`http://127.0.0.1:${port}/healthz`, 1_000);
    if (health?.status === 200) {
      const record: WorkerRecord = { pid, port, agent: runtime };
      await deps.writeText(workerPaths(home).record, `${JSON.stringify(record, null, 2)}\n`, 0o600);
      return { running: true, pid, url: localUrl(port), log };
    }
    if (!(await isWorker(deps, pid))) break;
    await deps.sleep(POLL_MS);
  }
  if (await isWorker(deps, pid)) await deps.exec("kill", ["-KILL", String(pid)]);
  throw new CliError(
    "AGENT_WORKER_FAILED",
    `The agent worker stopped before it answered${await lastLine(deps, log)}`,
    {
      log,
    },
  );
}

/** The log's last line, as `: <line>`, or `.` when there is none. */
async function lastLine(deps: Deps, log: string): Promise<string> {
  const line = ((await deps.readText(log)) ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  return line ? `: ${line}` : ".";
}

/**
 * Starts the worker `.env` names when it is not running (after a reboot, or
 * `down`), on the port the runtime dials. True when it started one.
 */
export async function restartWorker(deps: Deps, home: string): Promise<boolean> {
  const { name, port } = agentRuntimeOf((await deps.readText(paths(home).env)) ?? "");
  if (name === "native" || (await runningWorker(deps, home))) return false;
  await preflight(deps, name);
  await startWorker(deps, home, name, port ?? WORKER_PORTS[name]);
  return true;
}

/** Points the install's `.env` at `runtime`'s worker on `port`, or at the native engine. */
export async function writeAgentRuntime(
  deps: Deps,
  home: string,
  runtime: AgentRuntimeName,
  port?: number,
): Promise<void> {
  const p = paths(home);
  const values =
    runtime === "native" || port === undefined
      ? { [AGENT_RUNTIME_ENV.runtime]: "", [AGENT_RUNTIME_ENV.url]: "" }
      : { [AGENT_RUNTIME_ENV.runtime]: runtime, [AGENT_RUNTIME_ENV.url]: dialedUrl(port) };
  await deps.writeText(p.env, setEnvLines((await deps.readText(p.env)) ?? "", values), 0o600);
}
