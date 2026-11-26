import type { SkillRefresh } from "./agents.ts";
import { DEFAULT_PORT, type Parsed, parse, wantsJson } from "./args.ts";
import { paths, runningHere } from "./compose.ts";
import { BARE_CLI, type Deps, forInstall, installHome, invocation } from "./deps.ts";
import { doctor } from "./doctor.ts";
import { describe, helpText } from "./help.ts";
import {
  confirmOllamaStart,
  down,
  init,
  key,
  localModel,
  logs,
  telemetry,
  uninstall,
  up,
  update,
} from "./lifecycle.ts";
import { checkLocalModel, localModelOf } from "./local-model.ts";
import { mcp } from "./mcp.ts";
import { open } from "./open.ts";
import { CliError, exitCodeFor, type Failure, failure, type Ok } from "./result.ts";
import { hasModelIn, readInstall, type StatusResult, status } from "./status.ts";
import { settleWaiting } from "./telemetry.ts";
import {
  NOTICE_WAIT_MS,
  noticeLines,
  startUpdateCheck,
  type UpdateCheck,
  updatesField,
} from "./updates.ts";

import { VERSION } from "./version.ts";

export { VERSION };

/** What one run prints: the answer on stdout and the exit code. */
export interface Answer {
  stdout: string;
  code: number;
  /**
   * Called once the answer is written: gives an update lookup still running
   * up to `NOTICE_WAIT_MS` to finish and write its cache, then returns a
   * person's notices for stderr. Never rejects.
   */
  notices?: () => Promise<string | undefined>;
}

/** The commands whose answer is an install's state, where a newer runtime is worth a line. */
const RUNTIME_NOTICE: readonly string[] = ["status", "up", "init"];

/** Runs one invocation and returns what to print and the exit code. Never throws. */
export async function run(argv: string[], deps: Deps): Promise<Answer> {
  const json = wantsJson(argv);
  let parsed: Parsed;
  try {
    parsed = parse(argv);
  } catch (err) {
    // No home is known before the flags parse, so a usage error's fix stays bare.
    return render(toFailure(err), json, BARE_CLI);
  }

  if (parsed.kind === "help") {
    return parsed.flags.json
      ? render(describe(VERSION), true, BARE_CLI)
      : { stdout: helpText(VERSION), code: 0 };
  }
  if (parsed.kind === "version") {
    return parsed.flags.json
      ? render({ ok: true, version: VERSION }, true, BARE_CLI)
      : { stdout: `${VERSION}\n`, code: 0 };
  }

  const { command, flags, arg, operand } = parsed;
  // Started first, so a lookup has the whole command to finish in.
  const check = startUpdateCheck(deps);
  const home = installHome(deps, flags.home);
  const cli = invocation(deps, home);
  let result: Ok | Failure;
  try {
    switch (command) {
      case "doctor": {
        const install = await readInstall(deps, home);
        const port = flags.port ?? install?.port ?? DEFAULT_PORT;
        // The install's own running containers hold its port, healthy or not.
        const ours = install?.port === port && (await runningHere(deps, home));
        // Doctor starts Ollama only when a person at the terminal says yes, never by default.
        const startOllama = confirmOllamaStart({ deps, flags }, false);
        result = { ...(await doctorInstall(deps, home, port, ours, startOllama)) };
        break;
      }
      case "status":
        result = { ...(await status(deps, home)) };
        break;
      default: {
        const ctx = { deps, flags, home, version: VERSION, arg, operand };
        const commands = {
          init,
          up,
          down,
          logs,
          update,
          uninstall,
          key,
          telemetry,
          "local-model": localModel,
          mcp,
          open,
        };
        result = await commands[command](ctx);
      }
    }
  } catch (err) {
    result = toFailure(err);
  }
  if (!result.ok) result = { ...result, fix: forInstall(result.fix, cli) };
  // `init` and `telemetry` settle their own; any other command sends or drops
  // a report left waiting, once someone has answered (perhaps in the web UI).
  if (!["init", "telemetry", "uninstall", "doctor"].includes(command)) {
    await settleWaiting(deps, home, VERSION);
  }
  return answerWithUpdates(result, command, flags.json, check, cli);
}

/**
 * The answer with what the update check knows: `updates`, from the cache, in
 * an answer that carries an install's state. The answer never waits on a
 * lookup; its `notices` does, after the answer is written, so a short run
 * still refreshes a stale cache, and a person hears what is newer.
 */
async function answerWithUpdates(
  result: Ok | Failure,
  command: string,
  json: boolean,
  check: UpdateCheck | undefined,
  cli: string,
): Promise<Answer> {
  if (!check) return render(result, json, cli, command);
  const runtime = isStatusShaped(result) ? result.version : undefined;
  const updates = updatesField(await check.known(0), VERSION, runtime);
  const answer = render(
    updates && runtime !== undefined ? { ...result, updates } : result,
    json,
    cli,
    command,
  );
  const notices = async () => {
    const known = await check.known(NOTICE_WAIT_MS);
    if (json) return undefined;
    const lines = noticeLines(
      updatesField(known, VERSION, runtime),
      RUNTIME_NOTICE.includes(command),
      cli,
    );
    return lines.length > 0 ? `${lines.join("\n")}\n` : undefined;
  };
  return { ...answer, notices };
}

/** An answer that carries an install's state (`status`, `init`, `up`, `update`), even inside a failure. */
function isStatusShaped(result: Ok | Failure): result is (Ok | Failure) & { version: string } {
  return (
    typeof result.version === "string" &&
    "health" in result &&
    "url" in result &&
    "workspaces" in result
  );
}

export type DoctorAnswer = Awaited<ReturnType<typeof doctorInstall>>;

/**
 * The machine's checks, then, for an install on a local model, Ollama's: it
 * answers (`startOllama` decides whether a down one is started), has the
 * model, the model calls tools, and its window is the one the runtime budgets
 * against. A failure carries every check run so far.
 */
async function doctorInstall(
  deps: Deps,
  home: string,
  port: number,
  ours: boolean,
  startOllama: (command: string) => Promise<boolean>,
) {
  const machine = await doctor(deps, port, ours);
  const model = localModelOf((await deps.readText(paths(home).env)) ?? "");
  if (!model) return machine;
  try {
    const local = await checkLocalModel(deps, model, startOllama);
    return {
      ...machine,
      checks: [...machine.checks, ...local.checks],
      ollama_started: local.started,
    };
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    const local = (err.detail.checks as unknown[] | undefined) ?? [];
    throw err.with({ checks: [...machine.checks, ...local] });
  }
}

function toFailure(err: unknown): Failure {
  if (err instanceof CliError) return failure(err);
  // An unexpected exception is a bug in the CLI, not a state of the machine; it still answers in shape.
  return failure(new CliError("USAGE", err instanceof Error ? err.message : String(err)));
}

/** `cli` is how to run this CLI against the install the run acted on (`invocation`). */
function render(result: Ok | Failure, json: boolean, cli: string, command?: string): Answer {
  const code = exitCodeFor(result);
  if (json) return { stdout: `${JSON.stringify(result)}\n`, code };
  if (!result.ok) return { stdout: `error: ${result.message}\nfix: ${result.fix}\n`, code };
  const lines = isStatus(result)
    ? statusLines(result, cli, command)
    : command === "open"
      ? openLines(result)
      : genericLines(result);
  return { stdout: `${lines.join("\n")}\n`, code };
}

type StatusLike = Ok &
  StatusResult & {
    manual?: string;
    /** Whether `init` opened the web UI; absent when it did not try. */
    opened?: boolean;
    already?: boolean;
    from?: string;
    skill_update?: SkillRefresh;
  };

function isStatus(result: Ok): result is StatusLike {
  return "health" in result && "url" in result && "workspaces" in result;
}

const AGENT_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  cursor: "Cursor",
  codex: "Codex",
};

/** An install's state as a person reads it; the JSON carries the same facts. */
function statusLines(r: StatusLike, cli: string, command?: string): string[] {
  const lines = [
    ...changeLines(r),
    `  NimbleBrain ${r.version.startsWith("v") ? r.version : `v${r.version}`}: ${r.health === "ok" ? "running" : "stopped"} at ${r.url}`,
    ...r.workspaces.map((w) => `  workspace ${w.name}: ${w.mcp}`),
    r.local_model
      ? `  model: ${r.local_model} on Ollama (NimbleBrain's own agents use it)`
      : `  model key: ${r.model_key === "set" ? "set (NimbleBrain's own agents use it)" : `missing (run ${cli} key)`}`,
  ];
  lines.push(...agentLines(r));
  if (!r.host_loopback) lines.push(`  servers on this machine: not reachable until ${cli} update`);
  lines.push(telemetryLine(r.telemetry));
  lines.push(`  CLI ${r.cli_version}`);
  const next = nextStep(r, cli, command);
  if (next) lines.push("", next);
  return lines;
}

/**
 * The one thing to do after reading an install's state: what a fresh `init`
 * leads to, and for `status`, the command that finishes an unfinished install,
 * running or not, or starts a finished one that is stopped. Nothing when a
 * finished install runs.
 */
function nextStep(r: StatusLike, cli: string, command?: string): string | undefined {
  if (command === "init" && !r.already && r.health === "ok") {
    if (!hasModelIn(r)) {
      return `Next: give NimbleBrain a model so it can chat. Run ${cli} key in your own terminal to enter a model key, or ${cli} local-model to run one on this machine with Ollama.`;
    }
    const agent = r.agent.connected;
    const ask = agent ? `, or ask ${AGENT_NAMES[agent] ?? agent} what NimbleBrain can do` : "";
    const use = r.opened ? `use NimbleBrain in your browser at ${r.url}` : `open ${r.url}`;
    return `Next: ${use}${ask}. Stop it with ${cli} down.`;
  }
  if (command !== "status") return undefined;
  if (r.phase !== "ready") {
    return `Next: finish installing it with ${cli}, or remove it with ${cli} uninstall.`;
  }
  return r.health === "ok" ? undefined : `Next: start it with ${cli} up.`;
}

/** `open`'s answer as a person reads it: the URL either way, so it can be opened by hand. */
function openLines(r: Ok): string[] {
  return [
    r.opened
      ? `  Opened ${String(r.url)} in your browser.`
      : `  Open ${String(r.url)} in your browser; none could be started here.`,
  ];
}

/** Whether a coding agent is connected, and whether it has the skill, or how to connect one by hand. */
function agentLines(r: StatusLike): string[] {
  const agent = r.agent.connected;
  if (!agent) return r.manual ? [`  agent: not connected; add it by hand: ${r.manual}`] : [];
  const name = AGENT_NAMES[agent] ?? agent;
  const lines = [
    `  ${name} can use NimbleBrain's tools (it loads them when its next session starts)`,
  ];
  const refresh = r.skill_update && SKILL_REFRESH_LINES[r.skill_update];
  if (refresh) lines.push(`  skill: ${refresh}`);
  if (!r.agent.skill)
    lines.push(
      `  skill: not installed; add it with npx skills add nimblebraininc/skills --skill nimblebrain --agent ${agent} -g`,
    );
  return lines;
}

/** What `update` did to the skill, as a person reads it; a skill that is not there has its own line. */
const SKILL_REFRESH_LINES: Record<SkillRefresh, string | undefined> = {
  updated: "updated to the newest nimblebrain skill",
  unchanged: "the nimblebrain skill is current",
  failed: "could not refresh the nimblebrain skill; try npx skills update nimblebrain -g",
  not_installed: undefined,
};

/** What this run did to an existing install: nothing (a rerun), or which version it left. */
function changeLines(r: StatusLike): string[] {
  if (r.already) return ["  already installed"];
  return r.from ? [`  updated from ${r.from}`] : [];
}

/** The answer, with why it is fixed or how to give one. */
function telemetryLine(t: StatusLike["telemetry"]): string {
  const how = t.locked ? ` (${t.locked})` : t.set ? ` (answer with ${t.set})` : "";
  return `  telemetry: ${t.state}${how}`;
}

/** Any other answer: its fields as lines, nested values flattened, nothing empty. */
function genericLines(result: Ok): string[] {
  return Object.entries(result)
    .filter(([key]) => key !== "ok")
    .flatMap(([key, value]) => field(key, value));
}

function field(key: string, value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (key === "servers" && Array.isArray(value)) {
    if (value.length === 0) return ["  no servers in this workspace"];
    return (value as Array<{ serverName: string; url?: string; status?: string }>).map(
      (s) => `  ${s.serverName}: ${s.url ?? "(no URL)"}${s.status ? ` (${s.status})` : ""}`,
    );
  }
  if (key === "checks" && Array.isArray(value)) {
    return (value as Array<{ check: string; ok: boolean; detail: string }>).map(
      (c) => `  ${c.ok ? "✓" : "✗"} ${c.check}: ${c.detail}`,
    );
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
      field(`${key} ${k}`, v),
    );
  }
  if (Array.isArray(value)) {
    const items = value.map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v)));
    return [`  ${key}: ${items.join(", ")}`];
  }
  return [`  ${key}: ${String(value)}`];
}

/**
 * What to print when the process is ending without having answered: a broken
 * promise of "one JSON object for every run" would leave an agent with nothing
 * to act on. `exitCode` is the code the process was about to end with.
 */
export function interrupted(argv: string[], exitCode: number, deps: Deps): Answer {
  const err = new CliError(
    "INTERRUPTED",
    `The CLI stopped before it answered (exit code ${exitCode}).`,
    { exit_code: exitCode },
  );
  let cli = BARE_CLI;
  try {
    cli = invocation(deps, installHome(deps, parse(argv).flags.home));
  } catch {
    // Arguments that do not parse never started a command; the fix stays bare.
  }
  const result = failure(err);
  return render({ ...result, fix: forInstall(result.fix, cli) }, wantsJson(argv), cli);
}
