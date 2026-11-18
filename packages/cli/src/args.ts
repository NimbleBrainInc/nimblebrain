import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import { CliError } from "./result.ts";

export const COMMANDS = [
  "init",
  "doctor",
  "status",
  "key",
  "up",
  "down",
  "logs",
  "update",
  "uninstall",
  "telemetry",
  "mcp",
  "local-model",
] as const;
export type Command = (typeof COMMANDS)[number];

export const AGENTS = ["claude-code", "cursor", "codex", "none"] as const;
export type Agent = (typeof AGENTS)[number];

export interface Flags {
  json: boolean;
  yes: boolean;
  agent?: Agent;
  port: number;
  home?: string;
  provider?: string;
  /** `--local-model <model>`: run NimbleBrain's agents on this Ollama model instead of a hosted key. */
  localModel?: string;
  runtime?: string;
  /** `--telemetry on|off`: an answer a person already gave. */
  telemetry?: "on" | "off";
  /** `mcp add --name`: the server name to add it under. */
  name?: string;
  /** `mcp --workspace`: the workspace to act in, instead of the one `init` connected. */
  workspace?: string;
}

export type Parsed =
  | { kind: "run"; command: Command; flags: Flags; arg?: string; operand?: string }
  | { kind: "help"; flags: Flags }
  | { kind: "version"; flags: Flags };

export const DEFAULT_PORT = 27246;

const options = {
  json: { type: "boolean" },
  yes: { type: "boolean", short: "y" },
  agent: { type: "string" },
  port: { type: "string" },
  home: { type: "string" },
  provider: { type: "string" },
  "local-model": { type: "string" },
  runtime: { type: "string" },
  telemetry: { type: "string" },
  name: { type: "string" },
  workspace: { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} satisfies ParseArgsOptionsConfig;

/**
 * Bare `nimblebrain` is `init`, so the line on the developers page is the whole
 * setup. Unknown commands and flags are usage errors (exit 2), never ignored:
 * an agent that typos a flag must hear about it rather than get a default.
 */
export function parse(argv: string[]): Parsed {
  const { values, positionals } = parseStrict(argv);

  const json = values.json === true;
  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CliError("USAGE", `--port must be a port number, not "${values.port}".`);
  }
  let agent: Agent | undefined;
  if (values.agent !== undefined) {
    if (!(AGENTS as readonly string[]).includes(values.agent)) {
      throw new CliError("AGENT_UNSUPPORTED", `Unknown agent "${values.agent}".`);
    }
    agent = values.agent as Agent;
  }
  const telemetry = telemetryFlag(values.telemetry);
  const flags: Flags = {
    json,
    yes: values.yes === true,
    agent,
    port,
    home: values.home,
    provider: values.provider,
    localModel: values["local-model"],
    runtime: values.runtime,
    telemetry,
    name: values.name,
    workspace: values.workspace,
  };

  if (values.help) return { kind: "help", flags };
  if (values.version) return { kind: "version", flags };
  const name = positionals[0] ?? "init";
  if (name === "help") return { kind: "help", flags };
  return {
    kind: "run",
    command: command(name, positionals),
    flags,
    arg: positionals[1],
    operand: positionals[2],
  };
}

function telemetryFlag(value: string | undefined): "on" | "off" | undefined {
  if (value === undefined || value === "on" || value === "off") return value;
  throw new CliError("USAGE", `--telemetry must be on or off, not "${value}".`);
}

/** What each `mcp` subcommand takes after it: the URL to add, nothing, or the server to remove. */
export const MCP_SUBCOMMANDS = { add: "url", list: null, remove: "serverName" } as const;
export type McpSubcommand = keyof typeof MCP_SUBCOMMANDS;

/**
 * The command named, checked with its arguments: `telemetry` takes one (on, off
 * or status), `local-model` a model, `mcp` a subcommand and that subcommand's
 * operand; nothing else takes any.
 */
function command(name: string, positionals: string[]): Command {
  if (!(COMMANDS as readonly string[]).includes(name))
    throw new CliError("USAGE", `Unknown command "${name}".`);
  if (name === "mcp") return mcpCommand(positionals);
  const maxArgs = name === "telemetry" || name === "local-model" ? 2 : 1;
  if (positionals.length > maxArgs)
    throw new CliError("USAGE", `Unexpected argument "${positionals[maxArgs]}".`);
  const arg = positionals[1];
  if (name === "telemetry" && arg !== undefined && !["on", "off", "status"].includes(arg))
    throw new CliError("USAGE", `telemetry takes on, off or status, not "${arg}".`);
  return name as Command;
}

function mcpCommand(positionals: string[]): Command {
  const sub = positionals[1];
  if (sub === undefined || !Object.hasOwn(MCP_SUBCOMMANDS, sub))
    throw new CliError(
      "USAGE",
      `mcp takes add <url>, list or remove <serverName>${sub === undefined ? "" : `, not "${sub}"`}.`,
    );
  const operand = MCP_SUBCOMMANDS[sub as McpSubcommand];
  const maxArgs = operand === null ? 2 : 3;
  if (positionals.length > maxArgs)
    throw new CliError("USAGE", `Unexpected argument "${positionals[maxArgs]}".`);
  if (operand !== null && positionals[2] === undefined)
    throw new CliError("USAGE", `mcp ${sub} needs a ${operand}.`);
  return "mcp";
}

function parseStrict(argv: string[]) {
  try {
    return parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (err) {
    throw new CliError("USAGE", err instanceof Error ? err.message : String(err));
  }
}

/** Whether the raw arguments ask for JSON, for reporting a usage error before parsing succeeds. */
export function wantsJson(argv: string[]): boolean {
  return argv.includes("--json");
}
