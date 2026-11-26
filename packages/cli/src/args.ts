import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import { DEFAULT_LOCAL_MODEL } from "./local-model.ts";
import { CliError } from "./result.ts";
import { MODEL_ID } from "./subscription/command.ts";

/**
 * Every command, what it takes after it, and what it does: the one table the
 * parser checks against and both helps (`--help`, `help --json`) are rendered
 * from, so a command cannot exist without being described. `mcp` takes a
 * subcommand, described in `MCP_SUBCOMMANDS`.
 */
export const COMMAND_SPECS = {
  init: {
    args: [],
    description: "Check this machine, start NimbleBrain, connect your coding agent (default)",
  },
  doctor: {
    args: [],
    description: "Check Docker, Compose, architecture, memory and the port; installs nothing",
  },
  status: { args: [], description: "Version, health, URL and each workspace's MCP URL" },
  open: { args: [], description: "Open NimbleBrain's web UI in the default browser" },
  key: { args: [], description: "Enter the model key at a hidden prompt" },
  "local-model": {
    args: ["[model]"],
    description: `Prepare a model served by Ollama for NimbleBrain's agents (default ${DEFAULT_LOCAL_MODEL})`,
  },
  use: {
    args: ["[claude|codex|api|local]", "[model]"],
    description:
      "Choose what runs NimbleBrain's agents: claude (your Claude subscription), codex (your ChatGPT plan), api (an API key) or local (an Ollama model); asks when none is named",
  },
  telemetry: {
    args: ["[on|off|status]"],
    description: "Whether this install sends anonymous usage data",
  },
  up: { args: [], description: "Start NimbleBrain" },
  down: { args: [], description: "Stop NimbleBrain; data survives down" },
  logs: { args: [], description: "Recent runtime log lines" },
  update: {
    args: [],
    description:
      "Move to the newest release, keeping data, and refresh the connected agent's nimblebrain skill",
  },
  uninstall: { args: [], description: "Remove NimbleBrain and its data" },
  mcp: {
    args: ["<add|list|remove>"],
    description: "MCP servers in development; see mcp add, list and remove",
  },
} as const satisfies Record<string, { args: readonly string[]; description: string }>;
export type Command = keyof typeof COMMAND_SPECS;
export const COMMANDS = Object.keys(COMMAND_SPECS) as Command[];

/** What `telemetry` takes: an answer, or `status` to read it. */
const TELEMETRY_ARGS = ["on", "off", "status"];

export const AGENTS = ["claude-code", "cursor", "codex", "none"] as const;

/**
 * What runs NimbleBrain's agents, the one question `init` asks and `use`
 * answers afterwards: the person's Claude subscription through Claude Code,
 * their ChatGPT plan through Codex, an API key, or a local model through Ollama.
 */
export const SOURCES = ["claude", "codex", "api", "local"] as const;
export type Source = (typeof SOURCES)[number];

/** `claude, codex, api or local`, for messages. */
export const SOURCE_LIST = `${SOURCES.slice(0, -1).join(", ")} or ${SOURCES.at(-1)}`;
export type Agent = (typeof AGENTS)[number];

export interface Flags {
  json: boolean;
  yes: boolean;
  agent?: Agent;
  /** `--port` as passed; each command that takes it supplies its own default. */
  port?: number;
  home?: string;
  provider?: string;
  /** `--local-model <model>`: run NimbleBrain's agents on this Ollama model instead of a hosted key. */
  localModel?: string;
  /** `--use <source>`: what `init` runs NimbleBrain's agents on, without asking. */
  use?: Source;
  /** `--model <id>`: the model a subscription's turns run on (`use claude|codex`, `init --use claude|codex`). */
  model?: string;
  runtime?: string;
  /** `--telemetry on|off`: an answer a person already gave. */
  telemetry?: "on" | "off";
  /** `--no-open`: `init` leaves the browser closed at the end. */
  noOpen: boolean;
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

interface FlagSpec {
  type: "boolean" | "string";
  short?: string;
  /** What a string flag's value is, as help shows it: `--port <n>`. */
  takes?: string;
  description: string;
  /** The commands it applies to, as `help --json` names them; absent, every command. */
  commands?: readonly string[];
}

/**
 * Every flag, what it takes and what it does: the one table `parseArgs` is
 * given and both helps are rendered from.
 */
export const FLAG_SPECS = {
  json: {
    type: "boolean",
    description: "One JSON object on stdout; progress and notices go to stderr",
  },
  yes: {
    type: "boolean",
    short: "y",
    description: "Take every default; implied when no terminal is attached",
  },
  agent: {
    type: "string",
    takes: "name",
    description: `The coding agent to connect: ${AGENTS.slice(0, -1).join(", ")} or ${AGENTS.at(-1)}`,
    commands: ["init"],
  },
  port: {
    type: "string",
    takes: "n",
    description: `Local port (default ${DEFAULT_PORT}, or on a new install the next free port 100 on when that one is in use; for doctor, the install's own port; for use, the agent worker's, default 27290 for claude and 27291 for codex, moved the same way). A port given here is never moved: in use, it is PORT_IN_USE`,
    commands: ["init", "doctor", "use"],
  },
  home: {
    type: "string",
    takes: "dir",
    description:
      "Where the install lives (default ~/.nimblebrain-local, or NIMBLEBRAIN_HOME); each home is a separate install",
  },
  provider: {
    type: "string",
    takes: "name",
    description:
      "The model provider for key (default anthropic); the installed release decides which it takes, and key lists them",
    commands: ["key"],
  },
  use: {
    type: "string",
    takes: SOURCES.join("|"),
    description:
      "What runs NimbleBrain's agents, as use takes it; without it (or --local-model), init asks a person, or leaves it unchosen and returns the question in model_source.ask",
    commands: ["init"],
  },
  model: {
    type: "string",
    takes: "id",
    description:
      "The model your subscription's turns run on, for use claude|codex and init --use claude|codex: for claude sonnet (default), opus, haiku or a full model id; for codex a model your plan offers (default Codex's own)",
    commands: ["init", "use"],
  },
  "local-model": {
    type: "string",
    takes: "model",
    description: "Run on this Ollama model (implies --use local)",
    commands: ["init"],
  },
  runtime: {
    type: "string",
    takes: "tag",
    description: "The NimbleBrain release to install or update to (default the newest)",
    commands: ["init", "update"],
  },
  "no-open": {
    type: "boolean",
    description: "Do not open the web UI in the browser when init finishes",
    commands: ["init"],
  },
  telemetry: {
    type: "string",
    takes: "on|off",
    description:
      "The person's answer to sending anonymous usage data; without it, init asks or leaves it undecided",
    commands: ["init"],
  },
  name: {
    type: "string",
    takes: "name",
    description: "The server name (default from the server's card, else its URL)",
    commands: ["mcp add"],
  },
  workspace: {
    type: "string",
    takes: "id",
    description: "The workspace (default the one init connected, the first in status)",
    commands: ["mcp add", "mcp list", "mcp remove"],
  },
  help: {
    type: "boolean",
    short: "h",
    description:
      "The commands and flags; with --json, these, each command's answer and every error code as JSON",
  },
  version: { type: "boolean", short: "v", description: "This CLI's version" },
} as const satisfies Record<string, FlagSpec>;

/** `FLAG_SPECS` as `parseArgs` takes it, keeping each flag's type so the parsed values stay typed. */
const options = Object.fromEntries(
  Object.entries(FLAG_SPECS as Record<string, FlagSpec>).map(([name, f]) => [
    name,
    f.short ? { type: f.type, short: f.short } : { type: f.type },
  ]),
) as {
  [K in keyof typeof FLAG_SPECS]: Pick<(typeof FLAG_SPECS)[K], "type"> & { short?: string };
} satisfies ParseArgsOptionsConfig;

/**
 * Bare `nimblebrain` is `init`, so the line on the developers page is the whole
 * setup. Unknown commands and flags are usage errors (exit 2), never ignored:
 * an agent that typos a flag must hear about it rather than get a default.
 */
export function parse(argv: string[]): Parsed {
  const { values, positionals } = parseStrict(argv);

  const json = values.json === true;
  const port = values.port === undefined ? undefined : Number(values.port);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
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
  const use = useFlag(values.use, values["local-model"]);
  const flags: Flags = {
    json,
    yes: values.yes === true,
    agent,
    port,
    home: values.home,
    provider: values.provider,
    localModel: values["local-model"],
    use,
    model: modelFlag(values.model),
    runtime: values.runtime,
    telemetry,
    noOpen: values["no-open"] === true,
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

/** `--use`, checked; `--local-model` means local, so it takes no other. */
function useFlag(value: string | undefined, localModel: string | undefined): Source | undefined {
  if (value === undefined) return localModel === undefined ? undefined : "local";
  if (!(SOURCES as readonly string[]).includes(value))
    throw new CliError("USAGE", `--use must be ${SOURCE_LIST}, not "${value}".`);
  if (localModel !== undefined && value !== "local")
    throw new CliError(
      "USAGE",
      `--local-model runs on a local model, so it takes --use local, not "${value}".`,
    );
  return value as Source;
}

/** `--model`, checked for shape only: the vendor CLI says whether the plan offers it. */
function modelFlag(value: string | undefined): string | undefined {
  if (value === undefined || MODEL_ID.test(value)) return value;
  throw new CliError(
    "USAGE",
    `--model takes a model name such as sonnet, opus or haiku, or a full model id, not "${value}".`,
  );
}

function telemetryFlag(value: string | undefined): "on" | "off" | undefined {
  if (value === undefined || value === "on" || value === "off") return value;
  throw new CliError("USAGE", `--telemetry must be on or off, not "${value}".`);
}

/**
 * Each `mcp` subcommand: what it takes after it (the URL to add, nothing, or
 * the server to remove) and what it does.
 */
export const MCP_SUBCOMMANDS = {
  add: { operand: "url", description: "Add an MCP server you run on this machine to a workspace" },
  list: { operand: null, description: "The servers in a workspace" },
  remove: { operand: "serverName", description: "Remove a server from a workspace" },
} as const;
export type McpSubcommand = keyof typeof MCP_SUBCOMMANDS;

/**
 * The command named, checked with its arguments: `telemetry` takes one (on, off
 * or status), `local-model` a model, `use` a source and, for local, a model
 * (checked by `use`), `mcp` a subcommand and that subcommand's operand;
 * nothing else takes any.
 */
function command(name: string, positionals: string[]): Command {
  if (!(COMMANDS as readonly string[]).includes(name))
    throw new CliError("USAGE", `Unknown command "${name}".`);
  if (name === "mcp") return mcpCommand(positionals);
  const maxArgs = name === "use" ? 3 : name === "telemetry" || name === "local-model" ? 2 : 1;
  if (positionals.length > maxArgs)
    throw new CliError("USAGE", `Unexpected argument "${positionals[maxArgs]}".`);
  const arg = positionals[1];
  if (name === "telemetry" && arg !== undefined && !TELEMETRY_ARGS.includes(arg))
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
  const { operand } = MCP_SUBCOMMANDS[sub as McpSubcommand];
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
