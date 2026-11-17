import pkg from "../package.json" with { type: "json" };
import { type Parsed, parse, wantsJson } from "./args.ts";
import { type Deps, installHome } from "./deps.ts";
import { doctor } from "./doctor.ts";
import { down, init, key, logs, uninstall, up, update } from "./lifecycle.ts";
import { CliError, exitCodeFor, type Failure, failure, type Ok } from "./result.ts";
import { readInstall, status } from "./status.ts";

export const VERSION: string = pkg.version;

const HELP = `nimblebrain ${VERSION}: install and run NimbleBrain on this machine

Usage: npx nimblebrain [command] [flags]

Commands:
  init        Check this machine, start NimbleBrain, connect your coding agent (default)
  doctor      Check Docker, Compose, architecture, memory and the port; installs nothing
  status      Version, health, URL and each workspace's MCP URL
  key         Enter the model key at a hidden prompt
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

  const { command, flags } = parsed;
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
        const ctx = { deps, flags, home, version: VERSION };
        const commands = { init, up, down, logs, update, uninstall, key };
        result = await commands[command](ctx);
      }
    }
  } catch (err) {
    result = toFailure(err);
  }
  return render(result, flags.json);
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

function render(result: Ok | Failure, json: boolean): { stdout: string; code: number } {
  const code = exitCodeFor(result);
  if (json) return { stdout: `${JSON.stringify(result)}\n`, code };
  if (!result.ok) return { stdout: `error: ${result.message}\nfix: ${result.fix}\n`, code };
  return { stdout: human(result), code };
}

/** The same fields as the JSON, as lines a person reads. */
function human(result: Ok): string {
  const lines = Object.entries(result)
    .filter(([key]) => key !== "ok")
    .flatMap(([key, value]) => field(key, value));
  return `${lines.join("\n")}\n`;
}

function field(key: string, value: unknown): string[] {
  if (key === "checks" && Array.isArray(value)) {
    return (value as Array<{ check: string; ok: boolean; detail: string }>).map(
      (c) => `  ${c.ok ? "✓" : "✗"} ${c.check}: ${c.detail}`,
    );
  }
  if (key === "workspaces" && Array.isArray(value)) {
    return (value as Array<{ name: string; mcp: string }>).map(
      (w) => `  workspace ${w.name}: ${w.mcp}`,
    );
  }
  const text = typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
  return [`  ${key}: ${text}`];
}
