import { type Parsed, parse, wantsJson } from "./args.ts";
import { type Deps, installHome } from "./deps.ts";
import { doctor } from "./doctor.ts";
import { down, init, key, logs, telemetry, uninstall, up, update } from "./lifecycle.ts";
import { CliError, exitCodeFor, type Failure, failure, type Ok } from "./result.ts";
import { readInstall, type StatusResult, status } from "./status.ts";
import { settleWaiting } from "./telemetry.ts";

import { VERSION } from "./version.ts";

export { VERSION };

const HELP = `nimblebrain ${VERSION}: install and run NimbleBrain on this machine

Usage: npx nimblebrain [command] [flags]

Commands:
  init        Check this machine, start NimbleBrain, connect your coding agent (default)
  doctor      Check Docker, Compose, architecture, memory and the port; installs nothing
  status      Version, health, URL and each workspace's MCP URL
  key         Enter the model key at a hidden prompt
  telemetry   [on|off|status] Whether this install sends anonymous usage data
  up, down    Start or stop NimbleBrain; data survives down
  logs        Recent runtime log lines
  update      Move to the newest release, keeping data
  uninstall   Remove NimbleBrain and its data

Flags:
  --json            One JSON object on stdout
  --yes, -y         Take every default; implied when no terminal is attached
  --agent <name>    claude-code, cursor, codex or none
  --port <n>        Local port (default 27246)
  --home <dir>      Where the install lives (default ~/.nimblebrain-local, or NIMBLEBRAIN_HOME)
  --provider <name> The model provider for key (default anthropic)
  --runtime <tag>   The NimbleBrain release to install or update to (default the newest)
  --telemetry <on|off>  The person's answer to sending anonymous usage data; without it, init asks or leaves it undecided
  --help, --version
`;

/** Runs one invocation and returns what to print and the exit code. Never throws. */
export async function run(argv: string[], deps: Deps): Promise<{ stdout: string; code: number }> {
  const json = wantsJson(argv);
  let parsed: Parsed;
  try {
    parsed = parse(argv);
  } catch (err) {
    return render(toFailure(err), json);
  }

  if (parsed.kind === "help") return { stdout: HELP, code: 0 };
  if (parsed.kind === "version") {
    return parsed.flags.json
      ? render({ ok: true, version: VERSION }, true)
      : { stdout: `${VERSION}\n`, code: 0 };
  }

  const { command, flags, arg } = parsed;
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
        result = { ...(await doctor(deps, flags.port, ours)) };
        break;
      }
      case "status":
        result = { ...(await status(deps, home)) };
        break;
      default: {
        const ctx = { deps, flags, home, version: VERSION, arg };
        const commands = { init, up, down, logs, update, uninstall, key, telemetry };
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
  return render(result, flags.json, command);
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

function render(
  result: Ok | Failure,
  json: boolean,
  command?: string,
): { stdout: string; code: number } {
  const code = exitCodeFor(result);
  if (json) return { stdout: `${JSON.stringify(result)}\n`, code };
  if (!result.ok) return { stdout: `error: ${result.message}\nfix: ${result.fix}\n`, code };
  const lines = isStatus(result) ? statusLines(result, command) : genericLines(result);
  return { stdout: `${lines.join("\n")}\n`, code };
}

type StatusLike = Ok & StatusResult & { manual?: string; already?: boolean };

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
    `  NimbleBrain ${r.version.startsWith("v") ? r.version : `v${r.version}`}: ${r.health === "ok" ? "running" : "stopped"} at ${r.url}`,
    ...r.workspaces.map((w) => `  workspace ${w.name}: ${w.mcp}`),
    `  model key: ${r.model_key === "set" ? "set (NimbleBrain's own agents use it)" : "missing (run npx nimblebrain key)"}`,
  ];
  const agent = r.agent.connected;
  if (agent) {
    const name = AGENT_NAMES[agent] ?? agent;
    lines.push(
      `  ${name} can use NimbleBrain's tools (it loads them when its next session starts)`,
    );
    if (!r.agent.skill)
      lines.push(
        `  skill: not installed; add it with npx skills add nimblebraininc/skills --skill nimblebrain`,
      );
  } else if (r.manual) {
    lines.push(`  agent: not connected; add it by hand: ${r.manual}`);
  }
  lines.push(`  telemetry: ${r.telemetry.state}`);
  lines.push(`  CLI ${r.cli_version}`);
  if (command === "init" && !r.already && r.health === "ok") {
    const ask = agent ? `, or ask ${AGENT_NAMES[agent] ?? agent} what NimbleBrain can do` : "";
    lines.push("", `Next: open ${r.url}${ask}. Stop it with npx nimblebrain down.`);
  }
  return lines;
}

/** Any other answer: its fields as lines, nested values flattened, nothing empty. */
function genericLines(result: Ok): string[] {
  return Object.entries(result)
    .filter(([key]) => key !== "ok")
    .flatMap(([key, value]) => field(key, value));
}

function field(key: string, value: unknown): string[] {
  if (value === undefined || value === null) return [];
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
  return [`  ${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`];
}

/**
 * What to print when the process is ending without having answered: a broken
 * promise of "one JSON object for every run" would leave an agent with nothing
 * to act on. `exitCode` is the code the process was about to end with.
 */
export function interrupted(argv: string[], exitCode: number): { stdout: string; code: number } {
  const err = new CliError(
    "INTERRUPTED",
    `The CLI stopped before it answered (exit code ${exitCode}).`,
    { exit_code: exitCode },
  );
  return render(failure(err), wantsJson(argv));
}
