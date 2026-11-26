import { join } from "node:path";
import { paths, setEnvLines } from "./compose.ts";
import type { Deps } from "./deps.ts";
import { bootout, bootstrap, type LoginItem, loginItem, plist, printed } from "./login-item.ts";
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
 * (`src/subscription/`). `use` installs it as a login item (`login-item.ts`):
 * launchd runs a copy of this CLI's own file, kept in the home, with this
 * Node and `WORKER_COMMAND`, at every login and again after a crash. `up` and
 * `update` refresh that item when the Node, the file or the port moved;
 * `down`, `use api`, `use local` and `uninstall` remove it.
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

/** `<home>/agent-worker.json`: the installed worker, so a later run can find and remove it. */
interface WorkerRecord {
  port: number;
  agent: SubscriptionRuntime;
  /** The plan its sign-in named when it started ("Claude Max"), so `status` can say who pays. */
  plan?: string;
  /** Its login item's launchd label. */
  label?: string;
  /** A worker an earlier build of this CLI started detached, found by `ps` and stopped by `kill`. */
  pid?: number;
}

/** The worker as an answer reports it. */
export interface WorkerState {
  /** Whether it answers `/healthz` on its port. */
  running: boolean;
  /** Its process id while it runs, else null. */
  pid: number | null;
  /** Its ACP endpoint on this machine. */
  url: string;
  log: string;
  /** The LaunchAgent that starts it at login and after a crash, or null when none is installed. */
  login_item: string | null;
}

export interface AgentRuntimeState {
  name: AgentRuntimeName;
  /** The worker that serves it; null for native, which needs none. */
  worker: WorkerState | null;
}

export const workerPaths = (home: string) => ({
  record: join(home, "agent-worker.json"),
  log: join(home, "agent-worker.log"),
  /**
   * The copy of this CLI the login item runs: npx's cache, where it came from, is cleaned.
   * `.mjs`, because the copy leaves the package that declares it an ES module, and a
   * `.js` under a home inside a CommonJS package would not load.
   */
  bin: join(home, "bin", "nimblebrain.mjs"),
  binDir: join(home, "bin"),
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
/** How long a detached worker from an earlier build may take to end before it is killed. */
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

/** Whether a worker answers `/healthz` on `port`: running means answering, whatever its pid. */
async function answers(deps: Deps, port: number): Promise<boolean> {
  return (await deps.getText(`http://127.0.0.1:${port}/healthz`, 1_000))?.status === 200;
}

/** The agent runtime the install's `.env` names, and whether its worker answers. */
export async function agentRuntimeState(deps: Deps, home: string): Promise<AgentRuntimeState> {
  const { name, port } = agentRuntimeOf((await deps.readText(paths(home).env)) ?? "");
  if (name === "native") return { name, worker: null };
  const record = await readRecord(deps, home);
  const at = port ?? record?.port;
  const running = at !== undefined && (await answers(deps, at));
  const item = await installedItem(deps, home);
  const pid = running && item ? ((await printed(deps, item)).pid ?? null) : null;
  return {
    name,
    worker: {
      running,
      pid,
      url: at === undefined ? "" : localUrl(at),
      log: workerPaths(home).log,
      login_item: item?.path ?? null,
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
    if (typeof r?.port !== "number" || (r.agent !== "claude-code" && r.agent !== "codex")) {
      return undefined;
    }
    return {
      port: r.port,
      agent: r.agent,
      plan: stringOr(r.plan),
      label: stringOr(r.label),
      pid: typeof r.pid === "number" ? r.pid : undefined,
    };
  } catch {
    return undefined;
  }
}

const stringOr = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/** The plan the installed worker's sign-in named, while it answers. */
export async function workerPlan(deps: Deps, home: string): Promise<string | undefined> {
  const record = await readRecord(deps, home);
  return record && (await answers(deps, record.port)) ? record.plan : undefined;
}

/** The install's Compose project, which names its login item; read from its record (`install.json`). */
async function projectOf(deps: Deps, home: string): Promise<string | undefined> {
  try {
    const r = JSON.parse((await deps.readText(paths(home).install)) ?? "") as { project?: unknown };
    return typeof r.project === "string" && r.project ? r.project : undefined;
  } catch {
    return undefined;
  }
}

/** The install's login item, when its plist is on disk. */
async function installedItem(deps: Deps, home: string): Promise<LoginItem | undefined> {
  const project = await projectOf(deps, home);
  if (!project) return undefined;
  const item = loginItem(deps, project);
  return (await deps.readText(item.path)) === undefined ? undefined : item;
}

/**
 * Whether `pid` is a worker this CLI started detached (an earlier build):
 * its command line carries `WORKER_COMMAND`. A recorded pid alone is not
 * enough, since the system reuses it once the worker has ended.
 */
async function isWorker(deps: Deps, pid: number): Promise<boolean> {
  const res = await deps.exec("ps", ["-p", String(pid), "-o", "command="]);
  return res.code === 0 && res.stdout.includes(WORKER_COMMAND);
}

async function stopDetached(deps: Deps, pid: number): Promise<boolean> {
  if (!(await isWorker(deps, pid))) return false;
  await deps.exec("kill", ["-TERM", String(pid)]);
  for (let waited = 0; waited < WORKER_STOP_MS; waited += POLL_MS) {
    await deps.sleep(POLL_MS);
    if (!(await isWorker(deps, pid))) return true;
  }
  await deps.exec("kill", ["-KILL", String(pid)]);
  return true;
}

/**
 * Stops the worker and removes its login item and record, so nothing starts
 * it at the next login. True when one was installed or running.
 */
export async function stopWorker(deps: Deps, home: string): Promise<boolean> {
  const record = await readRecord(deps, home);
  const project = await projectOf(deps, home);
  let stopped = false;
  if (project) {
    const item = loginItem(deps, project);
    stopped = await bootout(deps, item);
    if ((await deps.readText(item.path)) !== undefined) {
      await deps.remove(item.path);
      stopped = true;
    }
  }
  if (record?.pid !== undefined) stopped = (await stopDetached(deps, record.pid)) || stopped;
  await deps.remove(workerPaths(home).record);
  return stopped;
}

/** The login item's command: this Node, the home's copy of this CLI, the worker's own arguments. */
async function workerProgram(
  deps: Deps,
  home: string,
  runtime: SubscriptionRuntime,
  port: number,
): Promise<{ program: string[]; copy?: string }> {
  const w = workerPaths(home);
  // The published file is self-contained, so it is copied; a source checkout's entry runs in place.
  const copy = deps.self.script.endsWith(".js") ? await deps.readText(deps.self.script) : undefined;
  const script = copy === undefined ? deps.self.script : w.bin;
  const args = [WORKER_COMMAND, SUBSCRIPTION_RUNTIMES[runtime].arg, "--port", String(port)];
  return {
    program: [deps.self.node, script, ...args, "--log", w.log],
    ...(copy === undefined ? {} : { copy }),
  };
}

/**
 * Installs the worker for `runtime` on `port` as a login item and waits until
 * it answers, which it does only once its own sign-in check passed: copies
 * this CLI into the home, writes the plist, and loads it into this user's
 * launchd. Records it (mode 600), with the plan `preflight` read. When the
 * same item already runs and answers, it is left alone.
 */
export async function startWorker(
  deps: Deps,
  home: string,
  runtime: SubscriptionRuntime,
  port: number,
  plan?: string,
): Promise<WorkerState> {
  if (deps.platform !== "darwin") {
    throw new CliError(
      "PLATFORM_UNSUPPORTED",
      "The agent worker runs on macOS only, as a login item launchd keeps running.",
    );
  }
  const w = workerPaths(home);
  const item = loginItem(deps, (await projectOf(deps, home)) ?? "nimblebrain");
  const { program, copy } = await workerProgram(deps, home, runtime, port);
  const text = plist(item, program, w.log, deps.env);
  const record: WorkerRecord = { port, agent: runtime, plan, label: item.label };
  const writeRecord = () => deps.writeText(w.record, `${JSON.stringify(record, null, 2)}\n`, 0o600);
  const state = async (): Promise<WorkerState> => ({
    running: true,
    pid: (await printed(deps, item)).pid ?? null,
    url: localUrl(port),
    log: w.log,
    login_item: item.path,
  });

  const unchanged =
    (await deps.readText(item.path)) === text &&
    (copy === undefined || (await deps.readText(w.bin)) === copy) &&
    (await answers(deps, port));
  if (unchanged) {
    await writeRecord();
    return state();
  }

  await stopWorker(deps, home);
  if (!(await deps.portFree(port))) {
    throw new CliError(
      "PORT_IN_USE",
      `Port ${port} on 127.0.0.1 is in use, so the agent worker cannot listen there.`,
    );
  }
  if (copy !== undefined) await deps.writeText(w.bin, copy, 0o600);
  // launchd appends to the log; made here first, so it is this user's alone.
  if ((await deps.readText(w.log)) === undefined) await deps.writeText(w.log, "", 0o600);
  await deps.writeText(item.path, text, 0o644);
  await writeRecord();
  if (!(await bootstrap(deps, item))) {
    await stopWorker(deps, home);
    throw new CliError("AGENT_WORKER_FAILED", "launchd did not load the agent worker.", {
      log: w.log,
      login_item: item.path,
    });
  }
  if (await waitAnswering(deps, item, port)) return state();
  await stopWorker(deps, home);
  throw new CliError(
    "AGENT_WORKER_FAILED",
    `The agent worker stopped before it answered${await lastLine(deps, w.log)}`,
    { log: w.log },
  );
}

/** Waits for the worker to answer; false once launchd says it exited, or the time is up. */
async function waitAnswering(deps: Deps, item: LoginItem, port: number): Promise<boolean> {
  for (let waited = 0; waited <= WORKER_START_MS; waited += POLL_MS) {
    if (await answers(deps, port)) return true;
    const p = await printed(deps, item);
    if (!p.loaded || (p.pid === undefined && p.lastExit !== undefined && p.lastExit !== 0)) {
      return false;
    }
    await deps.sleep(POLL_MS);
  }
  return false;
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
 * Brings the worker `.env` names up to date: installs its login item again
 * when the Node, this CLI's file or the port moved (a new npx version, nvm),
 * or when it is not answering (after `down`). Leaves one that is current alone.
 */
export async function restartWorker(deps: Deps, home: string): Promise<void> {
  const { name, port } = agentRuntimeOf((await deps.readText(paths(home).env)) ?? "");
  if (name === "native") return;
  const account = await preflight(deps, name);
  await startWorker(deps, home, name, port ?? WORKER_PORTS[name], account.plan);
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
