import type { SkillRefresh } from "./agents.ts";
import { type Parsed, parse, wantsJson } from "./args.ts";
import { paths } from "./compose.ts";
import { type Deps, installHome } from "./deps.ts";
import { doctor } from "./doctor.ts";
import { describe, helpText } from "./help.ts";
import {
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
import { CliError, exitCodeFor, type Failure, failure, type Ok } from "./result.ts";
import { readInstall, type StatusResult, status } from "./status.ts";
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

/** What one run prints: the answer on stdout, a person's notices on stderr after it, and the exit code. */
export interface Answer {
  stdout: string;
  stderr?: string;
  code: number;
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
    return render(toFailure(err), json);
  }

  if (parsed.kind === "help") {
    return parsed.flags.json
      ? render(describe(VERSION), true)
      : { stdout: helpText(VERSION), code: 0 };
  }
  if (parsed.kind === "version") {
    return parsed.flags.json
      ? render({ ok: true, version: VERSION }, true)
      : { stdout: `${VERSION}\n`, code: 0 };
  }

  const { command, flags, arg, operand } = parsed;
  // Started first, so a lookup has the whole command to finish in.
  const check = startUpdateCheck(deps);
  const home = installHome(deps, flags.home);
  let result: Ok | Failure;
  try {
    switch (command) {
      case "doctor": {
        const install = await readInstall(deps, home);
        const ours =
          install !== undefined &&
          install.port === flags.port &&
          (await isHealthy(deps, flags.port));
        result = { ...(await doctorInstall(deps, home, flags.port, ours)) };
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
        };
        result = await commands[command](ctx);
      }
    }
  } catch (err) {
    result = toFailure(err);
  }
  // `init` and `telemetry` settle their own; any other command sends or drops
  // a report left waiting, once someone has answered (perhaps in the web UI).
  if (!["init", "telemetry", "uninstall", "doctor"].includes(command)) {
    await settleWaiting(deps, home, VERSION);
  }
  return answerWithUpdates(result, command, flags.json, check);
}

/**
 * The answer with what the update check knows: `updates` in an answer that
 * carries an install's state, and, for a person, a notice per newer side on
 * stderr. A person may wait a moment for a lookup still running; an agent
 * never does.
 */
async function answerWithUpdates(
  result: Ok | Failure,
  command: string,
  json: boolean,
  check: UpdateCheck | undefined,
): Promise<Answer> {
  if (!check) return render(result, json, command);
  const known = await check.known(json ? 0 : NOTICE_WAIT_MS);
  const runtime = isStatusShaped(result) ? result.version : undefined;
  const updates = updatesField(known, VERSION, runtime);
  const answer = render(
    updates && runtime !== undefined ? { ...result, updates } : result,
    json,
    command,
  );
  const notices = json ? [] : noticeLines(updates, RUNTIME_NOTICE.includes(command));
  return notices.length > 0 ? { ...answer, stderr: `${notices.join("\n")}\n` } : answer;
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

/**
 * The machine's checks, then, for an install on a local model, Ollama's: it
 * answers, has the model, the model calls tools, and its window is the one the
 * runtime budgets against. A failure carries every check run so far.
 */
async function doctorInstall(deps: Deps, home: string, port: number, ours: boolean) {
  const machine = await doctor(deps, port, ours);
  const model = localModelOf((await deps.readText(paths(home).env)) ?? "");
  if (!model) return machine;
  try {
    return { ...machine, checks: [...machine.checks, ...(await checkLocalModel(deps, model))] };
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    const local = (err.detail.checks as unknown[] | undefined) ?? [];
    throw new CliError(err.code, err.message, {
      ...err.detail,
      checks: [...machine.checks, ...local],
    });
  }
}

async function isHealthy(deps: Deps, port: number): Promise<boolean> {
  const res = await deps.getJson(`http://127.0.0.1:${port}/v1/health`);
  return res?.status === 200;
}

function toFailure(err: unknown): Failure {
  if (err instanceof CliError) return failure(err);
  // An unexpected exception is a bug in the CLI, not a state of the machine; it still answers in shape.
  return failure(new CliError("USAGE", err instanceof Error ? err.message : String(err)));
}

function render(result: Ok | Failure, json: boolean, command?: string): Answer {
  const code = exitCodeFor(result);
  if (json) return { stdout: `${JSON.stringify(result)}\n`, code };
  if (!result.ok) return { stdout: `error: ${result.message}\nfix: ${result.fix}\n`, code };
  const lines = isStatus(result) ? statusLines(result, command) : genericLines(result);
  return { stdout: `${lines.join("\n")}\n`, code };
}

type StatusLike = Ok &
  StatusResult & {
    manual?: string;
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
function statusLines(r: StatusLike, command?: string): string[] {
  const lines = [
    ...changeLines(r),
    `  NimbleBrain ${r.version.startsWith("v") ? r.version : `v${r.version}`}: ${r.health === "ok" ? "running" : "stopped"} at ${r.url}`,
    ...r.workspaces.map((w) => `  workspace ${w.name}: ${w.mcp}`),
    r.local_model
      ? `  model: ${r.local_model} on Ollama (NimbleBrain's own agents use it)`
      : `  model key: ${r.model_key === "set" ? "set (NimbleBrain's own agents use it)" : "missing (run npx nimblebrain key)"}`,
  ];
  const agent = r.agent.connected;
  lines.push(...agentLines(r));
  if (!r.host_loopback)
    lines.push("  servers on this machine: not reachable until npx nimblebrain update");
  lines.push(telemetryLine(r.telemetry));
  lines.push(`  CLI ${r.cli_version}`);
  if (command === "init" && !r.already && r.health === "ok") {
    const ask = agent ? `, or ask ${AGENT_NAMES[agent] ?? agent} what NimbleBrain can do` : "";
    lines.push("", `Next: open ${r.url}${ask}. Stop it with npx nimblebrain down.`);
  }
  return lines;
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
export function interrupted(argv: string[], exitCode: number): Answer {
  const err = new CliError(
    "INTERRUPTED",
    `The CLI stopped before it answered (exit code ${exitCode}).`,
    { exit_code: exitCode },
  );
  return render(failure(err), wantsJson(argv));
}
