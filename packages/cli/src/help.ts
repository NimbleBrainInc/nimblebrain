import { ANSWER_FIELDS, type AnswerName } from "./answers.ts";
import {
  COMMAND_SPECS,
  type Command,
  FLAG_SPECS,
  MCP_SUBCOMMANDS,
  type McpSubcommand,
} from "./args.ts";
import { ERRORS, type ErrorCode, exitCodeOf } from "./result.ts";

/**
 * The CLI describing itself, for a person (`--help`) and for an agent
 * (`help --json`), both rendered from the tables the CLI parses and errors
 * with (`COMMAND_SPECS`, `MCP_SUBCOMMANDS`, `FLAG_SPECS`, `ERRORS`), and each
 * command's answer from `ANSWER_FIELDS`, which the type-check holds to the code
 * that builds it. Nothing
 * here is written by hand, so neither help can drift from the CLI that prints it.
 */

export interface CommandHelp {
  name: AnswerName;
  args: string[];
  description: string;
  /** The fields of its `{ok: true}` answer besides `ok`, each with what it carries. */
  answer: Record<string, string>;
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
  description:
    "These commands and flags; with --json, these, each command's answer and every error code as JSON",
  answer: { ...ANSWER_FIELDS.help },
};

/** Every command as a person types it: each `mcp` subcommand is its own entry. */
export function commands(): CommandHelp[] {
  const list = (Object.keys(COMMAND_SPECS) as Command[]).flatMap((name): CommandHelp[] => {
    if (name === "mcp") {
      return (Object.keys(MCP_SUBCOMMANDS) as McpSubcommand[]).map((sub) => {
        const spec = MCP_SUBCOMMANDS[sub];
        return {
          name: `mcp ${sub}`,
          args: spec.operand ? [`<${spec.operand}>`] : [],
          description: spec.description,
          answer: { ...ANSWER_FIELDS[`mcp ${sub}`] },
        };
      });
    }
    const spec = COMMAND_SPECS[name];
    return [
      {
        name,
        args: [...spec.args],
        description: spec.description,
        answer: { ...ANSWER_FIELDS[name] },
      },
    ];
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

/** `help --json`: the commands (with what each answers), flags and error codes this CLI version has. */
export function describe(version: string) {
  return {
    ok: true as const,
    cli_version: version,
    commands: commands(),
    flags: flags(),
    errors: errors(),
  };
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
    "What each command answers, and every error code and its fix: npx nimblebrain help --json",
    "",
  ].join("\n");
}
