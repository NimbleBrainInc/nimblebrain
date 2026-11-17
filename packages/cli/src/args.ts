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
}

export type Parsed =
  | { kind: "run"; command: Command; flags: Flags }
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
  const flags: Flags = {
    json,
    yes: values.yes === true,
    agent,
    port,
    home: values.home,
    provider: values.provider,
  };

  if (values.help) return { kind: "help", flags };
  if (values.version) return { kind: "version", flags };
  if (positionals.length > 1)
    throw new CliError("USAGE", `Unexpected argument "${positionals[1]}".`);

  const name = positionals[0] ?? "init";
  if (name === "help") return { kind: "help", flags };
  if (!(COMMANDS as readonly string[]).includes(name))
    throw new CliError("USAGE", `Unknown command "${name}".`);
  return { kind: "run", command: name as Command, flags };
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
