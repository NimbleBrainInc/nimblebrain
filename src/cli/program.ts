import { Command } from "commander";
import type { TelemetryManager } from "../telemetry/manager.ts";

/**
 * Build a dotted command path by walking the parent chain.
 * e.g., for `nb bundle add` → "bundle.add"
 */
export function buildCommandPath(cmd: Command): string {
  const parts: string[] = [];
  let current: Command | null = cmd;
  while (current) {
    const name = current.name();
    if (name && name !== "nb") {
      parts.unshift(name);
    }
    current = current.parent;
  }
  return parts.join(".") || "root";
}

/**
 * Extract flag names that were actually set on a command.
 * Returns names only — never values (PII safety for telemetry).
 */
export function extractFlagNames(cmd: Command): string[] {
  const flags: string[] = [];
  const opts = cmd.opts();
  for (const key of Object.keys(opts)) {
    if (opts[key] !== undefined && opts[key] !== false) {
      flags.push(key);
    }
  }
  // Also check parent options
  if (cmd.parent) {
    const parentOpts = cmd.parent.opts();
    for (const key of Object.keys(parentOpts)) {
      if (parentOpts[key] !== undefined && parentOpts[key] !== false) {
        flags.push(key);
      }
    }
  }
  return flags;
}

/**
 * Determine the telemetry mode from raw argv (before Commander parses).
 * Must match the current behavior in index.ts:81-84.
 */
export function determineModeFromArgv(): "serve" | "dev" | "subcommand" | "headless" | "tui" {
  const subcommand = process.argv[2];
  if (subcommand === "serve") return "serve";
  if (subcommand === "dev") return "dev";
  if (subcommand && !subcommand.startsWith("-")) return "subcommand";
  return process.stdin.isTTY ? "tui" : "headless";
}

/**
 * Create the root Commander program with global options, output config,
 * exit override, and telemetry preAction hook.
 */
export function createProgram(telemetry: TelemetryManager): Command {
  const program = new Command("nb")
    .description("NimbleBrain CLI")
    .version("0.1.0")
    .option("-c, --config <path>", "config file path")
    .option("--model <id>", "override default model")
    .option("--workdir <path>", "data directory")
    .option("--debug", "verbose logging")
    .option("--json", "structured output")
    .exitOverride()
    .configureOutput({
      writeOut: (str) => process.stdout.write(str),
      writeErr: (str) => process.stderr.write(str),
    })
    .showHelpAfterError(true);

  program.hook("preAction", (thisCommand) => {
    const commandPath = buildCommandPath(thisCommand);
    const mode = determineModeFromArgv();
    const flags = extractFlagNames(thisCommand);

    telemetry.capture("cli.command", {
      command: commandPath,
      mode,
      flags,
    });
  });

  return program;
}
