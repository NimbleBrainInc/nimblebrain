import { COMMAND_SPECS, type Command, FLAG_SPECS, MCP_SUBCOMMANDS } from "./args.ts";
import { ERRORS, type ErrorCode, exitCodeOf, type Ok } from "./result.ts";

/**
 * The CLI describing itself, for a person (`--help`) and for an agent
 * (`help --json`), both rendered from the tables the CLI parses and errors
 * with (`COMMAND_SPECS`, `MCP_SUBCOMMANDS`, `FLAG_SPECS`, `ERRORS`). Nothing
 * here is written by hand, so neither help can drift from the CLI that prints it.
 */

export interface CommandHelp {
  name: string;
  args: string[];
  description: string;
}

export interface FlagHelp {
  name: string;
  short?: string;
  /** What the flag's value is, or null for a flag that takes none. */
  takes: string | null;
  description: string;
  /** The commands it applies to; absent, every command. */
  commands?: string[];
}

export interface ErrorHelp {
  code: ErrorCode;
  fix: string;
  exit: 1 | 2;
}

/** `help` itself, which the parser takes as a request for help rather than a command. */
const HELP_COMMAND: CommandHelp = {
  name: "help",
  args: [],
  description: "These commands and flags; with --json, these and every error code as JSON",
};

/** Every command as a person types it: each `mcp` subcommand is its own entry. */
export function commands(): CommandHelp[] {
  const list = (Object.keys(COMMAND_SPECS) as Command[]).flatMap((name): CommandHelp[] => {
    if (name === "mcp") {
      return Object.entries(MCP_SUBCOMMANDS).map(([sub, spec]) => ({
        name: `mcp ${sub}`,
        args: spec.operand ? [`<${spec.operand}>`] : [],
        description: spec.description,
      }));
    }
    const spec = COMMAND_SPECS[name];
    return [{ name, args: [...spec.args], description: spec.description }];
  });
  return [...list, HELP_COMMAND];
}

export function flags(): FlagHelp[] {
  return Object.entries(FLAG_SPECS).map(([name, spec]) => {
    const f: FlagHelp = {
      name: `--${name}`,
      takes: "takes" in spec ? spec.takes : null,
      description: spec.description,
    };
    if ("short" in spec) f.short = `-${spec.short}`;
    if ("commands" in spec) f.commands = [...spec.commands];
    return f;
  });
}

export function errors(): ErrorHelp[] {
  return (Object.keys(ERRORS) as ErrorCode[]).map((code) => ({
    code,
    fix: ERRORS[code],
    exit: exitCodeOf(code),
  }));
}

/** `help --json`: the commands, flags and error codes this CLI version has. */
export function describe(version: string): Ok {
  return { ok: true, cli_version: version, commands: commands(), flags: flags(), errors: errors() };
}

/** `--help`: the same commands and flags as lines. */
export function helpText(version: string): string {
  const cmds = commands().map((c) => [[c.name, ...c.args].join(" "), c.description] as const);
  const fls = flags().map(
    (f) =>
      [
        [f.takes ? `${f.name} <${f.takes}>` : f.name, f.short].filter(Boolean).join(", "),
        f.commands ? `${f.description}; for ${f.commands.join(", ")}` : f.description,
      ] as const,
  );
  const width = Math.max(...[...cmds, ...fls].map(([left]) => left.length)) + 2;
  const row = ([left, right]: readonly [string, string]) => `  ${left.padEnd(width)}${right}`;
  return [
    `nimblebrain ${version}: install and run NimbleBrain on this machine`,
    "",
    "Usage: npx nimblebrain [command] [flags]",
    "",
    "Commands:",
    ...cmds.map(row),
    "",
    "Flags:",
    ...fls.map(row),
    "",
    "Every error code and its fix: npx nimblebrain help --json",
    "",
  ].join("\n");
}
